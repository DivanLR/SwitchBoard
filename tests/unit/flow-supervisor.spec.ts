import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowGit } from '@main/flow/flow-supervisor'
import type { FlowStageMarker } from '@main/flow/flow-markers'
import type { FlowStage, FlowStageAction, FlowStageStatus } from '@shared/domain'
import { FLOW_STAGES, emptyFlowStageReport, flowStageActions } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { FlowSupervisor } = await import('@main/flow/flow-supervisor')

type Repos = ReturnType<typeof createRepositories>

function fakeGit(): FlowGit {
  return {
    create: vi.fn(async (input) => {
      const slug = input.title.toLowerCase().replace(/\s+/g, '-')
      const path = join(input.root, slug)
      mkdirSync(join(path, 'specs', '001-checkout'), { recursive: true })
      writeFileSync(join(path, 'specs', '001-checkout', 'spec.md'), '# Checkout\n')
      return { path, branch: `feature/${slug}`, head: 'abc123', locked: false, prunable: false }
    }),
    remove: vi.fn(async () => ({ removed: true, dirty: [] })),
    branch: vi.fn<FlowGit['branch']>(async () => 'main'),
    root: vi.fn((projectPath: string, override?: string | null) => override || join(projectPath, '.worktrees')),
    resolves: vi.fn(async () => true),
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

function specProject(): string {
  const dir = dotnetProject()
  mkdirSync(join(dir, '.specify', 'scripts'), { recursive: true })
  writeFileSync(join(dir, '.specify', 'feature.json'), JSON.stringify({ feature_directory: 'specs/004-orders', pinned: 1 }))
  mkdirSync(join(dir, 'specs', '001-cart'), { recursive: true })
  writeFileSync(join(dir, 'specs', '001-cart', 'spec.md'), '# Cart\n')
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
  const ended: string[] = []
  const stopped: string[] = []
  let sessionCount = 0

  const manager = {
    startSession: vi.fn(async () => {
      sessionCount += 1
      return { id: `session-${sessionCount}` }
    }),
    connectedMcpServers: vi.fn(async (_sessionId: string, wanted: readonly string[]) =>
      options?.ado === false ? [] : [...wanted],
    ),
    sendMessage: (sessionId: string, text: string) => sent.push({ sessionId, text }),
    watchFlow: (sessionId: string) => watched.push(sessionId),
    endFlowSession: (sessionId: string) => ended.push(sessionId),
    stopSession: vi.fn(async (sessionId: string) => {
      stopped.push(sessionId)
    }),
    markSection: vi.fn(),
    renameSession: vi.fn(),
  }

  const git = fakeGit()
  const flow = new FlowSupervisor(repos, manager as never, { onFlowChanged: (id) => changed.push(id) }, git)

  return { repos, project, flow, manager, git, sent, watched, changed, ended, stopped }
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
      expect.objectContaining({ repoRoot: h.project.path, title: 'Checkout v2', base: 'main' }),
    )
    expect(h.manager.startSession).toHaveBeenCalledWith(
      h.project.id,
      false,
      h.project.defaultSessionMode,
      undefined,
      expect.objectContaining({ background: true, cwd: run.worktreePath }),
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

  it('refuses a spec id that is not one of the spec folders, before making a worktree', async () => {
    const h = setup({ projectPath: specProject() })
    for (const specId of ['..', '../..', '', '002-missing', '001-cart/..']) {
      await expect(
        h.flow.start({ projectId: h.project.id, source: { kind: 'spec', specId }, autopilot: false, autoShip: false }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(h.git.create).not.toHaveBeenCalled()
  })

  it('copies an untracked .specify into the worktree alongside the spec folder', async () => {
    const h = setup({ projectPath: specProject() })
    const run = await h.flow.start({
      projectId: h.project.id,
      source: { kind: 'spec', specId: '001-cart' },
      autopilot: false,
      autoShip: false,
    })
    expect(existsSync(join(run.worktreePath!, '.specify', 'scripts'))).toBe(true)
    expect(existsSync(join(run.worktreePath!, 'specs', '001-cart', 'spec.md'))).toBe(true)
  })

  it('refuses a base branch that starts with a dash or does not resolve, before making a worktree', async () => {
    const h = setup()
    await expect(
      h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false, baseBranch: '--no-checkout' }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' })
    h.git.resolves = vi.fn(async () => false)
    await expect(
      h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false, baseBranch: 'nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(h.git.create).not.toHaveBeenCalled()
  })

  it('refuses a detached HEAD without a named base branch, and accepts one with it', async () => {
    const h = setup()
    h.git.branch = vi.fn(async () => null)
    await expect(
      h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH', message: expect.stringContaining('detached HEAD') })
    const run = await h.flow.start({
      projectId: h.project.id,
      source: textSource(),
      autopilot: false,
      autoShip: false,
      baseBranch: 'release/1.2',
    })
    expect(run.baseBranch).toBe('release/1.2')
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
    expect(h.ended).toEqual([sessionOf(h, run.id)])
  })

  it('fails the stage on a blocked outcome, with no automatic retry', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: true, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ outcome: 'blocked', why: 'no ado server' }))

    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'spec')?.summary).toBe('no ado server')
    expect(h.repos.flowRuns.byId(run.id)?.status).toBe('waiting')
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
    expect(h.ended).toEqual([sessionOf(h, run.id)])
  })

  it('ignores a marker from a session that is not tracked as a stage session', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker('stranger', specMarker())
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
  })
})

