import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowGit } from '@main/flow/flow-supervisor'
import type { FlowStageMarker } from '@main/flow/flow-markers'
import type { FlowStage } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { FlowSupervisor } = await import('@main/flow/flow-supervisor')

type Repos = ReturnType<typeof createRepositories>

function fakeGit(): FlowGit {
  return {
    create: vi.fn(async (input) => ({
      path: input.path,
      branch: input.branch,
      head: 'abc123',
      locked: false,
      prunable: false,
    })),
    remove: vi.fn(async () => ({ removed: true, dirty: [] })),
    branch: vi.fn(async () => 'main'),
    root: vi.fn((projectPath: string, override?: string | null) => override || `${projectPath}.worktrees`),
    uniqueBranch: vi.fn(async (_repo: string, title: string) => `feature/${title.toLowerCase().replace(/\s+/g, '-')}`),
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
    }
  }
})

function dotnetProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-sup-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'App.sln'), '')
  return dir
}

function setup(options?: { ado?: boolean; projectPath?: string }) {
  const repos: Repos = createRepositories(openDatabase(':memory:'))
  const project = repos.projects.insert({
    name: 'alpha',
    path: options?.projectPath ?? dotnetProject(),
    source: 'manual',
  })
  const sent: { sessionId: string; text: string }[] = []
  const watched: string[] = []
  const changed: string[] = []
  const interrupted: string[] = []
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
    interruptSession: vi.fn(async (sessionId: string) => {
      interrupted.push(sessionId)
      return { stillQueued: 0 }
    }),
    workdirFor: (sessionId: string) => (sessionId.startsWith('session-') ? 'C:\\work\\alpha' : undefined),
  }

  const git = fakeGit()
  const flow = new FlowSupervisor(repos, manager as never, { onFlowChanged: (id) => changed.push(id) }, git)

  return { repos, project, flow, manager, git, sent, watched, changed, interrupted }
}

const textSource = (title = 'Checkout v2', description = 'Let a guest pay.'): FlowStartSource => ({
  kind: 'text',
  title,
  description,
})

function sessionOf(h: ReturnType<typeof setup>, runId: string, stage?: FlowStage): string {
  const run = h.repos.flowRuns.byId(runId)!
  const row = h.repos.flowStages.get(runId, stage ?? run.stage)
  if (!row?.sessionId) throw new Error(`no session for ${runId}/${stage ?? run.stage}`)
  return row.sessionId
}

