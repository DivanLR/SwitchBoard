import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowMarker } from '@main/flow/flow-markers'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { FlowSupervisor, FLOW_BACKOFF_MS, MAX_ITEM_ATTEMPTS } = await import('@main/flow/flow-supervisor')

type Repos = ReturnType<typeof createRepositories>

const SCOPE: FlowMarker = {
  kind: 'scope',
  items: [
    { localId: 'a', title: 'First', body: 'one', acceptance: [], estimate: 'm' },
    { localId: 'b', title: 'Second', body: 'two', acceptance: [], estimate: 'm' },
    { localId: 'c', title: 'Third', body: 'three', acceptance: [], estimate: 'm' },
  ],
  risks: [],
  outOfScope: [],
}

function setup(options?: { concurrency?: number; dirty?: string[] }) {
  const repos: Repos = createRepositories(openDatabase(':memory:'))
  const settings = repos.settings.get()
  repos.settings.set({ ...settings, flowConcurrency: options?.concurrency ?? 2 })
  const project = repos.projects.insert({ name: 'alpha', path: 'C:\\work\\alpha', source: 'manual' })
  const sent: { sessionId: string; text: string }[] = []
  const started: { mode: string; cwd?: string; effort?: string }[] = []
  let sessionCount = 0

  const manager = {
    startSession: vi.fn(async (_p: string, _r: boolean, mode: string, _c: unknown, opts: Record<string, unknown>) => {
      sessionCount += 1
      started.push({ mode, cwd: opts?.cwd as string, effort: opts?.effort as string })
      return { id: `session-${sessionCount}` }
    }),
    connectedMcpServers: vi.fn(async () => ['ado']),
    sendMessage: (sessionId: string, text: string) => sent.push({ sessionId, text }),
    watchFlow: vi.fn(),
    markSection: vi.fn(),
    renameSession: vi.fn(),
    interruptSession: vi.fn(async () => ({ stillQueued: 0 })),
    workdirFor: () => 'C:\\work\\alpha',
  }

  const created: { branch: string; path: string; base: string }[] = []
  const git = {
    create: vi.fn(async (input: { branch: string; path: string; base: string }) => {
      created.push(input)
      return {}
    }),
    dirty: vi.fn(async () => options?.dirty ?? []),
    branch: vi.fn(async () => 'main'),
    root: () => 'C:\\work\\alpha\\.worktrees',
  }

  const flow = new FlowSupervisor(repos, manager as never, { onFlowChanged: () => {} }, git)
  return { repos, project, flow, manager, git, sent, started, created }
}

async function published(harness: ReturnType<typeof setup>) {
  const run = await harness.flow.start({
    projectId: harness.project.id,
    featureId: '4711',
    featureTitle: 'Checkout v2',
  })
  harness.flow.onFlowMarker(run.sessionId!, SCOPE)
  await vi.waitFor(() => expect(harness.repos.flowRuns.byId(run.id)?.status).toBe("crosscheck"), { timeout: 5000 })
  harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
    kind: "signoff",
    verdict: "approve",
    concerns: [],
    items: null,
  })
  await harness.flow.publish(run.id)
  harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
    kind: 'published',
    created: [
      { localId: 'a', workItemId: '5001', url: null },
      { localId: 'b', workItemId: '5002', url: null },
      { localId: 'c', workItemId: '5003', url: null },
    ],
    failed: [],
  })
  return run
}

describe('starting the work', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('refuses while the main checkout is dirty, and says how many changes', async () => {
    const dirty = setup({ dirty: [' M src/app.ts', '?? notes.md'] })
    const run = await published(dirty)

    await expect(dirty.flow.startWork(run.id)).rejects.toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: expect.stringContaining('2 uncommitted changes'),
    })
    expect(dirty.git.create).not.toHaveBeenCalled()
  })

  it('gives each item its own branch and worktree, and runs them at max effort', async () => {
    const run = await published(harness)

    await harness.flow.startWork(run.id)

    expect(harness.created.map((w) => w.branch)).toEqual(['flow/5001-first', 'flow/5002-second'])
    expect(harness.created.every((w) => w.base === 'main')).toBe(true)
    const implementers = harness.started.filter((s) => s.mode === 'acceptEdits')
    expect(implementers).toHaveLength(2)
    expect(implementers.every((s) => s.effort === 'max')).toBe(true)
    expect(implementers[0].cwd).toContain('.worktrees')
  })

  it('holds the rest at the cap until a slot frees', async () => {
    const run = await published(harness)
    await harness.flow.startWork(run.id)

    const statuses = () =>
      harness.repos.flowItems.listForRun(run.id).map((item) => `${item.localId}:${item.status}`)
    expect(statuses()).toEqual(['a:implementing', 'b:implementing', 'c:queued'])

    const first = harness.repos.flowItems.listForRun(run.id)[0]
    harness.flow.onFlowMarker(first.sessionId!, {
      kind: 'item',
      workItemId: '5001',
      outcome: 'blocked',
      summary: '',
      why: 'the API it needs does not exist yet',
    })
    await Promise.resolve()

    expect(harness.repos.flowItems.byId(first.id)?.status).toBe('blocked')
    await vi.waitFor(() => expect(statuses()).toContain('c:implementing'), { timeout: 5000 })
  })

  it('tells a session it is picking up half-finished work when it is a restart', async () => {
    const run = await published(harness)
    await harness.flow.startWork(run.id)
    const item = harness.repos.flowItems.listForRun(run.id)[0]

    harness.flow.onSessionEnded(item.sessionId!, 'crashed')
    await vi.waitFor(() => expect(harness.repos.flowItems.byId(item.id)?.status).not.toBe('implementing'), { timeout: 5000 })

    expect(harness.repos.flowItems.byId(item.id)?.note).toContain('Restarting, attempt 2')
  })
})