describe('a turn that ends in an error', () => {
  it('sends the same step once more, then fails the stage with the error instead of moving on', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: true, autoShip: false })
    const sid = sessionOf(h, run.id)
    const first = h.sent[0].text

    h.flow.onTurnEnded(sid, 'Usage limit reached')
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toBe(first)

    h.flow.onTurnEnded(sid, 'Usage limit reached')
    expect(h.sent).toHaveLength(2)
    const row = h.repos.flowStages.get(run.id, 'spec')!
    expect(row.status).toBe('failed')
    expect(row.summary).toContain('Usage limit reached')
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
  })

  it('carries on with the next step once the resent step succeeds', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const sid = sessionOf(h, run.id)
    h.flow.onTurnEnded(sid, 'error_during_execution')
    h.flow.onTurnEnded(sid)
    expect(h.sent[2].text.startsWith('/speckit-clarify')).toBe(true)
  })
})

describe('the Feature list', () => {
  it('fails at once when the turn ends without a features marker', async () => {
    const h = setup()
    const listing = h.flow.features(h.project.id, '', 60_000)
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    h.flow.onTurnEnded(h.sent[0].sessionId)
    await expect(listing).rejects.toMatchObject({ code: 'NOT_LIVE' })
    expect(h.ended).toEqual([h.sent[0].sessionId])
  })
})

describe('the stage sessions', () => {
  it('run only the build stage at max effort, and give the ship stage the merge and reviewer guard', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    for (const stage of ['spec', 'plan', 'build', 'clean', 'test', 'review'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage }))
      await h.flow.approve(run.id)
    }
    await h.flow.ship(run.id)
    const opts = h.manager.startSession.mock.calls.map((call) => (call as unknown[])[4] as Record<string, unknown>)
    expect(opts.map((o) => o.effort)).toEqual([undefined, undefined, 'max', undefined, undefined, undefined, undefined])
    expect(opts.map((o) => o.section)).toEqual(Array(7).fill('flow'))
    expect(opts.slice(0, 6).every((o) => o.denyTool === undefined)).toBe(true)
    const guard = opts[6].denyTool as (tool: string, input: unknown) => string | null
    expect(guard('Bash', { command: 'gh pr merge 12 --squash' })).toContain('left to a person')
    expect(guard('Bash', { command: 'gh pr create --base main --fill' })).toBeNull()
  })
})

