import type { PtyHost } from '@main/terminal/pty-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WireResult } from '@shared/ipc-types'
import { INVOKE_CHANNEL } from '@shared/ipc-types'

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
    onSecurityChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const broker = new PermissionBroker(repos, manager, {
    onInboxChanged: () => {},
    onCountersChanged: () => {},
    onNeedsYou: () => {},
  })
  const window = { webContents: { id: 7, mainFrame: { name: 'main' } } }
  registerIpcHandlers({
    repos,
    manager,
    broker,
    getWindow: () => window as never,
    dbProjectId: 'db-project',
    skillsStagingRoot: join(tmpdir(), 'switchboard-test-skills'),
    securityRoot: join(tmpdir(), 'switchboard-test-security'),
    flow: { reconcileOnStartup: () => {} } as never,
    ptyHost: {
      open: () => ({ scrollback: '', reused: false }),
      write: () => {},
      resize: () => {},
      close: () => {},
      closeAll: () => {},
    } as unknown as PtyHost,
  })

  const listener = registered.get(INVOKE_CHANNEL)
  if (!listener) throw new Error(`nothing registered on ${INVOKE_CHANNEL}`)
  const trustedEvent = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }
  const call = (method: string, req?: unknown) =>
    listener(trustedEvent, method, req) as Promise<WireResult<unknown>>

  return { repos, call }
}

describe('security.start', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('fails with NOT_FOUND for an unknown project', async () => {
    const result = await harness.call('security.start', { projectId: 'nope', scope: 'project' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('asks for the skill before it will run anything', async () => {
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const result = await harness.call('security.start', { projectId: project.id, scope: 'project' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
    expect(result.error.message).toContain('security-audit')
  })

  it('refuses a second audit while one is still running', async () => {
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    harness.repos.securityRuns.start({
      projectId: project.id,
      sessionId: null,
      scope: 'project',
      branch: null,
      outputDir: 'C:\\audits\\run-1',
    })

    const result = await harness.call('security.start', { projectId: project.id, scope: 'changes' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RULE_NOT_ALLOWED')
  })
})

describe('security.list', () => {
  it('returns the runs for that project, newest first', async () => {
    const harness = setup()
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const other = harness.repos.projects.insert({ name: 'b', path: 'C:\\b', source: 'manual' })
    harness.repos.securityRuns.start({
      projectId: project.id,
      sessionId: null,
      scope: 'project',
      branch: null,
      outputDir: 'C:\\audits\\run-1',
    })
    harness.repos.securityRuns.start({
      projectId: other.id,
      sessionId: null,
      scope: 'project',
      branch: null,
      outputDir: 'C:\\audits\\run-2',
    })

    const result = await harness.call('security.list', { projectId: project.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const runs = result.value as { projectId: string; outputDir: string }[]
    expect(runs).toHaveLength(1)
    expect(runs[0].outputDir).toBe('C:\\audits\\run-1')
  })
})

describe('security.openReport', () => {
  it('refuses a path that is not a report file beside the run', async () => {
    const harness = setup()
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const run = harness.repos.securityRuns.start({
      projectId: project.id,
      sessionId: null,
      scope: 'project',
      branch: null,
      outputDir: join(tmpdir(), 'switchboard-test-security', 'run-1'),
    })

    const result = await harness.call('security.openReport', {
      projectId: project.id,
      runId: run.id,
      file: '../../secrets.md',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_PATH')
  })
})
