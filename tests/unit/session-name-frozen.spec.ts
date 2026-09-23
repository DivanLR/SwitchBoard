import type { PtyHost } from '@main/terminal/pty-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INVOKE_CHANNEL } from '@shared/ipc-types'
import type { ProjectListItem, WireResult } from '@shared/ipc-types'

const registered = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      registered.set(channel, listener)
    },
  },
  app: { getPath: () => tmpdir(), isPackaged: false },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class {},
}))

vi.mock('@main/updater', () => ({
  initUpdater: () => {},
  check: async () => 'idle',
  installNow: async () => {},
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:/fake/claude.exe',
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')
const { PermissionBroker } = await import('@main/inbox/permission-broker')
const { registerIpcHandlers } = await import('@main/ipc/handlers')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function setup() {
  registered.clear()
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'frozen-name-'))
  dirs.push(dir)
  const project = repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
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
  const window = { webContents: { id: 7, mainFrame: { name: 'main' } } }
  registerIpcHandlers({
    repos,
    manager,
    broker,
    getWindow: () => window as never,
    dbProjectId: 'db-project',
    skillsStagingRoot: join(tmpdir(), 'switchboard-test-skills'),
    flow: { reconcileOnStartup: () => {} } as never,
    keepCurrent: async () => ({ checkedAt: '', results: [] }),
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
  const event = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }

  const nameNow = async (): Promise<string | null | undefined> => {
    const result = (await listener(event, 'projects.list', undefined)) as WireResult<{
      projects: ProjectListItem[]
    }>
    if (!result.ok) throw new Error('projects.list failed')
    return result.value.projects[0]?.sessions[0]?.name
  }

  return { repos, manager, project, nameNow }
}

function liveRow(
  manager: unknown,
  sessionId: string,
): { branch: string | null; endReason: string | null } {
  const m = manager as {
    hosted: Map<string, { row: { branch: string | null; endReason: string | null } }>
  }
  const entry = m.hosted.get(sessionId)
  if (!entry) throw new Error('session is not live')
  return entry.row
}

describe('a session keeps the name it was learnt by', () => {
  it('does not rename itself when the branch moves under it', async () => {
    const { repos, manager, project, nameNow } = setup()
    const inner = manager as unknown as {
      startBackground: (projectId: string, kind: string) => Promise<{ id: string }>
    }
    const session = await inner.startBackground(project.id, 'diff')
    liveRow(manager, session.id).branch = 'main'

    expect(await nameNow()).toBe('Diff - main')

    liveRow(manager, session.id).branch = 'feature/x'
    expect(await nameNow()).toBe('Diff - main')
    expect(repos.sessions.byId(session.id)?.derivedName).toBe('Diff - main')
  })

  it('waits for a complete answer rather than freezing a bare one', async () => {
    const { repos, manager, project, nameNow } = setup()
    const inner = manager as unknown as {
      startBackground: (projectId: string, kind: string) => Promise<{ id: string }>
    }
    const session = await inner.startBackground(project.id, 'diff')

    expect(await nameNow()).toBe('Diff')
    expect(repos.sessions.byId(session.id)?.derivedName).toBeNull()

    liveRow(manager, session.id).branch = 'main'
    expect(await nameNow()).toBe('Diff - main')
    expect(repos.sessions.byId(session.id)?.derivedName).toBe('Diff - main')
  })
})
