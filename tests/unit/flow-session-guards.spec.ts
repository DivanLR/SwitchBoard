import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { flagCalls, queryOptions } = vi.hoisted(() => ({ flagCalls: [] as unknown[], queryOptions: [] as unknown[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: (args: { options?: unknown }) => {
    queryOptions.push(args.options)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      supportedCommands: () => Promise.resolve([]),
      supportedModels: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(),
      applyFlagSettings: (settings: unknown) => {
        flagCalls.push(settings)
        return Promise.resolve()
      },
      setModel: () => Promise.resolve(),
    }
  },
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

type Hosted = {
  gateSubagents(): Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>
  handleMessage(message: unknown): void
}

type Inner = {
  quitting: boolean
  hosted: Map<string, { session: Hosted }>
  handleExit(entry: unknown, reason: 'completed' | 'stopped' | 'crashed'): void
}

const dirs: string[] = []
afterEach(() => {
  flagCalls.length = 0
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  repos.settings.set({ effort: 'xhigh' })
  const dir = mkdtempSync(join(tmpdir(), 'flow-guards-'))
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
  const turns: { sessionId: string; error: string | null }[] = []
  const ended: string[] = []
  manager.setFlowHooks({
    onMarker: () => {},
    onSessionEnded: (sessionId) => ended.push(sessionId),
    onVerifyReport: () => {},
    onTurnEnded: (sessionId, error) => turns.push({ sessionId, error }),
  })
  const inner = manager as unknown as Inner
  const hosted = (id: string): Hosted => inner.hosted.get(id)!.session
  return { repos, project, manager, inner, hosted, turns, ended }
}

describe('a session started at a pinned effort', () => {
  it('still applies max and allows the Agent tool after its first send, whatever the Settings effort', async () => {
    const h = setup()
    const session = await h.manager.startSession(h.project.id, false, undefined, {
      background: true,
      effort: 'max',
    })
    h.manager.sendMessage(session.id, '/speckit-implement-scaffold')
    expect(flagCalls).toEqual([{ effortLevel: 'max' }])
    expect((await h.hosted(session.id).gateSubagents()).hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('leaves a session without one on the Settings effort', async () => {
    const h = setup()
    const session = await h.manager.startSession(h.project.id, false, undefined, { background: true })
    h.manager.sendMessage(session.id, 'Write the spec.')
    expect(flagCalls).toEqual([{ effortLevel: 'xhigh' }])
    expect((await h.hosted(session.id).gateSubagents()).hookSpecificOutput?.permissionDecision).toBe('deny')
  })
})

describe('the project task queue', () => {
  it('never drains a queued task or handover into a Flow stage session', async () => {
    const h = setup()
    const flowSession = await h.manager.startSession(h.project.id, false, undefined, {
      background: true,
      section: 'flow',
    })
    h.manager.enqueueTask(h.project.id, 'Handed over by beta: fix the login page.')
    expect(h.manager.listQueue(h.project.id)).toHaveLength(1)
    expect(h.repos.events.page(flowSession.id).filter((e) => e.kind === 'prompt')).toHaveLength(0)

    const plain = await h.manager.startSession(h.project.id)
    expect(h.manager.listQueue(h.project.id)).toHaveLength(0)
    expect(h.repos.events.page(plain.id).filter((e) => e.kind === 'prompt')).toHaveLength(1)
  })
})

describe('a Flow stage session', () => {
  it('works in its worktree with every companion worktree as an extra directory, all of them its own folders', async () => {
    const h = setup()
    const primary = join(h.project.path, 'alpha.worktrees', 'checkout')
    const companion = join(h.project.path, 'api.worktrees', 'checkout')
    const session = await h.manager.startSession(h.project.id, false, undefined, {
      background: true,
      cwd: primary,
      additionalDirectories: [companion],
    })
    const options = queryOptions.at(-1) as { cwd: string; additionalDirectories: string[] }
    expect(options.cwd).toBe(primary)
    expect(options.additionalDirectories).toEqual([primary, companion])
    expect(h.manager.sessionFolders(session.id)).toEqual([primary, companion])

    const plain = await h.manager.startSession(h.project.id, false, undefined, { background: true })
    expect(h.manager.sessionFolders(plain.id)).toEqual([h.project.path])
  })

  it('reports a turn that ended in an error with that error', async () => {
    const h = setup()
    const session = await h.manager.startSession(h.project.id, false, undefined, { background: true })
    h.manager.watchFlow(session.id)
    h.manager.sendMessage(session.id, 'Build it.')
    h.hosted(session.id).handleMessage({
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['Reached the maximum number of turns.'],
      session_id: 'sdk',
      usage: {},
    })
    expect(h.turns).toEqual([{ sessionId: session.id, error: 'Reached the maximum number of turns.' }])
  })

  it('reports neither a turn end nor a session end while the app is quitting', async () => {
    const h = setup()
    const session = await h.manager.startSession(h.project.id, false, undefined, { background: true })
    h.manager.watchFlow(session.id)
    h.manager.sendMessage(session.id, 'Build it.')
    h.inner.quitting = true
    h.hosted(session.id).handleMessage({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sdk', usage: {} })
    h.inner.handleExit(h.inner.hosted.get(session.id), 'stopped')
    expect(h.turns).toEqual([])
    expect(h.ended).toEqual([])
  })
})