describe('the spec folder', () => {
  it('takes specDir from the worktree feature.json after the spec stage, and keeps none without a spec.md', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const wt = run.worktreePath!
    mkdirSync(join(wt, '.specify'), { recursive: true })
    mkdirSync(join(wt, 'specs', '007-real'), { recursive: true })
    writeFileSync(join(wt, 'specs', '007-real', 'spec.md'), '# Real\n')
    writeFileSync(join(wt, '.specify', 'feature.json'), JSON.stringify({ feature_directory: join(wt, 'specs', '007-real') }))
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ specDir: 'specs/001-checkout/spec.md' }))
    expect(h.repos.flowRuns.byId(run.id)?.specDir).toBe('specs/007-real')

    const other = await h.flow.start({ projectId: h.project.id, source: textSource('Loyalty'), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, other.id), specMarker({ specDir: 'specs/404-missing' }))
    expect(h.repos.flowRuns.byId(other.id)?.specDir).toBeNull()
  })

  it('pins a run from an existing spec to that spec in feature.json and names it in the plan steps', async () => {
    const h = setup({ projectPath: specProject() })
    const run = await h.flow.start({
      projectId: h.project.id,
      source: { kind: 'spec', specId: '001-cart' },
      autopilot: false,
      autoShip: false,
    })
    const pinned = JSON.parse(readFileSync(join(run.worktreePath!, '.specify', 'feature.json'), 'utf8'))
    expect(pinned).toEqual({ feature_directory: 'specs/001-cart', pinned: 1 })
    expect(h.sent[0].text.startsWith('/speckit-plan ')).toBe(true)
    expect(h.sent[0].text).toContain('specs/001-cart')
  })
})

describe('the test stage plan', () => {
  it('plans from the detection the Tests section uses, with the project overrides and database servers', async () => {
    const dir = dotnetProject()
    writeFileSync(join(dir, 'angular.json'), '{"projects":{}}')
    const h = setup({ projectPath: dir })
    h.repos.settings.set({
      projectSuiteCommands: { [h.project.id]: { 'dotnet-unit': 'dotnet test Only.sln' } },
      databaseMcpServers: ['oracle'],
    })
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    writeFileSync(join(run.worktreePath!, 'App.sln'), '')
    writeFileSync(join(run.worktreePath!, 'angular.json'), '{"projects":{}}')
    writeFileSync(join(run.worktreePath!, 'package.json'), '{"devDependencies":{}}')
    writeFileSync(join(run.worktreePath!, 'Program.cs'), 'app.MapControllers();')
    for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage }))
      await h.flow.approve(run.id)
    }
    const sid = sessionOf(h, run.id, 'test')
    h.flow.onTurnEnded(sid)
    const verify = h.sent.at(-1)!.text
    expect(verify).toContain('- dotnet-unit (Unit tests): dotnet test Only.sln')
    expect(verify).toContain('ng-unit')
    expect(verify).not.toContain('ng-lint')
    expect(verify).not.toContain('ng-e2e')
    expect(verify).toContain('connected database MCP server(s): oracle')
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
    expect(h.ended).toContain(sid)
  })

  it('says the stage finished without reporting, not that the session ended', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const sid = sessionOf(h, run.id)
    h.flow.onTurnEnded(sid)
    h.flow.onTurnEnded(sid)
    h.flow.onTurnEnded(sid)

    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'spec')?.summary).toBe('The stage finished without reporting its result.')
    expect(h.ended).toEqual([sid])
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
    expect(h.ended).toContain(sid)
  })

  it('ends the test session once its report lands', async () => {
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
    expect(h.ended).toContain(sid)
  })

  it('says the verification step returned no report when the test turns end without one', async () => {
    const h = await toTestStage()
    const run = h.repos.flowRuns.listForProject(h.project.id)[0]
    const sid = h.repos.flowStages.get(run.id, 'test')!.sessionId!
    h.flow.onTurnEnded(sid)
    h.flow.onTurnEnded(sid)

    expect(h.repos.flowStages.get(run.id, 'test')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'test')?.summary).toBe('The verification step did not return a report.')
  })
})

