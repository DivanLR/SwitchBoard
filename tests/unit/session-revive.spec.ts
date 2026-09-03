// A crashed conversation is restarted by the APP, once, and told to pick the work
// back up (reviveCrashed). This is the supervision an autonomous session needs,
// and the two properties worth pinning are the two that make it safe: a resumed
// session is actually nudged (a live but idle session supervises nothing), and a
// second crash inside the cooldown is NOT restarted, so a session that dies on
// the same thing every time cannot loop for ever.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One run loop per session, each resolvable OR rejectable: a rejection is how the
// SDK reports the CLI process dying, which is the only path reviveCrashed acts on.
const pending: { reject: (error: Error) => void }[] = []
function crashLoops(): void {
  for (const loop of pending.splice(0)) {
    loop.reject(new Error('Claude Code process exited with code 1'))
  }
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((_resolve, reject) => pending.push({ reject })),
    }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
    // The deliver path applies the routed model/effort on every send, so the
    // nudge prompt reaches nothing without these two.
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:/fake/claude.exe',
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

const dirs: string[] = []
afterEach(() => {
  pending.length = 0
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // A temp directory the OS still holds open. The OS can have it.
    }
  }
})

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'revive-'))
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
    gate: (() => {}) as never,
  })
  return { repos, project, manager }
}

describe('a crashed session is restarted by the app', () => {
  it('resumes it and tells it to carry on, rather than leaving it live and idle', async () => {
    const { repos, project, manager } = setup()
    const crashed = await manager.startSession(project.id)

    crashLoops()

    // A second session for the project, and the crashed one recorded as such.
    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
    const revived = manager.liveSessionIds()[0]
    expect(revived).not.toBe(crashed.id)
    expect(repos.sessions.byId(crashed.id)?.endReason).toBe('crashed')
    // It resumes the conversation that died, rather than starting a blank one.
    expect(repos.sessions.byId(crashed.id)?.endedAt).toBeTruthy()

    // The nudge. Without it the restart produces a session that is up and doing
    // nothing, which is indistinguishable from the crash it was meant to undo.
    await vi.waitFor(() => {
      const prompts = repos.events
        .page(revived, undefined, 50)
        .filter((e) => e.kind === 'prompt')
      expect(prompts).toHaveLength(1)
      expect(JSON.stringify(prompts[0].payload)).toMatch(/Switchboard restarted this session/)
      expect(JSON.stringify(prompts[0].payload)).toMatch(/exited with code 1/)
    })
  })

  it('refuses a second restart inside the cooldown, so a repeat crash cannot loop', async () => {
    const { project, manager } = setup()
    await manager.startSession(project.id)

    crashLoops()
    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))

    // The revived session dies the same way, immediately. Nothing should replace it.
    crashLoops()
    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.liveSessionIds()).toHaveLength(0)
  })
})
