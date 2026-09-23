import type { PtyHost } from '@main/terminal/pty-host'
import { mkdtemp, rm } from 'node:fs/promises'
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

describe('the archify skill import Diagrams offers', () => {
  let home: string
  const previousProfile = process.env.USERPROFILE
  const previousHome = process.env.HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sb-home-'))
    process.env.USERPROFILE = home
    process.env.HOME = home
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ tree: [{ path: 'archify/SKILL.md', type: 'blob', size: 64 }] }))
      }
      return new Response('---\nname: archify\ndescription: Draws architecture.\n---\n')
    })
  })

  afterEach(async () => {
    process.env.USERPROFILE = previousProfile
    process.env.HOME = previousHome
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })

  it('refuses any source other than the archify skill', async () => {
    const { call } = setup()
    const result = await call('skills.import', { url: 'https://github.com/someone/skills' })
    expect(result).toMatchObject({ ok: false, error: { code: 'RULE_NOT_ALLOWED' } })
  })

  it('counts the skill installed only while its live folder exists, and a repeat import repairs it', async () => {
    const { call } = setup()
    expect(await call('skills.list')).toEqual({ ok: true, value: [] })

    expect((await call('skills.import', { url: ARCHIFY.source })).ok).toBe(true)
    expect(await call('skills.list')).toEqual({ ok: true, value: ['archify'] })

    await rm(join(home, '.claude', 'skills', 'archify'), { recursive: true, force: true })
    expect(await call('skills.list')).toEqual({ ok: true, value: [] })

    expect((await call('skills.import', { url: ARCHIFY.source })).ok).toBe(true)
    expect(await call('skills.list')).toEqual({ ok: true, value: ['archify'] })
  })
})