describe('approve, retry and skip', () => {
  it('approve ends the stage session and starts the next stage with a fresh one', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const specSession = sessionOf(h, run.id)
    h.flow.onFlowMarker(specSession, specMarker())
    h.ended.length = 0

    const after = await h.flow.approve(run.id)

    expect(after.stage).toBe('plan')
    expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running')
    expect(sessionOf(h, run.id)).not.toBe(specSession)
    expect(h.ended).toContain(specSession)
    expect(h.manager.startSession).toHaveBeenCalledTimes(2)
  })

  it('skip stops a running stage session at once and ends it', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const specSession = sessionOf(h, run.id)

    await h.flow.skip(run.id)

    expect(h.stopped).toEqual([specSession])
    expect(h.ended).toContain(specSession)
    h.flow.onTurnEnded(specSession)
    expect(h.sent.filter((send) => send.sessionId === specSession)).toHaveLength(1)
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

    const failed = sessionOf(h, run.id)
    h.flow.onFlowMarker(failed, specMarker({ outcome: 'blocked', why: 'bad' }))
    h.ended.length = 0
    const after = await h.flow.retry(run.id)
    expect(after.stage).toBe('spec')
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
    expect(h.repos.flowStages.get(run.id, 'spec')?.attempts).toBe(2)
    expect(sessionOf(h, run.id)).not.toBe(failed)
    expect(h.ended).toEqual([failed])
  })

  it('fails the stage with the reason when its session cannot start, so Retry is offered', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())
    h.manager.startSession.mockRejectedValueOnce({ code: 'NOT_FOUND', message: 'Claude Code was not found.' })

    const after = await h.flow.approve(run.id)

    expect(after.stage).toBe('plan')
    expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'plan')?.summary).toBe('Claude Code was not found.')
    await h.flow.retry(run.id)
    expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running')
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

  it('fix only applies to a review that needs fixes, and runs in a fresh session told every finding', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await expect(h.flow.fix(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })

    const atReview = await toReview(h, run)
    const sid1 = h.repos.flowStages.get(atReview.id, 'review')!.sessionId!
    h.flow.onFlowMarker(
      sid1,
      specMarker({
        stage: 'review',
        verdict: 'needs_fixes',
        findings: [
          { severity: 'must_fix', file: 'Cart.cs', line: 12, what: 'Off-by-one in the total.' },
          { severity: 'nit', file: null, line: null, what: 'Rename the helper.' },
        ],
        unmet: ['A guest can pay without an account.'],
      }),
    )
    h.ended.length = 0

    await h.flow.fix(atReview.id)
    const sid2 = h.repos.flowStages.get(atReview.id, 'review')!.sessionId!
    expect(h.repos.flowStages.get(atReview.id, 'review')?.status).toBe('running')
    expect(sid2).not.toBe(sid1)
    expect(h.ended).toEqual([sid1])
    const prompt = h.sent.at(-1)!
    expect(prompt.sessionId).toBe(sid2)
    expect(prompt.text).toContain('Fix every must_fix finding')
    expect(prompt.text).toContain('Cart.cs:12: Off-by-one in the total.')
    expect(prompt.text).toContain('A guest can pay without an account.')
    expect(prompt.text).toContain('specs/001-checkout/spec.md')
    expect(prompt.text).not.toContain('Rename the helper.')

    h.flow.onTurnEnded(sid2)
    expect(h.sent.at(-1)?.text).toContain('"stage":"review"')
  })

  it('refuses fix when the review found nothing to fix', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const atReview = await toReview(h, run)
    const sid = h.repos.flowStages.get(atReview.id, 'review')!.sessionId!
    h.flow.onFlowMarker(sid, specMarker({ stage: 'review', verdict: 'ready' }))
    await expect(h.flow.fix(atReview.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
  })

  it('revise runs in a fresh session told the artefact path and the feedback, then re-runs the handshake', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const first = sessionOf(h, run.id)
    h.flow.onFlowMarker(first, specMarker())
    h.ended.length = 0

    await h.flow.revise(run.id, 'Cover the guest checkout path too.')
    const second = sessionOf(h, run.id)
    expect(second).not.toBe(first)
    expect(h.ended).toEqual([first])
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
    expect(h.repos.flowStages.get(run.id, 'spec')?.feedback).toBe('Cover the guest checkout path too.')
    const prompt = h.sent.at(-1)!
    expect(prompt.sessionId).toBe(second)
    expect(prompt.text).toContain('Revise the spec (specs/001-checkout/spec.md) per this feedback')
    expect(prompt.text).toContain('Cover the guest checkout path too.')

    h.flow.onTurnEnded(second)
    expect(h.sent.at(-1)?.text).toContain('"stage":"spec"')
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
  it('stops and ends the running session and marks the run cancelled', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    const after = await h.flow.cancel(run.id)

    expect(after.status).toBe('cancelled')
    expect(after.note).toBe('You stopped this flow.')
    expect(h.stopped).toEqual([sessionOf(h, run.id)])
    expect(h.ended).toEqual([sessionOf(h, run.id)])
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('failed')
  })

  it('ends a waiting stage session on cancel without stopping it twice', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())
    await h.flow.cancel(run.id)

    expect(h.stopped).toEqual([])
    expect(h.ended).toContain(sessionOf(h, run.id))
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('review')
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

  it('refuses to remove the worktree of a run that still uses it', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await expect(h.flow.removeWorktree(run.id, true)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
    expect(h.git.remove).not.toHaveBeenCalled()
  })

  it('removes a clean worktree of a finished run and clears the path', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await h.flow.cancel(run.id)
    const after = await h.flow.removeWorktree(run.id, false)
    expect(after.worktreePath).toBeNull()
  })

  it('refuses a dirty worktree without force', async () => {
    const h = setup()
    h.git.remove = vi.fn(async () => ({ removed: false, dirty: ['?? scratch.txt'] }))
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    await h.flow.cancel(run.id)
    await expect(h.flow.removeWorktree(run.id, false)).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  })
})