describe('finishing an item', () => {
  it('raises a pull request once the implementer reports done', async () => {
    const harness = setup()
    const run = await published(harness)
    await harness.flow.startWork(run.id)
    const item = harness.repos.flowItems.listForRun(run.id)[0]

    harness.flow.onFlowMarker(item.sessionId!, {
      kind: 'item',
      workItemId: '5001',
      outcome: 'done',
      summary: 'versioned the cart state',
      why: null,
    })
    await vi.waitFor(() => expect(harness.repos.flowItems.byId(item.id)?.status).toBe('raising_pr'), { timeout: 5000 })

    const prPrompt = harness.sent.at(-1)!.text
    expect(prPrompt).toContain('Raise a pull request')
    expect(prPrompt).toContain('into main')
    expect(prPrompt).toContain('Do not complete, approve or merge')
  })

  it('records the pull request the session reported', async () => {
    const harness = setup()
    const run = await published(harness)
    await harness.flow.startWork(run.id)
    const item = harness.repos.flowItems.listForRun(run.id)[0]
    harness.flow.onFlowMarker(item.sessionId!, {
      kind: 'item',
      workItemId: '5001',
      outcome: 'done',
      summary: 'done',
      why: null,
    })
    await vi.waitFor(() => expect(harness.repos.flowItems.byId(item.id)?.status).toBe('raising_pr'), { timeout: 5000 })

    const prSession = harness.repos.flowItems.byId(item.id)!.sessionId!
    harness.flow.onFlowMarker(prSession, {
      kind: 'pr',
      workItemId: '5001',
      prId: '312',
      url: 'https://dev.azure.com/pr/312',
      branch: 'flow/5001-first',
    })

    expect(harness.repos.flowItems.byId(item.id)).toMatchObject({
      status: 'pr_open',
      prId: '312',
      prUrl: 'https://dev.azure.com/pr/312',
    })
  })

  it('parks an interrupted pull request instead of opening a second one', async () => {
    const harness = setup()
    const run = await published(harness)
    await harness.flow.startWork(run.id)
    const item = harness.repos.flowItems.listForRun(run.id)[0]
    harness.flow.onFlowMarker(item.sessionId!, {
      kind: 'item',
      workItemId: '5001',
      outcome: 'done',
      summary: 'done',
      why: null,
    })
    await vi.waitFor(() => expect(harness.repos.flowItems.byId(item.id)?.status).toBe('raising_pr'), { timeout: 5000 })

    harness.flow.onSessionEnded(harness.repos.flowItems.byId(item.id)!.sessionId!, 'crashed')

    const after = harness.repos.flowItems.byId(item.id)
    expect(after?.status).toBe('pr_interrupted')
    expect(after?.note).toContain('check Azure Repos before retrying')
  })
})

describe('restarts', () => {
  it('backs off between restarts, then gives up after the cap', async () => {
    const harness = setup({ concurrency: 1 })
    const run = await published(harness)
    await harness.flow.startWork(run.id)
    const itemId = harness.repos.flowItems.listForRun(run.id)[0].id

    vi.useFakeTimers()
    try {
      for (let attempt = 1; attempt <= MAX_ITEM_ATTEMPTS; attempt += 1) {
        const live = harness.repos.flowItems.byId(itemId)!
        expect(live.status).toBe('implementing')
        expect(live.attempts).toBe(attempt)

        harness.flow.onSessionEnded(live.sessionId!, 'crashed')
        if (attempt === MAX_ITEM_ATTEMPTS) break

        expect(harness.repos.flowItems.byId(itemId)?.status).toBe('queued')
        await vi.advanceTimersByTimeAsync(FLOW_BACKOFF_MS[attempt - 1])
        for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
      }
    } finally {
      vi.useRealTimers()
    }

    const item = harness.repos.flowItems.byId(itemId)!
    expect(item.status).toBe('failed')
    expect(item.note).toContain(`Gave up after ${MAX_ITEM_ATTEMPTS} attempts`)
    expect(item.sessionId).toBeNull()
  })

  it('puts a retried item back in the queue with its attempts cleared', async () => {
    const harness = setup({ concurrency: 1 })
    const run = await published(harness)
    await harness.flow.startWork(run.id)
    const item = harness.repos.flowItems.listForRun(run.id)[0]
    harness.repos.flowItems.update(item.id, { status: 'failed', attempts: 3, note: 'gave up' })

    await harness.flow.retryItem(item.id)

    const after = harness.repos.flowItems.byId(item.id)
    expect(after?.attempts).toBeLessThanOrEqual(1)
    expect(['queued', 'preparing', 'implementing']).toContain(after?.status)
    expect(after?.note).not.toBe('gave up')
  })
})