describe('starting a run', () => {
  it('detects the stacks, makes a worktree, and begins the spec stage', async () => {
    const h = setup()
    const run = await h.flow.start({
      projectId: h.project.id,
      source: textSource(),
      autopilot: false,
      autoShip: false,
    })

    expect(run.stage).toBe('spec')
    expect(run.status).toBe('running')
    expect(run.branch).toBe('feature/checkout-v2')
    expect(run.baseBranch).toBe('main')
    expect(h.git.create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: h.project.path, branch: 'feature/checkout-v2', base: 'main' }),
    )
    expect(h.manager.startSession).toHaveBeenCalledWith(
      h.project.id,
      false,
      h.project.defaultSessionMode,
      undefined,
      expect.objectContaining({ background: true, engine: 'claude', cwd: run.worktreePath }),
    )
    expect(h.watched).toEqual([sessionOf(h, run.id)])
    expect(h.sent[0].text).toContain('/speckit-specify Checkout v2: Let a guest pay.')
    expect(h.changed).toContain(h.project.id)

    const stages = h.repos.flowStages.listForRun(run.id)
    expect(stages.find((s) => s.stage === 'spec')?.status).toBe('running')
    expect(stages.find((s) => s.stage === 'spec')?.attempts).toBe(1)
  })

  it('refuses a project with neither a .NET nor an Angular project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sup-'))
    try {
      const h = setup({ projectPath: dir })
      await expect(
        h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
      expect(h.git.create).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checks Azure DevOps connectivity for an ado source, failing the spec stage rather than refusing outright', async () => {
    const h = setup({ ado: false })
    const run = await h.flow.start({
      projectId: h.project.id,
      source: { kind: 'ado', featureId: '4711', featureTitle: 'Checkout v2', url: null },
      autopilot: false,
      autoShip: false,
    })
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.repos.flowRuns.byId(run.id)?.status).toBe('waiting')
  })

  it('starts a spec-sourced run at build when tasks.md already exists in the copied folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sup-'))
    try {
      mkdirSync(join(dir, 'Api'))
      writeFileSync(join(dir, 'Api', 'App.csproj'), '')
      mkdirSync(join(dir, '.specify'))
      mkdirSync(join(dir, 'specs', '001-cart'), { recursive: true })
      writeFileSync(join(dir, 'specs', '001-cart', 'spec.md'), '# Cart\n')
      writeFileSync(join(dir, 'specs', '001-cart', 'tasks.md'), '- [ ] T001 do it\n')

      const h = setup({ projectPath: dir })
      const run = await h.flow.start({
        projectId: h.project.id,
        source: { kind: 'spec', specId: '001-cart' },
        autopilot: false,
        autoShip: false,
      })

      expect(run.stage).toBe('build')
      expect(run.specDir).toBe('specs/001-cart')
      const stages = h.repos.flowStages.listForRun(run.id)
      expect(stages.find((s) => s.stage === 'spec')?.status).toBe('skipped')
      expect(stages.find((s) => s.stage === 'plan')?.status).toBe('skipped')
      expect(stages.find((s) => s.stage === 'build')?.status).toBe('running')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function specMarker(overrides: Partial<FlowStageMarker> = {}): FlowStageMarker {
  return {
    kind: 'stage',
    stage: 'spec',
    outcome: 'done',
    summary: 'Wrote the spec.',
    why: null,
    specDir: 'specs/001-checkout',
    tasksDone: null,
    tasksTotal: null,
    verdict: null,
    findings: [],
    unmet: [],
    prUrl: null,
    prId: null,
    ...overrides,
  }
}

describe('turn-by-turn steps', () => {
  it('sends the next queued step when a turn ends, and stops once the marker resolves the stage', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const sid = sessionOf(h, run.id)
    expect(h.sent).toHaveLength(1)

    h.flow.onTurnEnded(sid)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toContain('/speckit-clarify')

    h.flow.onTurnEnded(sid)
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2].text).toContain('SWB_FLOW:')

    h.flow.onFlowMarker(sid, specMarker())
    h.flow.onTurnEnded(sid)
    expect(h.sent).toHaveLength(3)
  })
})

describe('a stage marker resolving the stage', () => {
  it('moves a done outcome to review and waits for approval without autopilot', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())

    const after = h.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('waiting')
    expect(after?.specDir).toBe('specs/001-checkout')
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('review')
  })

  it('fails the stage on a blocked outcome, with no automatic retry', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: true, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ outcome: 'blocked', why: 'no ado server' }))

    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'spec')?.summary).toBe('no ado server')
    expect(h.repos.flowRuns.byId(run.id)?.status).toBe('waiting')
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
  })

  it('ignores a marker from a session that is not tracked as a stage session', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker('stranger', specMarker())
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
  })
})

describe('turn ended or session ended without a handshake', () => {
  it('fails the stage and retries once automatically under autopilot', async () => {
    const h = setup({ ado: false })
    const run = await h.flow.start({
      projectId: h.project.id,
      source: textSource(),
      autopilot: true,
      autoShip: false,
    })
    const sid = sessionOf(h, run.id)
    h.flow.onTurnEnded(sid)
    h.flow.onTurnEnded(sid)
    h.flow.onTurnEnded(sid)

    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running'))
    expect(h.repos.flowStages.get(run.id, 'spec')?.attempts).toBe(2)
    expect(h.manager.startSession).toHaveBeenCalledTimes(2)
  })

  it('does not retry a second time', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: true, autoShip: false })
    const first = sessionOf(h, run.id)
    h.flow.onTurnEnded(first)
    h.flow.onTurnEnded(first)
    h.flow.onTurnEnded(first)
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'spec')?.sessionId).not.toBe(first))
    const second = h.repos.flowStages.get(run.id, 'spec')!.sessionId!
    h.flow.onTurnEnded(second)
    h.flow.onTurnEnded(second)
    h.flow.onTurnEnded(second)

    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.manager.startSession).toHaveBeenCalledTimes(2)
  })

  it('does the same for a true session exit, without autopilot', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onSessionEnded(sessionOf(h, run.id), 'crashed')

    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'spec')?.summary).toBe('The session ended before this stage reported.')
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
  })
})

