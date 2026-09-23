import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@shared/domain'

interface FakeQuery {
  options: Record<string, unknown>
  sent: string[]
  push: (message: unknown) => void
  crash: (error: Error) => void
}

const queries: FakeQuery[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
    const values: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    let done = false
    const fake: FakeQuery = {
      options,
      sent: [],
      push: (message) => {
        const waiter = waiters.shift()
        if (waiter) waiter.resolve({ value: message, done: false })
        else values.push(message)
      },
      crash: (error) => {
        for (const waiter of waiters.splice(0)) waiter.reject(error)
      },
    }
    queries.push(fake)
    void (async () => {
      for await (const message of prompt) fake.sent.push(message.message.content)
      done = true
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
    })()
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false })
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
        },
      }),
      supportedCommands: () => Promise.resolve([]),
      supportedModels: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      applyFlagSettings: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
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
  queries.length = 0
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'))
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

const init = (sdkSessionId: string): unknown => ({ type: 'system', subtype: 'status', session_id: sdkSessionId })

const result = (extra: Record<string, unknown> = {}): unknown => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  session_id: 'sdk',
  total_cost_usd: 0,
  duration_ms: 1,
  usage: {},
  ...extra,
})

describe('crash revive and Resume', () => {
  it('resumes the conversation of the session that crashed, not a background session that ended later', async () => {
    const { repos, project, manager } = setup()
    const foreground = await manager.startSession(project.id)
    queries[0].push(init('sdk-FOREGROUND'))
    await vi.waitFor(() => expect(repos.sessions.byId(foreground.id)?.sdkSessionId).toBe('sdk-FOREGROUND'))

    const background = await manager.backgroundSessionFor(project.id, 'diff')
    queries[1].push(init('sdk-BACKGROUND'))
    await vi.waitFor(() => expect(repos.sessions.byId(background.id)?.sdkSessionId).toBe('sdk-BACKGROUND'))
    await manager.stopSession(background.id)

    queries[0].crash(new Error('Claude Code process exited with code 1'))

    await vi.waitFor(() => expect(queries).toHaveLength(3))
    expect(queries[2].options.resume).toBe('sdk-FOREGROUND')
  })

  it('offers Resume on the foreground session that ended last, not the one that started last', () => {
    const { repos, project } = setup()
    const add = (id: string, startedAt: string, endedAt: string, sectionKind?: 'diff'): void => {
      const row: Session = {
        id,
        projectId: project.id,
        sdkSessionId: `sdk-${id}`,
        status: 'done',
        statusDetail: null,
        branch: null,
        diffAdds: null,
        diffDels: null,
        usageUtilization: null,
        usageResetsAt: null,
        usageLimitType: null,
        startedAt,
        endedAt: null,
        endReason: null,
        planMode: false,
        inPlanMode: false,
      }
      repos.sessions.insert(row)
      repos.sessions.update(id, { endedAt, endReason: 'completed', ...(sectionKind ? { sectionKind } : {}) })
    }
    add('long', '2026-09-01T01:00:00.000Z', '2026-09-01T05:00:00.000Z')
    add('short', '2026-09-01T02:00:00.000Z', '2026-09-01T03:00:00.000Z')
    add('diff', '2026-09-01T06:00:00.000Z', '2026-09-01T07:00:00.000Z', 'diff')

    expect(repos.sessions.latestEndedForProject(project.id)?.sdkSessionId).toBe('sdk-long')
  })
})

describe('the queue belongs to the foreground session', () => {
  it('leaves handed-over work queued rather than sending it into an idle background session', async () => {
    const { project, manager } = setup()
    await manager.backgroundSessionFor(project.id, 'diff')

    manager.enqueueTask(project.id, 'Handed over by the other session: do X')

    expect(manager.listQueue(project.id)).toHaveLength(1)
    expect(queries[0].sent).toEqual([])
  })

  it('does not hand queued work to a background session as its first prompt', async () => {
    const { project, manager } = setup()
    manager.enqueueTask(project.id, 'queued work')

    await manager.startSession(project.id, false, undefined, { background: true })

    expect(manager.listQueue(project.id)).toHaveLength(1)
    expect(queries[0].sent).toEqual([])
  })

  it('still drains into the foreground session once it is idle', async () => {
    const { project, manager } = setup()
    manager.enqueueTask(project.id, 'queued work')

    await manager.startSession(project.id)

    await vi.waitFor(() => expect(queries[0].sent).toEqual(['queued work']))
    expect(manager.listQueue(project.id)).toHaveLength(0)
  })
})

describe('a background section session', () => {
  it('closes itself once its turn has ended', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.backgroundSessionFor(project.id, 'tests')
    manager.sendMessage(session.id, 'run the suites')

    queries[0].push(result())

    await vi.waitFor(() => expect(repos.sessions.byId(session.id)?.endedAt).toBeTruthy())
    expect(repos.sessions.byId(session.id)?.endReason).toBe('completed')
    expect(manager.liveSessionIds()).toEqual([])
  })
})

describe('a queued prompt during a long turn', () => {
  it('is still marked delivered once it is sent, however many tool events came before it', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)
    manager.sendMessage(session.id, 'first')
    const { eventId, queued } = manager.sendMessage(session.id, 'second')
    expect(queued).toBe(true)
    const sink = manager.sinkFor(session.id)
    for (let i = 0; i < 205; i++) {
      sink.append('tool_activity', { toolUseId: `t${i}`, toolName: 'Read', summary: 'read', status: 'done' } as never)
    }

    queries[0].push(result())

    await vi.waitFor(() => expect(queries[0].sent).toEqual(['first', 'second']))
    const stored = repos.events.page(session.id, undefined, 500).find((e) => e.id === eventId)
    expect(stored?.payload).toEqual({ text: 'second', pending: false })
  })
})

describe('quitting the application', () => {
  it('records each session as ended by the quit, with the note that it can be resumed', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)

    await manager.endAllForAppExit()

    const row = repos.sessions.byId(session.id)
    expect(row?.endReason).toBe('app_exit')
    expect(row?.statusDetail).toMatch(/can be resumed/)
  })
})

describe('subagents', () => {
  it('registers one worker agent at the Subagents effort, and the fan-out directive names it', async () => {
    const { repos, project, manager } = setup()
    repos.settings.set({ effort: 'max', subagentEffort: 'max' })

    await manager.startSession(project.id)

    const agents = queries[0].options.agents as Record<string, { effort?: string }>
    expect(Object.keys(agents)).toEqual(['worker'])
    expect(agents.worker.effort).toBe('max')
    const systemPrompt = queries[0].options.systemPrompt as { append: string }
    expect(systemPrompt.append).toContain('"worker"')
  })

  it('runs the worker at the lower Subagents effort when the bar is below max', async () => {
    const { repos, project, manager } = setup()
    repos.settings.set({ effort: 'max', subagentEffort: 'low' })

    await manager.startSession(project.id)

    const agents = queries[0].options.agents as Record<string, { effort?: string }>
    expect(agents.worker.effort).toBe('low')
  })
})
