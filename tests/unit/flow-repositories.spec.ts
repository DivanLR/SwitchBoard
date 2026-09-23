import { describe, expect, it } from 'vitest'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')

function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  const project = repos.projects.insert({ name: 'alpha', path: 'C:\\work\\alpha', source: 'manual' })
  return { repos, project }
}

describe('FlowRunsRepo round trip', () => {
  it('starts a run with every stage row pending', () => {
    const { repos, project } = setup()
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'Checkout v2',
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: 'Let a guest pay without an account.',
      stacks: ['dotnet', 'angular'],
      stage: 'spec',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })

    expect(run.status).toBe('running')
    expect(run.stacks).toEqual(['dotnet', 'angular'])
    expect(repos.flowRuns.byId(run.id)).toMatchObject({ title: 'Checkout v2', stage: 'spec' })

    const stages = repos.flowStages.ensureAll(run.id)
    expect(stages.map((s) => s.stage)).toEqual(['spec', 'plan', 'build', 'clean', 'test', 'review', 'ship'])
    expect(stages.every((s) => s.status === 'pending')).toBe(true)
  })

  it('updates scalar, boolean and json-ish fields, and bumps updatedAt', () => {
    const { repos, project } = setup()
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'X',
      source: 'ado',
      sourceRef: '4711',
      sourceUrl: 'https://x',
      description: '',
      stacks: ['dotnet'],
      stage: 'spec',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })

    repos.flowRuns.update(run.id, { branch: 'feature/x', worktreePath: 'C:\\wt\\x', autopilot: true })
    const after = repos.flowRuns.byId(run.id)
    expect(after?.branch).toBe('feature/x')
    expect(after?.worktreePath).toBe('C:\\wt\\x')
    expect(after?.autopilot).toBe(true)
    expect(after?.autoShip).toBe(false)
    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(run.updatedAt))
  })

  it('finishes a run with a status and a note', () => {
    const { repos, project } = setup()
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'X',
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: '',
      stacks: ['angular'],
      stage: 'spec',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })

    repos.flowRuns.finish(run.id, 'cancelled', 'You stopped this flow.')

    const after = repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('cancelled')
    expect(after?.note).toBe('You stopped this flow.')
    expect(after?.finishedAt).not.toBeNull()
  })

  it('keeps only the newest 20 finished runs per project', () => {
    const { repos, project } = setup()
    for (let i = 0; i < 25; i += 1) {
      const run = repos.flowRuns.start({
        projectId: project.id,
        title: `Run ${i}`,
        source: 'text',
        sourceRef: null,
        sourceUrl: null,
        description: '',
        stacks: ['dotnet'],
        stage: 'spec',
        autopilot: false,
        autoShip: false,
        baseBranch: 'main',
      })
      repos.flowRuns.finish(run.id, 'done', null)
    }
    expect(repos.flowRuns.listForProject(project.id)).toHaveLength(20)
  })

  it('never prunes a run that is unfinished or still owns its worktree', () => {
    const { repos, project } = setup()
    const start = (title: string) =>
      repos.flowRuns.start({
        projectId: project.id,
        title,
        source: 'text',
        sourceRef: null,
        sourceUrl: null,
        description: '',
        stacks: ['dotnet'],
        stage: 'spec',
        autopilot: false,
        autoShip: false,
        baseBranch: 'main',
      })
    const live = start('Still running')
    const owner = start('Finished, worktree kept')
    repos.flowRuns.update(owner.id, { worktreePath: 'C:\\repo.worktrees\\kept' })
    repos.flowRuns.finish(owner.id, 'done', null)
    for (let i = 0; i < 25; i += 1) repos.flowRuns.finish(start(`Run ${i}`).id, 'done', null)
    expect(repos.flowRuns.byId(live.id)).not.toBeNull()
    expect(repos.flowRuns.byId(owner.id)?.worktreePath).toBe('C:\\repo.worktrees\\kept')
  })
})

describe('FlowStagesRepo round trip', () => {
  it('updates a stage, including its JSON report', () => {
    const { repos, project } = setup()
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'X',
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: '',
      stacks: ['dotnet'],
      stage: 'review',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })
    repos.flowStages.ensureAll(run.id)

    repos.flowStages.update(run.id, 'review', {
      status: 'review',
      sessionId: 's-1',
      attempts: 1,
      summary: 'Reviewed the diff.',
      report: {
        tasksDone: null,
        tasksTotal: null,
        verdict: 'needs_fixes',
        findings: [{ severity: 'must_fix', file: 'Cart.cs', line: 12, what: 'no null check' }],
        unmet: ['Two fast adds keep both items'],
        prUrl: null,
        prId: null,
        verify: null,
      },
    })

    const stage = repos.flowStages.get(run.id, 'review')
    expect(stage?.status).toBe('review')
    expect(stage?.sessionId).toBe('s-1')
    expect(stage?.report?.verdict).toBe('needs_fixes')
    expect(stage?.report?.findings).toHaveLength(1)
  })

  it('cascades deletion when a run is pruned away', () => {
    const { repos, project } = setup()
    const runs = Array.from({ length: 21 }, (_, i) => {
      const run = repos.flowRuns.start({
        projectId: project.id,
        title: `Run ${i}`,
        source: 'text',
        sourceRef: null,
        sourceUrl: null,
        description: '',
        stacks: ['dotnet'],
        stage: 'spec',
        autopilot: false,
        autoShip: false,
        baseBranch: 'main',
      })
      repos.flowStages.ensureAll(run.id)
      repos.flowRuns.finish(run.id, 'done', null)
      return run
    })

    expect(repos.flowStages.listForRun(runs[0].id)).toEqual([])
    expect(repos.flowStages.listForRun(runs[20].id)).toHaveLength(7)
  })
})

describe('reconcileRunning', () => {
  it('fails a stage left running and moves its run to waiting', () => {
    const { repos, project } = setup()
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'X',
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: '',
      stacks: ['dotnet'],
      stage: 'build',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })
    repos.flowStages.ensureAll(run.id)
    repos.flowStages.update(run.id, 'build', { status: 'running', sessionId: 's-1', attempts: 1 })

    const affected = repos.flowRuns.reconcileRunning('Switchboard closed while this stage was running. Retry it.')

    expect(affected).toEqual([project.id])
    expect(repos.flowRuns.byId(run.id)?.status).toBe('waiting')
    expect(repos.flowStages.get(run.id, 'build')?.status).toBe('failed')
    expect(repos.flowStages.get(run.id, 'build')?.summary).toBe(
      'Switchboard closed while this stage was running. Retry it.',
    )
  })

  it('touches nothing when no stage is running', () => {
    const { repos, project } = setup()
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'X',
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: '',
      stacks: ['dotnet'],
      stage: 'spec',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })
    repos.flowStages.ensureAll(run.id)

    expect(repos.flowRuns.reconcileRunning('note')).toEqual([])
    expect(repos.flowRuns.byId(run.id)?.status).toBe('running')
  })
})