describe('the test stage', () => {
  async function toTestStage(autopilot = false) {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot, autoShip: false })
    for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
      const sid = h.repos.flowStages.get(run.id, stage)!.sessionId!
      h.flow.onFlowMarker(sid, specMarker({ stage, specDir: 'specs/001-checkout' }))
      await h.flow.approve(run.id)
    }
    return h
  }

  it('passes when every reported suite passed', async () => {
    const h = await toTestStage()
    const run = h.repos.flowRuns.listForProject(h.project.id)[0]
    const sid = h.repos.flowStages.get(run.id, 'test')!.sessionId!

    h.flow.onVerifyReport(sid, {
      suites: [{ id: 'dotnet-unit', label: 'Unit tests', status: 'pass', detail: '42 passed' }],
      coverage: { line: { value: null, source: null }, changed: { value: null, source: null }, files: [] },
      quality: {
        gate: null,
        gateSource: null,
        duplication: { value: null, source: null },
        debt: null,
        mutation: { value: null, source: null },
        mutationKilled: null,
        mutationSurvived: null,
        survivors: [],
        archViolations: { value: null, source: null },
        findings: [],
      },
      evidence: [],
      endpoints: [],
    })

    expect(h.repos.flowStages.get(run.id, 'test')?.status).toBe('review')
    expect(h.repos.flowRuns.byId(run.id)?.status).toBe('waiting')
  })

  it('fails, naming the suites that failed', async () => {
    const h = await toTestStage()
    const run = h.repos.flowRuns.listForProject(h.project.id)[0]
    const sid = h.repos.flowStages.get(run.id, 'test')!.sessionId!

    h.flow.onVerifyReport(sid, {
      suites: [
        { id: 'dotnet-unit', label: 'Unit tests', status: 'pass', detail: 'ok' },
        { id: 'dotnet-format', label: 'Format', status: 'fail', detail: '3 files unformatted' },
      ],
      coverage: { line: { value: null, source: null }, changed: { value: null, source: null }, files: [] },
      quality: {
        gate: null,
        gateSource: null,
        duplication: { value: null, source: null },
        debt: null,
        mutation: { value: null, source: null },
        mutationKilled: null,
        mutationSurvived: null,
        survivors: [],
        archViolations: { value: null, source: null },
        findings: [],
      },
      evidence: [],
      endpoints: [],
    })

    expect(h.repos.flowStages.get(run.id, 'test')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'test')?.summary).toContain('dotnet-format')
  })
})

describe('approve, retry and skip', () => {
  it('approve starts the next stage with a fresh session', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())

    const after = await h.flow.approve(run.id)

    expect(after.stage).toBe('plan')
    expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running')
    expect(h.manager.startSession).toHaveBeenCalledTimes(2)
  })

  it('refuses to approve a stage that is not waiting for it', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await expect(h.flow.approve(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
  })

  it('approving the ship stage finishes the run', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    let current = run
    for (const stage of ['spec', 'plan', 'build', 'clean', 'test', 'review'] as const) {
      const sid = h.repos.flowStages.get(current.id, stage)!.sessionId!
      h.flow.onFlowMarker(sid, specMarker({ stage, specDir: 'specs/001-checkout' }))
      current = await h.flow.approve(current.id)
    }
    expect(current.stage).toBe('ship')
    expect(current.status).toBe('waiting')
    expect(h.repos.flowStages.get(current.id, 'ship')?.status).toBe('pending')

    const shipped = await h.flow.ship(current.id)
    expect(h.repos.flowStages.get(shipped.id, 'ship')?.status).toBe('running')
    const sid = h.repos.flowStages.get(shipped.id, 'ship')!.sessionId!
    h.flow.onFlowMarker(sid, specMarker({ stage: 'ship', prUrl: 'https://x/pr/1', prId: '1' }))
    const done = await h.flow.approve(shipped.id)
    expect(done.status).toBe('done')
    expect(done.finishedAt).not.toBeNull()
  })

  it('retry only applies to a failed stage, and starts a fresh session', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await expect(h.flow.retry(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })

    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ outcome: 'blocked', why: 'bad' }))
    const after = await h.flow.retry(run.id)
    expect(after.stage).toBe('spec')
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
    expect(h.repos.flowStages.get(run.id, 'spec')?.attempts).toBe(2)
  })

  it('skip moves past a stage without running it, and skipping ship finishes the run', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())
    await h.flow.skip(run.id)
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('skipped')

    let current = h.repos.flowRuns.byId(run.id)!
    expect(current.stage).toBe('plan')
    for (let i = 0; i < 5; i += 1) {
      current = await h.flow.skip(current.id)
    }
    expect(current.stage).toBe('ship')
    current = await h.flow.skip(current.id)
    expect(current.status).toBe('done')
  })
})

