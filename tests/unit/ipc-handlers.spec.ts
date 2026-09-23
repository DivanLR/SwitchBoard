import type { PtyHost } from '@main/terminal/pty-host'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARCHIFY } from '@shared/diagram'
import type { IpcError, WireResult } from '@shared/ipc-types'
import { INVOKE_CHANNEL, isIpcErrorCode } from '@shared/ipc-types'

const registered = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      registered.set(channel, listener)
    },
  },
  app: { getPath: () => 'C:\\tmp', isPackaged: false },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class {},
}))

vi.mock('@main/updater', () => ({
  initUpdater: () => {},
  check: async () => 'idle',
  installNow: async () => {},
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')
const { PermissionBroker } = await import('@main/inbox/permission-broker')
const { registerIpcHandlers } = await import('@main/ipc/handlers')

function fakeWindow() {
  const mainFrame = { name: 'main' }
  return { webContents: { id: 7, mainFrame } }
}

function setup() {
  registered.clear()
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const broker = new PermissionBroker(repos, manager, {
    onInboxChanged: () => {},
    onCountersChanged: () => {},
    onNeedsYou: () => {},
  })
  const window = fakeWindow()
  registerIpcHandlers({
    repos,
    manager,
    broker,
    getWindow: () => window as never,
    dbProjectId: 'db-project',
    skillsStagingRoot: join(tmpdir(), 'switchboard-test-skills'),
    flow: { reconcileOnStartup: () => {} } as never,
    ptyHost: { open: () => ({ scrollback: '', reused: false }), write: () => {}, resize: () => {}, close: () => {}, closeAll: () => {} } as unknown as PtyHost,
  })

  const listener = registered.get(INVOKE_CHANNEL)
  if (!listener) throw new Error(`nothing registered on ${INVOKE_CHANNEL}`)

  const trustedEvent = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }

  const call = (method: string, req?: unknown, event: unknown = trustedEvent) =>
    listener(event, method, req) as Promise<WireResult<unknown>>

  return { repos, manager, call, window, trustedEvent }
}

describe('the invoke channel', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('registers exactly one handler, on the shared channel constant', () => {
    expect([...registered.keys()]).toEqual([INVOKE_CHANNEL])
  })

  it('wraps a successful call in an ok envelope', async () => {
    const result = await harness.call('projects.list', undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ projects: [], counters: expect.any(Object) })
  })

  it('lists an archived project under archived until it is restored', async () => {
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    await harness.call('projects.archive', { projectId: project.id })
    let listed = await harness.call('projects.list', undefined)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.value).toMatchObject({ projects: [], archived: [{ id: project.id }] })

    await harness.call('projects.unarchive', { projectId: project.id })
    listed = await harness.call('projects.list', undefined)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.value).toMatchObject({ projects: [{ id: project.id }], archived: [] })
  })

  it('deletes a project only once none of its sessions is live', async () => {
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    harness.repos.sessions.insert({
      id: 'live',
      projectId: project.id,
      sdkSessionId: null,
      status: 'working',
      statusDetail: null,
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: null,
      endReason: null,
    })
    const refused = await harness.call('projects.delete', { projectId: project.id })
    expect(refused).toMatchObject({ ok: false, error: { code: 'ALREADY_ACTIVE' } })
    expect(harness.repos.projects.byId(project.id)).toBeDefined()

    harness.repos.sessions.reconcileAllEnded('stopped')
    expect(await harness.call('projects.delete', { projectId: project.id })).toEqual({ ok: true, value: null })
    expect(harness.repos.projects.byId(project.id)).toBeUndefined()
    expect(harness.repos.sessions.byId('live')).toBeUndefined()
  })

  it('returns null rather than undefined for a void handler', async () => {
    const project = harness.repos.projects.insert({
      name: 'a',
      path: 'C:\\a',
      source: 'manual',
    })
    const result = await harness.call('projects.rename', { projectId: project.id, name: 'b' })
    expect(result).toEqual({ ok: true, value: null })
  })

  it('maps a thrown IpcError to its own code, not INTERNAL', async () => {
    const result = await harness.call('projects.rename', { projectId: 'nope', name: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('maps an unexpected throw to INTERNAL and keeps the message', async () => {
    const result = await harness.call('projects.rename', null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL')
    expect(result.error.message).toBeTruthy()
  })

  it('rejects an unknown method with NOT_FOUND instead of throwing', async () => {
    const result = await harness.call('does.not.exist', {})
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Unknown method does.not.exist' },
    } satisfies WireResult<never>)
  })
})

describe('isIpcErrorCode', () => {
  it('accepts every real code', () => {
    for (const code of [
      'NOT_FOUND',
      'ALREADY_ACTIVE',
      'SESSION_ENDED',
      'CONFIRM_REQUIRED',
      'RULE_NOT_ALLOWED',
      'INVALID_PATH',
      'DUPLICATE',
      'INTERNAL',
    ]) {
      expect(isIpcErrorCode(code)).toBe(true)
    }
  })

  it('rejects a code that is not in the union', () => {
    expect(isIpcErrorCode('NOT_FOND')).toBe(false)
    expect(isIpcErrorCode('')).toBe(false)
  })

  it('rejects inherited object keys, which is why it uses Object.hasOwn', () => {
    expect(isIpcErrorCode('toString')).toBe(false)
    expect(isIpcErrorCode('constructor')).toBe(false)
    expect(isIpcErrorCode('hasOwnProperty')).toBe(false)
  })

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 7, {}, ['NOT_FOUND']]) {
      expect(isIpcErrorCode(value)).toBe(false)
    }
  })
})

