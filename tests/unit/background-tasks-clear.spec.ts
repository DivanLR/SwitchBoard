import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    onVerifyChanged: () => {},
    onSecurityChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { repos, project, manager }
}

describe('clearing background tasks the CLI never closed', () => {
  it('releases the status the stale set was holding, and the queue behind it', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)

    await vi.waitFor(() => {
      const row = repos.sessions.byId(session.id)
      expect(row?.status).toBe('working')
      expect(row?.statusDetail).toMatch(/Running in background: Locate archify\.mjs/)
    })

    manager.enqueueTask(project.id, 'the task that was waiting')
    expect(repos.taskQueue.listForProject(project.id)).toHaveLength(1)

    manager.clearBackgroundTasks(session.id)

    expect(repos.taskQueue.listForProject(project.id)).toHaveLength(0)
    const prompts = repos.events
      .page(session.id, undefined, 50)
      .filter((e) => e.kind === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(prompts[0].payload)).toContain('the task that was waiting')
    expect(repos.sessions.byId(session.id)?.statusDetail).toBeNull()
  })

  it('lets the session reach done, which is what a section session closes on', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)
    await vi.waitFor(() =>
      expect(repos.sessions.byId(session.id)?.statusDetail).toMatch(/Running in background/),
    )

    manager.clearBackgroundTasks(session.id)

    await vi.waitFor(() => expect(repos.sessions.byId(session.id)?.status).toBe('done'))
  })
})
