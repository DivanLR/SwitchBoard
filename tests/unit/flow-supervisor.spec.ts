import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowMarker } from '@main/flow/flow-markers'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { FlowSupervisor } = await import('@main/flow/flow-supervisor')

type Repos = ReturnType<typeof createRepositories>

function setup(options?: { ado?: boolean }) {
  const repos: Repos = createRepositories(openDatabase(':memory:'))
  const project = repos.projects.insert({ name: 'alpha', path: 'C:\\work\\alpha', source: 'manual' })
  const sent: { sessionId: string; text: string }[] = []
  const watched: string[] = []
  const changed: string[] = []
  let sessionCount = 0

  const manager = {
    startSession: vi.fn(async () => {
      sessionCount += 1
      return { id: `session-${sessionCount}` }
    }),
    connectedMcpServers: vi.fn(async () => (options?.ado === false ? [] : ['ado'])),
    sendMessage: (sessionId: string, text: string) => sent.push({ sessionId, text }),
    watchFlow: (sessionId: string) => watched.push(sessionId),
    markSection: vi.fn(),
    renameSession: vi.fn(),
    interruptSession: vi.fn(async () => ({ stillQueued: 0 })),
    workdirFor: (sessionId: string) => (sessionId.startsWith('session-') ? 'C:\\work\\alpha' : undefined),
  }

  const flow = new FlowSupervisor(repos, manager as never, {
    onFlowChanged: (projectId) => changed.push(projectId),
  })

  return { repos, project, flow, manager, sent, watched, changed }
}

const SCOPE: FlowMarker = {
  kind: 'scope',
  items: [
    { localId: 'a', title: 'First', body: 'one', acceptance: ['works'], estimate: 'm' },
    { localId: 'b', title: 'Second', body: 'two', acceptance: [], estimate: 's' },
  ],
  risks: ['shared reducer'],
  outOfScope: ['pricing'],
}

describe('starting a flow', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('opens a plan-mode session, records the run, and sends the scoping prompt', async () => {
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })

    expect(run.status).toBe('scoping')
    expect(harness.manager.startSession).toHaveBeenCalledWith(
      harness.project.id,
      false,
      'plan',
      undefined,
      { background: true },
    )
    expect(harness.watched).toEqual([run.sessionId])
    expect(harness.sent[0].text).toContain('4711')
    expect(harness.changed).toEqual([harness.project.id])
  })

  it('refuses a second flow while one is open', async () => {
    await harness.flow.start({ projectId: harness.project.id, featureId: '1', featureTitle: 'One' })
    await expect(
      harness.flow.start({ projectId: harness.project.id, featureId: '2', featureTitle: 'Two' }),
    ).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
  })

  it('refuses to start at all when the DevOps server is not connected', async () => {
    const offline = setup({ ado: false })
    await expect(
      offline.flow.start({ projectId: offline.project.id, featureId: '1', featureTitle: 'One' }),
    ).rejects.toMatchObject({ code: 'NOT_LIVE' })
    expect(offline.repos.flowRuns.listForProject(offline.project.id)).toEqual([])
  })
})

async function signoff(
  harness: ReturnType<typeof setup>,
  runId: string,
  verdict: 'approve' | 'revise' = 'approve',
  concerns: string[] = [],
): Promise<void> {
  await vi.waitFor(() => expect(harness.repos.flowRuns.byId(runId)?.status).toBe('crosscheck'), { timeout: 5000 })
  harness.flow.onFlowMarker(harness.repos.flowRuns.byId(runId)!.sessionId!, {
    kind: 'signoff',
    verdict,
    concerns,
    items: null,
  })
}

describe('the scoping hand-back', () => {
  it('stores the items and sends them to a second session before asking you', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })

    harness.flow.onFlowMarker(run.sessionId!, SCOPE)
    await vi.waitFor(() => expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('crosscheck'), { timeout: 5000 })
    expect(harness.repos.flowRuns.byId(run.id)?.sessionId).not.toBe(run.sessionId)
    expect(harness.sent.at(-1)!.text).toContain('Another session wrote it; you did not')

    await signoff(harness, run.id)

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('awaiting_approval')
    expect(after?.risks).toEqual(['shared reducer'])
    const items = harness.repos.flowItems.listForRun(run.id)
    expect(items.map((item) => item.localId)).toEqual(['a', 'b'])
    expect(items.every((item) => item.status === 'proposed')).toBe(true)
    expect(items.every((item) => item.workItemId === null)).toBe(true)
  })

  it('ignores a scope marker from a session that is not the run\u2019s own', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })

    harness.flow.onFlowMarker('session-stranger', SCOPE)

    expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('scoping')
    expect(harness.repos.flowItems.listForRun(run.id)).toEqual([])
  })

  it('fails the run, and says nothing was written, when the session dies while scoping', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })

    harness.flow.onSessionEnded(run.sessionId!, 'crashed')

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('failed')
    expect(after?.note).toContain('Nothing was written to Azure DevOps')
  })
})