describe('the sender-trust check', () => {
  const untrusted = (error: IpcError): boolean =>
    error.code === 'INTERNAL' && error.message === 'Untrusted IPC sender'

  it('rejects another webContents', async () => {
    const { call, window } = setup()
    const result = await call('projects.list', undefined, {
      sender: { id: 99 },
      senderFrame: window.webContents.mainFrame,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })

  it('rejects a subframe of the trusted window', async () => {
    const { call } = setup()
    const result = await call('projects.list', undefined, {
      sender: { id: 7 },
      senderFrame: { name: 'child-iframe' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })

  it('rejects a disposed frame, failing closed', async () => {
    const { call } = setup()
    const result = await call('projects.list', undefined, { sender: { id: 7 }, senderFrame: null })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })

  it('rejects everything when there is no window at all', async () => {
    registered.clear()
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const manager = new SessionManager(repos, {
      onEvent: () => {},
      onSessionStatus: () => {},
      onCountersChanged: () => {},
      onSessionExit: () => {},
      onQueueChanged: () => {},
      onVerifyChanged: () => {},
      onDiagramsChanged: () => {},
      onProjectCommands: () => {},
      gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    })
    const broker = new PermissionBroker(repos, manager, {
      onInboxChanged: () => {},
      onCountersChanged: () => {},
      onNeedsYou: () => {},
    })
    registerIpcHandlers({
      repos,
      manager,
      broker,
      getWindow: () => null,
      dbProjectId: 'db-project',
      skillsStagingRoot: join(tmpdir(), 'switchboard-test-skills'),
      flow: { reconcileOnStartup: () => {} } as never,
      ptyHost: { open: () => ({ scrollback: '', reused: false }), write: () => {}, resize: () => {}, close: () => {}, closeAll: () => {} } as unknown as PtyHost,
    })
    const listener = registered.get(INVOKE_CHANNEL)!
    const result = (await listener(
      { sender: { id: 7 }, senderFrame: { name: 'main' } },
      'projects.list',
      undefined,
    )) as WireResult<unknown>
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })
})

describe('diagrams.generate chooses its engine from the request', () => {
  let harness: ReturnType<typeof setup>
  let sent: string[]

  beforeEach(() => {
    harness = setup()
    sent = []
    vi.spyOn(harness.manager, 'diagramSessionFor').mockResolvedValue({
      id: 's-diagram',
    } as never)
    vi.spyOn(harness.manager, 'watchDiagram').mockImplementation(() => {})
    vi.spyOn(harness.manager, 'sendMessage').mockImplementation((_id, text) => {
      sent.push(text)
      return { eventId: 'e-1', queued: false }
    })
  })

  const project = () =>
    harness.repos.projects.insert({ name: 'a', path: join(tmpdir(), 'swb-diagrams'), source: 'manual' })

  it('asks the diagram-design plugin when no archify options ride along', async () => {
    const result = await harness.call('diagrams.generate', {
      projectId: project().id,
      description: 'the auth flow',
    })
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Use the default editorial skin')
    expect(sent[0]).not.toContain('archify')
  })

  it('asks archify, with the chosen type and quality, when they do', async () => {
    const result = await harness.call('diagrams.generate', {
      projectId: project().id,
      description: 'the auth flow',
      archify: { type: 'sequence', quality: 'standard', motion: true },
    })
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('archify skill')
    expect(sent[0]).toContain('Use the sequence type')
    expect(sent[0]).toContain('--quality standard')
    expect(sent[0]).toContain('meta.animation to "trace"')
    expect(sent[0]).toContain('NEVER run `archify preview`')
    expect(sent[0]).not.toContain('Use the default editorial skin')
  })

  it('records the request against the file either engine will write', async () => {
    const id = project().id
    const result = await harness.call('diagrams.generate', {
      projectId: id,
      description: 'the auth flow',
      archify: { type: 'architecture', quality: 'showcase', motion: false },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { file } = result.value as { file: string }
    expect(file).toBe('the-auth-flow.html')
    expect([...harness.repos.diagramRequests.forProject(id).keys()]).toContain(file)
  })
})

describe('importing and managing a person’s own skills', () => {
  const SOURCE = 'https://github.com/someone/skills/tree/main/skills'
  let home: string
  const previousProfile = process.env.USERPROFILE
  const previousHome = process.env.HOME

  const live = (name: string) => join(home, '.claude', 'skills', name, 'SKILL.md')
  const exists = (path: string) => stat(path).then(
    () => true,
    () => false,
  )
  const names = async (call: ReturnType<typeof setup>['call']) => {
    const result = (await call('skills.list')) as WireResult<{ name: string; enabled: boolean }[]>
    if (!result.ok) throw new Error('skills.list failed')
    return result.value.map((skill) => `${skill.name}:${skill.enabled ? 'on' : 'off'}`)
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sb-home-'))
    process.env.USERPROFILE = home
    process.env.HOME = home
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://api.github.com/')) {
        return new Response(
          JSON.stringify({
            tree: ['archify', 'skills/code-review', 'skills/write-tests'].map((dir) => ({
              path: `${dir}/SKILL.md`,
              type: 'blob',
              size: 64,
            })),
          }),
        )
      }
      const name = url.split('/').at(-2)
      return new Response(`---\nname: ${name}\ndescription: The ${name} skill.\n---\n`)
    })
  })

  afterEach(async () => {
    process.env.USERPROFILE = previousProfile
    process.env.HOME = previousHome
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })

  it('imports every skill under any GitHub folder, records where each came from, and switches it on', async () => {
    const { call } = setup()
    const result = await call('skills.import', { url: SOURCE })
    expect(result).toMatchObject({
      ok: true,
      value: { imported: [{ name: 'code-review' }, { name: 'write-tests' }], skipped: [] },
    })
    expect(await call('skills.list')).toMatchObject({
      ok: true,
      value: [
        { name: 'code-review', sourceUrl: SOURCE, sourcePath: 'skills/code-review', enabled: true, fileCount: 1 },
        { name: 'write-tests', sourceUrl: SOURCE, enabled: true },
      ],
    })
    expect(await exists(live('code-review'))).toBe(true)

    const again = await call('skills.import', { url: SOURCE })
    expect(again).toMatchObject({ ok: false, error: { code: 'INVALID_PATH' } })
  })

  it('refuses a source that is not a GitHub URL before asking anything', async () => {
    const { call } = setup()
    const result = await call('skills.import', { url: 'https://gitlab.com/someone/skills' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PATH' } })
    expect(await names(call)).toEqual([])
  })

  it('switching a skill off removes its live folder, and on copies it back', async () => {
    const { call } = setup()
    await call('skills.import', { url: SOURCE })

    expect(await call('skills.setEnabled', { name: 'code-review', enabled: false })).toMatchObject({ ok: true })
    expect(await exists(live('code-review'))).toBe(false)
    expect(await names(call)).toEqual(['code-review:off', 'write-tests:on'])

    await call('skills.setEnabled', { name: 'code-review', enabled: true })
    expect(await exists(live('code-review'))).toBe(true)
    expect(await names(call)).toEqual(['code-review:on', 'write-tests:on'])

    const unknown = await call('skills.setEnabled', { name: 'nope', enabled: true })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('removing a skill deletes its row and its live folder, and only an imported skill can be removed', async () => {
    const { call } = setup()
    await call('skills.import', { url: SOURCE })

    expect(await call('skills.remove', { name: 'write-tests' })).toMatchObject({
      ok: true,
      value: [{ name: 'code-review' }],
    })
    expect(await exists(live('write-tests'))).toBe(false)

    const unknown = await call('skills.remove', { name: 'write-tests' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('counts a skill on only while its row is enabled and its live folder exists, and a repeat import repairs it', async () => {
    const { call } = setup()
    expect((await call('skills.import', { url: ARCHIFY.source })).ok).toBe(true)
    expect(await names(call)).toEqual(['archify:on'])

    await rm(join(home, '.claude', 'skills', 'archify'), { recursive: true, force: true })
    expect(await names(call)).toEqual(['archify:off'])
    expect((await call('skills.import', { url: ARCHIFY.source })).ok).toBe(true)
    expect(await names(call)).toEqual(['archify:on'])

    await call('skills.setEnabled', { name: 'archify', enabled: false })
    expect((await call('skills.import', { url: ARCHIFY.source })).ok).toBe(true)
    expect(await names(call)).toEqual(['archify:on'])
    expect(await exists(live('archify'))).toBe(true)
  })

  it('never imports over a folder of the person’s own, whatever its case and even with no SKILL.md', async () => {
    const { call } = setup()
    const own = join(home, '.claude', 'skills', 'Code-Review')
    await mkdir(own, { recursive: true })
    await writeFile(join(own, 'notes.txt'), 'mine')

    const result = await call('skills.import', { url: SOURCE })

    expect(result).toMatchObject({
      ok: true,
      value: { imported: [{ name: 'write-tests' }], skipped: [{ name: 'code-review' }] },
    })
    expect(await readFile(join(own, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('reports a skill installed outside the app as installed, so Diagrams can use it', async () => {
    const { call } = setup()
    await mkdir(join(home, '.claude', 'skills', 'archify'), { recursive: true })
    await writeFile(live('archify'), '---\nname: archify\n---\n')

    expect(await call('skills.installed')).toEqual({ ok: true, value: ['archify'] })
    expect(await names(call)).toEqual([])
  })
})
