// "My sessions keep renaming themselves." They did: Session.name was re-derived
// on every project list from facts that keep moving — the branch is re-read after
// every turn, an ending trades the branch for "- Complete", and a run row that
// points back at a session renames it after the fact. Each answer was true and
// the developer still could not learn a session by its name.
//
// This pins the fix (migration 029): the name is derived once, kept, and reused.
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
    } catch {
      // A temp directory the OS still holds open. The OS can have it.
    }
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
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onApiRequests: () => {},
    onApiChanged: () => {},
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
  })
  const listener = registered.get(INVOKE_CHANNEL)
  if (!listener) throw new Error(`nothing registered on ${INVOKE_CHANNEL}`)
  const event = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }

  /** The one session name the sidebar would show for this project. */
  const nameNow = async (): Promise<string | null | undefined> => {
    const result = (await listener(event, 'projects.list', undefined)) as WireResult<{
      projects: ProjectListItem[]
    }>
    if (!result.ok) throw new Error('projects.list failed')
    return result.value.projects[0]?.sessions[0]?.name
  }

  return { repos, manager, project, nameNow }
}

/** The live row the manager holds, which is what a project list reads from. */
function liveRow(manager: unknown, sessionId: string): { branch: string | null; endReason: string | null } {
  const m = manager as { hosted: Map<string, { row: { branch: string | null; endReason: string | null } }> }
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
    // The branch is read asynchronously just after start, and this project is a
    // bare temp directory — so set it the way refreshBranch would.
    liveRow(manager, session.id).branch = 'main'

    expect(await nameNow()).toBe('Diff - main')

    // A checkout. Every session on it used to be renamed by the next list.
    liveRow(manager, session.id).branch = 'feature/x'
    expect(await nameNow()).toBe('Diff - main')
    // Kept on the row, not merely in memory, so it survives the session ending.
    expect(repos.sessions.byId(session.id)?.derivedName).toBe('Diff - main')
  })

  it('waits for a complete answer rather than freezing a bare one', async () => {
    const { repos, manager, project, nameNow } = setup()
    const inner = manager as unknown as {
      startBackground: (projectId: string, kind: string) => Promise<{ id: string }>
    }
    const session = await inner.startBackground(project.id, 'diff')

    // No branch yet, and not ended: the name shows, and nothing is committed to.
    expect(await nameNow()).toBe('Diff')
    expect(repos.sessions.byId(session.id)?.derivedName).toBeNull()

    // Once the branch lands, THAT is the answer that sticks.
    liveRow(manager, session.id).branch = 'main'
    expect(await nameNow()).toBe('Diff - main')
    expect(repos.sessions.byId(session.id)?.derivedName).toBe('Diff - main')
  })
})