describe('publishing', () => {
  async function scoped() {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })
    harness.flow.onFlowMarker(run.sessionId!, SCOPE)
    await signoff(harness, run.id)
    return { harness, run }
  }

  it('will not publish before the breakdown is approved', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })
    await expect(harness.flow.publish(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
  })

  it('sends the publish prompt with the approved items and moves to publishing', async () => {
    const { harness, run } = await scoped()

    await harness.flow.publish(run.id)

    expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('publishing')
    const last = harness.sent.at(-1)!
    expect(last.text).toContain('Create these Product Backlog Items')
    expect(last.text).toContain('localId: a')
  })

  it('records the ids the session reported, and the ones it could not create', async () => {
    const { harness, run } = await scoped()
    await harness.flow.publish(run.id)

    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'published',
      created: [{ localId: 'a', workItemId: '5001', url: null }],
      failed: [{ localId: 'b', why: 'the area path was rejected' }],
    })

    const items = harness.repos.flowItems.listForRun(run.id)
    expect(items[0]).toMatchObject({ localId: 'a', workItemId: '5001', status: 'published' })
    expect(items[1]).toMatchObject({
      localId: 'b',
      status: 'failed',
      note: 'the area path was rejected',
    })
    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('ready')
    expect(after?.note).toContain('1 item could not be created')
  })

  it('parks an interrupted publish for a human, because work items may already exist', async () => {
    const { harness, run } = await scoped()
    await harness.flow.publish(run.id)

    harness.flow.onSessionEnded(harness.repos.flowRuns.byId(run.id)!.sessionId!, 'crashed')

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('publish_interrupted')
    expect(after?.note).toContain('check the Feature in Azure DevOps before retrying')
    expect(after?.finishedAt).toBeNull()
  })
})

describe('editing and cancelling', () => {
  it('replaces the proposed items with the edited list', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })
    harness.flow.onFlowMarker(run.sessionId!, SCOPE)
    await signoff(harness, run.id)

    const saved = harness.flow.saveItems(run.id, [
      { localId: 'a', title: 'First, renamed', body: 'one', acceptance: [], estimate: 'm' },
    ])

    expect(saved.map((item) => item.title)).toEqual(['First, renamed'])
  })

  it('stops the run and says who stopped it', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })

    await harness.flow.cancel(run.id)

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('cancelled')
    expect(after?.note).toBe('You stopped this flow.')
    expect(harness.manager.interruptSession).toHaveBeenCalled()
  })
})

describe('restart', () => {
  it('stops a scoping run on the next launch rather than leaving it looking live', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })

    harness.flow.reconcileOnStartup()

    expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('failed')
  })

  it('parks an interrupted publish instead of retrying it', async () => {
    const harness = setup()
    const run = await harness.flow.start({
      projectId: harness.project.id,
      featureId: '4711',
      featureTitle: 'Checkout v2',
    })
    harness.flow.onFlowMarker(run.sessionId!, SCOPE)
    await signoff(harness, run.id)
    await harness.flow.publish(run.id)

    harness.flow.reconcileOnStartup()

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('publish_interrupted')
    expect(after?.finishedAt).toBeNull()
  })
})

describe('the feature spec', () => {
  it('needs approved items and Spec Kit, then sends /speckit-specify to the spec session once', async () => {
    const harness = setup()
    const backgroundSessionFor = vi.fn(async () => ({ id: 'spec-1' }))
    Object.assign(harness.manager, { backgroundSessionFor })
    const dir = mkdtempSync(join(tmpdir(), 'swb-spec-'))
    try {
      const project = harness.repos.projects.insert({ name: 'kit', path: dir, source: 'manual' })
      const run = harness.repos.flowRuns.start({
        projectId: project.id,
        featureId: '4711',
        featureTitle: 'Checkout v2',
        sessionId: null,
        concurrency: 4,
      })

      await expect(harness.flow.writeSpec(run.id)).rejects.toMatchObject({ code: 'INVALID_PATH' })

      harness.repos.flowItems.replaceForRun(run.id, project.id, [
        {
          localId: 'cart',
          title: 'Version the cart',
          body: 'Reconcile by version.\nA late response never wins.',
          acceptance: ['Two adds keep both'],
          estimate: 'm',
        },
      ])
      await expect(harness.flow.writeSpec(run.id)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
      expect(backgroundSessionFor).not.toHaveBeenCalled()

      mkdirSync(join(dir, '.specify'))
      const after = await harness.flow.writeSpec(run.id)
      expect(after.specSessionId).toBe('spec-1')
      expect(backgroundSessionFor).toHaveBeenCalledWith(project.id, 'spec')
      const sent = harness.sent.at(-1)
      expect(sent?.sessionId).toBe('spec-1')
      expect(sent?.text.startsWith('/speckit-specify Feature 4711: Checkout v2')).toBe(true)
      expect(sent?.text).toContain('- Version the cart: Reconcile by version. A late response never wins.')
      expect(sent?.text).toContain('    - Two adds keep both')
      expect(harness.watched).not.toContain('spec-1')
      expect(harness.changed).toContain(project.id)

      Object.assign(harness.manager, { workdirFor: (id: string) => (id === 'spec-1' ? dir : undefined) })
      await expect(harness.flow.writeSpec(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
      expect(backgroundSessionFor).toHaveBeenCalledTimes(1)

      Object.assign(harness.manager, { workdirFor: () => undefined })
      backgroundSessionFor.mockResolvedValueOnce({ id: 'spec-2' })
      expect((await harness.flow.writeSpec(run.id)).specSessionId).toBe('spec-2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