describe('every stage status and action against the supervisor', () => {
  const STATUSES: readonly FlowStageStatus[] = ['pending', 'running', 'review', 'approved', 'skipped', 'failed']
  const ACTIONS: readonly FlowStageAction[] = ['approve', 'fix', 'revise', 'retry', 'ship', 'skip']

  function seed(h: ReturnType<typeof setup>, stage: FlowStage, status: FlowStageStatus, verdict: 'ready' | 'needs_fixes' | null) {
    const run = h.repos.flowRuns.start({
      projectId: h.project.id,
      title: `${stage} ${status}`,
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: '',
      stacks: ['dotnet'],
      stage,
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })
    h.repos.flowStages.ensureAll(run.id)
    h.repos.flowRuns.update(run.id, { worktreePath: h.project.path, specDir: 'specs/001-checkout' })
    h.repos.flowStages.update(run.id, stage, {
      status,
      sessionId: 'seeded-session',
      attempts: 1,
      report: verdict ? { ...emptyFlowStageReport(), verdict } : null,
    })
    return h.repos.flowRuns.byId(run.id)!
  }

  async function accepted(h: ReturnType<typeof setup>, runId: string, action: FlowStageAction): Promise<boolean> {
    try {
      if (action === 'revise') await h.flow.revise(runId, 'Change it.')
      else await h.flow[action](runId)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'RULE_NOT_ALLOWED') return false
      throw error
    }
  }

  it('accepts exactly the actions the stage card offers for the current stage', async () => {
    const h = setup()
    for (const stage of FLOW_STAGES) {
      const verdicts = stage === 'review' ? (['ready', 'needs_fixes', null] as const) : ([null] as const)
      for (const status of STATUSES) {
        for (const verdict of verdicts) {
          for (const action of ACTIONS) {
            const run = seed(h, stage, status, verdict)
            const offered = flowStageActions(run, h.repos.flowStages.get(run.id, stage)!).includes(action)
            expect(await accepted(h, run.id, action), `${stage} ${status} ${verdict ?? ''} ${action}`).toBe(offered)
          }
        }
      }
    }
  })

  it('offers the ship stage in review Finish and Revise only, and a finished run nothing', async () => {
    const h = setup()
    const ship = seed(h, 'ship', 'review', null)
    expect(flowStageActions(ship, h.repos.flowStages.get(ship.id, 'ship')!)).toEqual(['approve', 'revise'])

    const finished = await h.flow.approve(ship.id)
    expect(finished.status).toBe('done')
    for (const action of ACTIONS) expect(await accepted(h, ship.id, action)).toBe(false)
  })

  it('offers nothing for a stage that is not the current one', () => {
    expect(
      flowStageActions({ stage: 'plan', finishedAt: null }, { stage: 'spec', status: 'review', report: null }),
    ).toEqual([])
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