describe('fix and revise', () => {
  async function toReview(h: ReturnType<typeof setup>, run: Awaited<ReturnType<typeof h.flow.start>>) {
    let current = run
    for (const stage of ['spec', 'plan', 'build', 'clean', 'test'] as const) {
      const sid = h.repos.flowStages.get(current.id, stage)!.sessionId!
      h.flow.onFlowMarker(sid, specMarker({ stage, specDir: 'specs/001-checkout' }))
      current = await h.flow.approve(current.id)
    }
    return current
  }

  it('fix only applies to the review stage, and re-sends the review handshake', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await expect(h.flow.fix(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })

    const atReview = await toReview(h, run)
    const sid1 = h.repos.flowStages.get(atReview.id, 'review')!.sessionId!
    h.flow.onFlowMarker(sid1, specMarker({ stage: 'review', verdict: 'needs_fixes', unmet: ['x'] }))

    await h.flow.fix(atReview.id)
    expect(h.repos.flowStages.get(atReview.id, 'review')?.status).toBe('running')
    expect(h.sent.at(-1)?.text).toContain('Fix every must_fix finding')
  })

  it('revise sends feedback and re-runs the same stage handshake', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())

    await h.flow.revise(run.id, 'Cover the guest checkout path too.')
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
    expect(h.repos.flowStages.get(run.id, 'spec')?.feedback).toBe('Cover the guest checkout path too.')
    expect(h.sent.at(-1)?.text).toContain('Revise the spec per this feedback')
  })

  it('autopilot fixes up to two rounds, then leaves it for a human', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: true, autoShip: false })

    const runId = run.id
    const order = ['spec', 'plan', 'build', 'clean', 'test', 'review'] as const
    for (let i = 0; i < order.length - 1; i += 1) {
      const stage = order[i]
      const next = order[i + 1]
      const sid = h.repos.flowStages.get(runId, stage)!.sessionId!
      h.flow.onFlowMarker(sid, specMarker({ stage, specDir: 'specs/001-checkout' }))
      await vi.waitFor(() => expect(h.repos.flowStages.get(runId, next)?.sessionId).toBeTruthy())
    }
    const atReview = h.repos.flowRuns.byId(runId)!
    expect(atReview.stage).toBe('review')

    for (let round = 0; round < 3; round += 1) {
      const sid = h.repos.flowStages.get(atReview.id, 'review')!.sessionId!
      const attemptsBefore = h.repos.flowStages.get(atReview.id, 'review')!.attempts
      h.flow.onFlowMarker(sid, specMarker({ stage: 'review', verdict: 'needs_fixes', unmet: ['x'] }))
      if (round < 2) {
        await vi.waitFor(() =>
          expect(h.repos.flowStages.get(atReview.id, 'review')!.attempts).toBe(attemptsBefore + 1),
        )
      }
    }

    const stage = h.repos.flowStages.get(atReview.id, 'review')!
    expect(stage.status).toBe('review')
    expect(stage.attempts).toBe(3)
  })
})

describe('cancel, autopilot and worktree removal', () => {
  it('interrupts the running session and marks the run cancelled', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const after = await h.flow.cancel(run.id)

    expect(after.status).toBe('cancelled')
    expect(after.note).toBe('You stopped this flow.')
    expect(h.interrupted).toEqual([sessionOf(h, run.id)])
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
  })

  it('setAutopilot toggles the flag and reports the change', () => {
    const h = setup()
    const project = h.repos.projects.byId(h.project.id)!
    const run = h.repos.flowRuns.start({
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

    const after = h.flow.setAutopilot(run.id, true)
    expect(after.autopilot).toBe(true)
    expect(h.changed).toContain(project.id)
  })

  it('removes a clean worktree and clears the path', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const after = await h.flow.removeWorktree(run.id, false)
    expect(after.worktreePath).toBeNull()
  })

  it('refuses a dirty worktree without force', async () => {
    const h = setup()
    h.git.remove = vi.fn(async () => ({ removed: false, dirty: ['?? scratch.txt'] }))
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await expect(h.flow.removeWorktree(run.id, false)).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  })
})

describe('reconcile on startup', () => {
  it('fails whatever stage was mid-flight when the app last closed', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.changed.length = 0

    h.flow.reconcileOnStartup()

    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.repos.flowRuns.byId(run.id)?.status).toBe('waiting')
    expect(h.changed).toContain(h.project.id)
  })
})
