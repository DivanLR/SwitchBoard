import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pending: { reject: (error: Error) => void }[] = []
function crashLoops(): void {
  for (const loop of pending.splice(0)) {
    loop.reject(new Error('Claude Code process exited with code 1'))
  }
}

const { queryOptions } = vi.hoisted(() => ({ queryOptions: [] as { model?: string }[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: (args: { options?: { model?: string } }) => {
    queryOptions.push(args.options ?? {})
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((_resolve, reject) => pending.push({ reject })),
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
  pending.length = 0
  queryOptions.length = 0
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
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
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
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

    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
    const revived = manager.liveSessionIds()[0]
    expect(revived).not.toBe(crashed.id)
    expect(repos.sessions.byId(crashed.id)?.endReason).toBe('crashed')
    expect(repos.sessions.byId(crashed.id)?.endedAt).toBeTruthy()

    await vi.waitFor(() => {
      const prompts = repos.events.page(revived, undefined, 50).filter((e) => e.kind === 'prompt')
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

    crashLoops()
    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.liveSessionIds()).toHaveLength(0)
  })

  it('brings a host session on a bypass project back on the host, not in a bypass container', async () => {
    const { repos, project, manager } = setup()
    repos.projects.setSessionMode(project.id, 'bypass')
    await manager.startSession(project.id, false, 'auto')

    crashLoops()

    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
    const revived = manager.liveSessionIds()[0]
    expect(manager.runsInContainer(revived)).toBe(false)
    expect(repos.sessions.byId(revived)?.bypassPermissions).toBe(false)
  })

  it('brings a session that dropped a model on a usage limit back on the lower model', async () => {
    const { repos, project, manager } = setup()
    repos.settings.set({ modelMode: 'basic', model: 'claude-opus-5' })
    const first = await manager.startSession(project.id)
    expect(queryOptions.at(-1)?.model).toBe('claude-opus-5')
    const hosted = (manager as unknown as { hosted: Map<string, { session: { handleMessage(m: unknown): void } }> })
      .hosted
    hosted.get(first.id)!.session.handleMessage({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429, session_id: 'sdk-1',
      result: 'Claude AI usage limit reached|1790000000', total_cost_usd: 0, duration_ms: 1, usage: {},
    })

    crashLoops()

    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
    expect(queryOptions.at(-1)?.model).toBe('sonnet')
  })

  it('brings a session back in the mode it was started in, not the project default', async () => {
    const { repos, project, manager } = setup()
    repos.projects.setSessionMode(project.id, 'acceptEdits')
    await manager.startSession(project.id, false, 'plan')

    crashLoops()

    await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
    const revived = manager.liveSessionIds()[0]
    expect(repos.sessions.byId(revived)?.planMode).toBe(true)
  })
})
