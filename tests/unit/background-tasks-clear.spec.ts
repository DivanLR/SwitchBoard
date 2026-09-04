// A background task the CLI never reported as finished used to wedge its session
// for good. `background_tasks_changed` is a LEVEL signal with replace semantics,
// and the SDK forbids pairing it with the per-task edges ("the payload carries ids
// only, so do not correlate it with the edge stream"), so when the membership
// change that would empty the set never arrives, nothing in this process can work
// out that it is stale.
//
// The cost is not the card. recomputeStatus keeps a session with background tasks
// out of 'done', and a project's planned queue only drains there — so a task that
// finished hours ago was still holding real work back. This pins both halves of
// the fix: the developer can clear the set, and clearing it releases the queue.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The one message this suite feeds the run loop, then it blocks like a live CLI. */
const backgroundStarted = {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [
    {
      task_id: 't1',
      task_type: 'agent',
      description: 'Locate archify.mjs and export-svg.mjs referenced by the README',
    },
  ],
  uuid: 'u1',
  session_id: 'sdk-1',
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => {
    let sent = false
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (sent) return new Promise(() => {})
          sent = true
          return Promise.resolve({ value: backgroundStarted, done: false })
        },
      }),
      supportedCommands: () => Promise.resolve([]),
      supportedModels: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(),
      // The deliver path applies the routed model/effort on every send, so the
      // drained task reaches nothing without these two.
      setModel: () => Promise.resolve(),
      applyFlagSettings: () => Promise.resolve(),
    }
  },
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:/fake/claude.exe',
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

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
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'bg-clear-'))
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

describe('clearing background tasks the CLI never closed', () => {
  it('releases the status the stale set was holding, and the queue behind it', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)

    // The CLI reported one background task and then said nothing more.
    await vi.waitFor(() => {
      const row = repos.sessions.byId(session.id)
      expect(row?.status).toBe('working')
      expect(row?.statusDetail).toMatch(/Running in background: Locate archify\.mjs/)
    })

    // Work planned for the project cannot run while that is true: the drain
    // requires 'done'. This is the consequence a developer actually feels.
    manager.enqueueTask(project.id, 'the task that was waiting')
    expect(repos.taskQueue.listForProject(project.id)).toHaveLength(1)

    manager.clearBackgroundTasks(session.id)

    // Released by the clear itself, rather than waiting for whenever the next
    // turn happened to end.
    expect(repos.taskQueue.listForProject(project.id)).toHaveLength(0)
    const prompts = repos.events
      .page(session.id, undefined, 50)
      .filter((e) => e.kind === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(prompts[0].payload)).toContain('the task that was waiting')
    // The session reads 'working' again, and that is the right answer for a
    // different reason: it is running the task it just picked up, not holding a
    // finished one. The stale detail is what must be gone.
    expect(repos.sessions.byId(session.id)?.statusDetail).toBeNull()
  })

  it('lets the session reach done, which is what a section session closes on', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)
    await vi.waitFor(() =>
      expect(repos.sessions.byId(session.id)?.statusDetail).toMatch(/Running in background/),
    )

    manager.clearBackgroundTasks(session.id)

    // Nothing queued, so nothing takes the session straight back to work: it
    // settles, which is the state endIfIdleBackground and the drain both need.
    await vi.waitFor(() => expect(repos.sessions.byId(session.id)?.status).toBe('done'))
  })
})
