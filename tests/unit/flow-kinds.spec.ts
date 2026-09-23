import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowGit } from '@main/flow/flow-supervisor'
import type { FlowStageMarker } from '@main/flow/flow-markers'
import type { FlowKind, FlowStage, FlowStageAction, FlowStageStatus } from '@shared/domain'
import { FLOW_KIND_STAGES, emptyFlowStageReport, flowStageActions, flowStagesOf } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { FlowSupervisor, MAX_CONVERGE_ROUNDS } = await import('@main/flow/flow-supervisor')

const WAIT = { timeout: 5000 }

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function project(options: { sln?: boolean; constitution?: boolean; extensions?: ('bug' | 'assess')[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-kind-'))
  tempDirs.push(dir)
  if (options.sln !== false) writeFileSync(join(dir, 'App.sln'), '')
  mkdirSync(join(dir, '.specify', 'memory'), { recursive: true })
  if (options.constitution !== false) write(dir, '.specify/memory/constitution.md', '# Shop Constitution\n')
  for (const name of options.extensions ?? []) {
    write(dir, `.specify/extensions/${name}/extension.yml`, `id: ${name}\n`)
    const commands = name === 'bug' ? ['assess', 'fix', 'test'] : ['intake', 'research', 'define', 'shape', 'decide']
    for (const c of commands) write(dir, `.claude/skills/speckit-${name}-${c}/SKILL.md`, `# ${c}\n`)
  }
  return dir
}

function fakeGit(): FlowGit {
  return {
    create: vi.fn(async (input) => {
      const path = join(input.root, input.title.toLowerCase().replace(/\s+/g, '-'))
      mkdirSync(path, { recursive: true })
      return { path, branch: `feature/${input.title.toLowerCase().replace(/\s+/g, '-')}`, head: 'abc', locked: false, prunable: false }
    }),
    remove: vi.fn(async () => ({ removed: true, dirty: [] })),
    branch: vi.fn<FlowGit['branch']>(async () => 'main'),
    root: vi.fn((projectPath: string, override?: string | null) => override || join(projectPath, '.worktrees')),
    resolves: vi.fn(async () => true),
    origin: vi.fn<FlowGit['origin']>(async () => 'git.example.internal'),
  }
}

function setup(path: string) {
  const repos = createRepositories(openDatabase(':memory:'))
  const proj = repos.projects.insert({ name: 'shop', path, source: 'manual' })
  const sent: { sessionId: string; text: string }[] = []
  let count = 0
  const manager = {
    startSession: vi.fn(async () => ({ id: `session-${++count}` })),
    connectedMcpServers: vi.fn(async (_id: string, wanted: readonly string[]) => [...wanted]),
    sendMessage: (sessionId: string, text: string) => sent.push({ sessionId, text }),
    watchFlow: vi.fn(),
    endFlowSession: vi.fn(),
    stopSession: vi.fn(async () => {}),
    renameSession: vi.fn(),
  }
  const git = fakeGit()
  const flow = new FlowSupervisor(repos, manager as never, { onFlowChanged: () => {} }, git)
  return { repos, project: proj, flow, manager, git, sent }
}

function marker(stage: FlowStage, overrides: Partial<FlowStageMarker> = {}): FlowStageMarker {
  return {
    kind: 'stage',
    stage,
    outcome: 'done',
    summary: `Did ${stage}.`,
    why: null,
    specDir: null,
    title: null,
    tasksDone: null,
    tasksTotal: null,
    verdict: null,
    findings: [],
    unmet: [],
    prUrl: null,
    prId: null,
    pullRequests: [],
    converged: null,
    result: null,
    decision: null,
    ...overrides,
  }
}

function sessionOf(h: ReturnType<typeof setup>, runId: string, stage: FlowStage): string {
  const id = h.repos.flowStages.get(runId, stage)?.sessionId
  if (!id) throw new Error(`no session for ${stage}`)
  return id
}

function textsTo(h: ReturnType<typeof setup>, sessionId: string): string[] {
  return h.sent.filter((s) => s.sessionId === sessionId).map((s) => s.text)
}

const bug = (title = 'Login times out', symptom = 'Login hangs after 30 seconds.', slug?: string): FlowStartSource => ({
  kind: 'bug',
  title,
  symptom,
  slug,
})

const idea = (title = 'Offline mode', text = 'Let users work offline.'): FlowStartSource => ({ kind: 'idea', title, idea: text })

describe('stage lists per kind', () => {
  it('gives each kind its own stages, and a run without a kind the feature pipeline', () => {
    expect(flowStagesOf('feature')).toEqual(['spec', 'plan', 'build', 'clean', 'test', 'review', 'ship'])
    expect(flowStagesOf('bug')).toEqual(['assess', 'fix', 'test', 'clean', 'review', 'ship'])
    expect(flowStagesOf('idea')).toEqual(['intake', 'research', 'define', 'shape', 'decide'])
    expect(flowStagesOf(undefined)).toEqual(flowStagesOf('feature'))
    expect(flowStagesOf(null)).toEqual(flowStagesOf('feature'))
  })

  it('stores each kind’s stage rows in order', () => {
    const repos = createRepositories(openDatabase(':memory:'))
    const proj = repos.projects.insert({ name: 'p', path: 'C:/p', source: 'manual' })
    for (const kind of ['feature', 'bug', 'idea'] as FlowKind[]) {
      const run = repos.flowRuns.start({
        projectId: proj.id,
        kind,
        title: kind,
        source: 'text',
        sourceRef: null,
        sourceUrl: null,
        description: '',
        stacks: [],
        stage: flowStagesOf(kind)[0],
        autopilot: false,
        autoShip: false,
        baseBranch: null,
      })
      expect(repos.flowStages.ensureAll(run.id).map((row) => row.stage)).toEqual(FLOW_KIND_STAGES[kind])
      expect(repos.flowRuns.byId(run.id)?.kind).toBe(kind)
    }
  })
})

describe('the action rule covers every kind', () => {
  const STATUSES: readonly FlowStageStatus[] = ['pending', 'running', 'review', 'approved', 'skipped', 'failed']
  const ACTIONS: readonly FlowStageAction[] = ['approve', 'fix', 'revise', 'retry', 'ship', 'skip', 'feature']

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

  it('lets the supervisor take exactly the actions flowStageActions offers, stage by stage, for bug and idea', async () => {
    const path = project({ extensions: ['bug', 'assess'] })
    const h = setup(path)
    for (const kind of ['bug', 'idea'] as FlowKind[]) {
      for (const stage of flowStagesOf(kind)) {
        for (const status of STATUSES) {
          for (const action of ACTIONS) {
            const run = h.repos.flowRuns.start({
              projectId: h.project.id,
              kind,
              slug: `${kind}-${stage}`,
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
            h.repos.flowRuns.update(run.id, { worktreePath: kind === 'idea' ? null : path })
            h.repos.flowStages.update(run.id, stage, { status, sessionId: 'seeded', attempts: 1 })
            const seeded = h.repos.flowRuns.byId(run.id)!
            const offered = flowStageActions(seeded, h.repos.flowStages.get(run.id, stage)!).includes(action)
            expect(await accepted(h, run.id, action), `${kind} ${stage} ${status} ${action}`).toBe(offered)
          }
        }
      }
    }
  })

  it('offers Start a feature only on a finished idea whose decision is go', () => {
    const decide = (decision: 'go' | 'kill' | null) => ({
      stage: 'decide' as const,
      status: 'approved' as const,
      report: { ...emptyFlowStageReport(), decision },
    })
    const done = { kind: 'idea' as const, stage: 'decide' as const, status: 'done' as const, finishedAt: 'now' }
    expect(flowStageActions(done, decide('go'))).toEqual(['feature'])
    expect(flowStageActions(done, decide('kill'))).toEqual([])
    expect(flowStageActions({ ...done, status: 'cancelled' }, decide('go'))).toEqual([])
    expect(flowStageActions({ ...done, kind: 'feature' }, decide('go'))).toEqual([])
    expect(
      flowStageActions({ kind: 'idea', stage: 'decide', finishedAt: null }, { ...decide(null), status: 'review' }),
    ).toEqual(['approve', 'revise'])
  })
})

describe('a feature run', () => {
  it('writes the constitution before the spec when the project has none, and only then', async () => {
    const h = setup(project({ constitution: false }))
    const run = await h.flow.start({ projectId: h.project.id, source: { kind: 'text', title: 'Cart', description: '' }, autopilot: true, autoShip: false })
    const texts = textsTo(h, sessionOf(h, run.id, 'spec'))
    expect(texts[0]).toMatch(/^\/speckit-constitution /)

    const h2 = setup(project())
    const run2 = await h2.flow.start({ projectId: h2.project.id, source: { kind: 'text', title: 'Cart', description: '' }, autopilot: true, autoShip: false })
    expect(textsTo(h2, sessionOf(h2, run2.id, 'spec'))[0]).toMatch(/^\/speckit-specify /)
  })

  it('treats a template constitution as none', async () => {
    const path = project({ constitution: false })
    write(path, '.specify/memory/constitution.md', '# [PROJECT_NAME] Constitution\n')
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: { kind: 'text', title: 'Cart', description: '' }, autopilot: false, autoShip: false })
    expect(textsTo(h, sessionOf(h, run.id, 'spec'))[0]).toMatch(/^\/speckit-constitution /)
  })

  async function atBuild(autopilot = false) {
    const h = setup(project())
    const run = await h.flow.start({ projectId: h.project.id, source: { kind: 'text', title: 'Cart', description: '' }, autopilot, autoShip: false })
    write(run.worktreePath!, 'specs/001-cart/spec.md', '# Cart\n')
    h.flow.onFlowMarker(sessionOf(h, run.id, 'spec'), marker('spec', { specDir: 'specs/001-cart' }))
    if (!autopilot) await h.flow.approve(run.id)
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running'), WAIT)
    h.flow.onFlowMarker(sessionOf(h, run.id, 'plan'), marker('plan'))
    if (!autopilot) await h.flow.approve(run.id)
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'build')?.status).toBe('running'), WAIT)
    await vi.waitFor(() => expect(textsTo(h, sessionOf(h, run.id, 'build'))).not.toHaveLength(0), WAIT)
    return { h, run, session: sessionOf(h, run.id, 'build') }
  }

  it('runs implement then /speckit-converge, and repeats both until converge reports Converged', async () => {
    const { h, run, session } = await atBuild()
    const first = textsTo(h, session)
    expect(first[0]).toMatch(/^\/speckit-implement-scaffold /)
    h.flow.onTurnEnded(session)
    expect(textsTo(h, session)[1]).toMatch(/^\/speckit-converge /)
    h.flow.onTurnEnded(session)
    expect(textsTo(h, session)[2]).toContain('"converged"')

    h.flow.onFlowMarker(session, marker('build', { converged: false }))
    h.flow.onFlowMarker(session, marker('build', { converged: false }))
    const row = h.repos.flowStages.get(run.id, 'build')!
    expect(row.status).toBe('running')
    expect(row.summary).toBe(`Converge round 1 appended unbuilt work, so round 2 of ${MAX_CONVERGE_ROUNDS} is running.`)
    h.flow.onTurnEnded(session)
    const round2 = textsTo(h, session)
    expect(round2).toHaveLength(4)
    expect(round2[3]).toMatch(/^\/speckit-implement-scaffold /)
    h.flow.onTurnEnded(session)
    h.flow.onTurnEnded(session)
    h.flow.onFlowMarker(session, marker('build', { converged: true, tasksDone: 4, tasksTotal: 4 }))
    const done = h.repos.flowStages.get(run.id, 'build')!
    expect(done.status).toBe('review')
    expect(done.report?.rounds).toBe(2)
    expect(done.report?.converged).toBe(true)
  })

  it('stops after three rounds, says converge still found work, and autopilot holds the build', async () => {
    const { h, run, session } = await atBuild(true)
    for (let round = 1; round <= MAX_CONVERGE_ROUNDS; round += 1) {
      h.flow.onFlowMarker(session, marker('build', { converged: false }))
      if (round < MAX_CONVERGE_ROUNDS) for (let i = 0; i < 3; i += 1) h.flow.onTurnEnded(session)
    }
    const row = h.repos.flowStages.get(run.id, 'build')!
    expect(row.status).toBe('review')
    expect(row.report?.rounds).toBe(MAX_CONVERGE_ROUNDS)
    expect(row.report?.converged).toBe(false)
    expect(row.summary).toContain(`Converge still found unbuilt work after ${MAX_CONVERGE_ROUNDS} rounds.`)
    expect(h.repos.flowRuns.byId(run.id)?.stage).toBe('build')
  })

  it('runs the checklist gate when asked, counts the open items from the files, and autopilot holds on them', async () => {
    const h = setup(project())
    const run = await h.flow.start({
      projectId: h.project.id,
      source: { kind: 'text', title: 'Cart', description: '' },
      autopilot: true,
      autoShip: false,
      checklist: true,
    })
    expect(run.checklist).toBe(true)
    write(run.worktreePath!, 'specs/001-cart/spec.md', '# Cart\n')
    h.flow.onFlowMarker(sessionOf(h, run.id, 'spec'), marker('spec', { specDir: 'specs/001-cart' }))
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running'), WAIT)
    const plan = sessionOf(h, run.id, 'plan')
    await vi.waitFor(() => expect(textsTo(h, plan)).not.toHaveLength(0), WAIT)
    for (let i = 0; i < 4; i += 1) h.flow.onTurnEnded(plan)
    const texts = textsTo(h, plan)
    expect(texts.some((t) => t.startsWith('/speckit-checklist '))).toBe(true)
    write(run.worktreePath!, 'specs/001-cart/checklists/requirements.md', '- [x] CHK001 A\n- [ ] CHK002 B\n- [ ] CHK003 C\n')
    h.flow.onFlowMarker(plan, marker('plan'))
    const row = h.repos.flowStages.get(run.id, 'plan')!
    expect(row.status).toBe('review')
    expect(row.report?.checklistOpen).toBe(2)
    expect(row.summary).toContain('The checklist has 2 open items.')
    expect(h.repos.flowRuns.byId(run.id)?.stage).toBe('plan')
  })

  it('tells the checklist how to handle its questions, and holds autopilot when no checklist was written', async () => {
    const h = setup(project())
    const run = await h.flow.start({
      projectId: h.project.id,
      source: { kind: 'text', title: 'Cart', description: '' },
      autopilot: true,
      autoShip: false,
      checklist: true,
    })
    write(run.worktreePath!, 'specs/001-cart/spec.md', '# Cart\n')
    h.flow.onFlowMarker(sessionOf(h, run.id, 'spec'), marker('spec', { specDir: 'specs/001-cart' }))
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running'), WAIT)
    const plan = sessionOf(h, run.id, 'plan')
    await vi.waitFor(() => expect(textsTo(h, plan)).not.toHaveLength(0), WAIT)
    for (let i = 0; i < 4; i += 1) h.flow.onTurnEnded(plan)
    expect(textsTo(h, plan).find((t) => t.startsWith('/speckit-checklist '))).toContain('Answer each question yourself')

    h.flow.onFlowMarker(plan, marker('plan'))
    const row = h.repos.flowStages.get(run.id, 'plan')!
    expect(row.status).toBe('review')
    expect(row.report?.checklistOpen).toBeNull()
    expect(row.summary).toContain('No checklist was written in specs/001-cart/checklists/')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.repos.flowRuns.byId(run.id)?.stage).toBe('plan')
  })
})

describe('a bug run', () => {
  it('refuses a project without the bug extension', async () => {
    const h = setup(project())
    await expect(
      h.flow.start({ projectId: h.project.id, source: bug(), autopilot: false, autoShip: false }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('bug extension') })
  })

  it('derives the slug from the title, carries the bug skills into the worktree, and assesses the symptom', async () => {
    const path = project({ extensions: ['bug'] })
    write(path, '.specify/bugs/login-times-out/assessment.md', '# Old\n')
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: bug(), autopilot: false, autoShip: false })
    expect(run.kind).toBe('bug')
    expect(run.slug).toBe('login-times-out-2')
    expect(run.stage).toBe('assess')
    expect(run.description).toBe('Login hangs after 30 seconds.')
    expect(existsSync(join(run.worktreePath!, '.claude/skills/speckit-bug-fix/SKILL.md'))).toBe(true)
    expect(existsSync(join(run.worktreePath!, '.specify/extensions/bug/extension.yml'))).toBe(true)
    expect(h.repos.flowStages.listForRun(run.id).map((s) => s.stage)).toEqual(flowStagesOf('bug'))
    expect(h.sent[0].text).toMatch(/^\/speckit-bug-assess "Login hangs after 30 seconds\." slug=login-times-out-2\n/)
    expect(h.sent[0].text).toContain('Use slug=login-times-out-2 exactly')
  })

  it('fails a stage that wrote no report, and moves assess, fix, test, then the shared clean, review and ship', async () => {
    const h = setup(project({ extensions: ['bug'] }))
    const run = await h.flow.start({ projectId: h.project.id, source: bug(), autopilot: false, autoShip: false })
    const root = run.worktreePath!
    h.flow.onFlowMarker(sessionOf(h, run.id, 'assess'), marker('assess'))
    expect(h.repos.flowStages.get(run.id, 'assess')?.status).toBe('failed')
    expect(h.repos.flowStages.get(run.id, 'assess')?.summary).toContain('.specify/bugs/login-times-out/assessment.md')

    await h.flow.retry(run.id)
    write(root, '.specify/bugs/login-times-out/assessment.md', '# Bug Assessment: Login\n\n- **Severity**: high\n')
    h.flow.onFlowMarker(sessionOf(h, run.id, 'assess'), marker('assess'))
    expect(h.repos.flowStages.get(run.id, 'assess')?.status).toBe('review')
    await h.flow.approve(run.id)
    expect(h.repos.flowRuns.byId(run.id)?.stage).toBe('fix')
    expect(textsTo(h, sessionOf(h, run.id, 'fix'))[0]).toMatch(/^\/speckit-bug-fix slug=login-times-out /)

    write(root, '.specify/bugs/login-times-out/fix.md', '# Fix\n')
    h.flow.onFlowMarker(sessionOf(h, run.id, 'fix'), marker('fix'))
    await h.flow.approve(run.id)
    expect(h.repos.flowRuns.byId(run.id)?.stage).toBe('test')
    expect(textsTo(h, sessionOf(h, run.id, 'test'))[0]).toMatch(/^\/speckit-bug-test slug=login-times-out /)
  })

  async function atTest() {
    const h = setup(project({ extensions: ['bug'] }))
    const run = await h.flow.start({ projectId: h.project.id, source: bug(), autopilot: false, autoShip: false })
    const root = run.worktreePath!
    write(root, '.specify/bugs/login-times-out/assessment.md', '# A\n')
    write(root, '.specify/bugs/login-times-out/fix.md', '# F\n')
    for (const stage of ['assess', 'fix'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), marker(stage))
      await h.flow.approve(run.id)
    }
    return { h, run, root, session: sessionOf(h, run.id, 'test') }
  }

  it('records the bug-test verdict, and fails the stage on partial or failed', async () => {
    const verified = await atTest()
    write(verified.root, '.specify/bugs/login-times-out/test.md', '# Test\n\n- **Result**: verified\n')
    verified.h.flow.onFlowMarker(verified.session, marker('test', { result: 'verified' }))
    const ok = verified.h.repos.flowStages.get(verified.run.id, 'test')!
    expect(ok.status).toBe('review')
    expect(ok.report?.bugResult).toBe('verified')

    for (const result of ['partial', 'failed'] as const) {
      const t = await atTest()
      write(t.root, '.specify/bugs/login-times-out/test.md', `# Test\n\n- **Result**: ${result}\n`)
      t.h.flow.onFlowMarker(t.session, marker('test', { result: 'verified' }))
      const row = t.h.repos.flowStages.get(t.run.id, 'test')!
      expect(row.status).toBe('failed')
      expect(row.report?.bugResult).toBe(result)
      expect(row.summary).toBe(`The bug test reported ${result}, not verified, so the fix is not done.`)
    }
  })

  it('never counts a missing or unreadable verification as a fix', async () => {
    const missing = await atTest()
    missing.h.flow.onFlowMarker(missing.session, marker('test', { result: 'verified' }))
    expect(missing.h.repos.flowStages.get(missing.run.id, 'test')?.status).toBe('failed')
    expect(missing.h.repos.flowStages.get(missing.run.id, 'test')?.summary).toContain('wrote no')

    const unread = await atTest()
    write(unread.root, '.specify/bugs/login-times-out/test.md', '# Test\n\n- **Result**: not-run\n')
    unread.h.flow.onFlowMarker(unread.session, marker('test', { result: 'verified' }))
    expect(unread.h.repos.flowStages.get(unread.run.id, 'test')?.status).toBe('failed')
  })

  it('reviews against the assessment and ships with the verdict', async () => {
    const t = await atTest()
    write(t.root, '.specify/bugs/login-times-out/test.md', '- **Result**: verified\n')
    t.h.flow.onFlowMarker(t.session, marker('test'))
    await t.h.flow.approve(t.run.id)
    t.h.flow.onFlowMarker(sessionOf(t.h, t.run.id, 'clean'), marker('clean'))
    await t.h.flow.approve(t.run.id)
    const review = sessionOf(t.h, t.run.id, 'review')
    for (let i = 0; i < 2; i += 1) t.h.flow.onTurnEnded(review)
    expect(textsTo(t.h, review).at(-1)).toContain('.specify/bugs/login-times-out/assessment.md')
    t.h.flow.onFlowMarker(review, marker('review', { verdict: 'ready' }))
    await t.h.flow.approve(t.run.id)
    expect(t.h.repos.flowRuns.byId(t.run.id)?.stage).toBe('ship')
    await t.h.flow.ship(t.run.id)
    expect(textsTo(t.h, sessionOf(t.h, t.run.id, 'ship'))[0]).toContain(
      'The Test stage ran /speckit-bug-test, and .specify/bugs/login-times-out/test.md records the result verified.',
    )
  })

  it('opened from an existing bug, starts at the first report that is missing', async () => {
    const path = project({ extensions: ['bug'] })
    write(path, '.specify/bugs/cart-empty/assessment.md', '# A\n')
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: bug('Cart empties', '', 'cart-empty'), autopilot: false, autoShip: false })
    expect(run.slug).toBe('cart-empty')
    expect(run.stage).toBe('fix')
    expect(h.repos.flowStages.get(run.id, 'assess')?.status).toBe('skipped')
    expect(h.repos.flowStages.get(run.id, 'assess')?.summary).toBe('Already written in .specify/bugs/cart-empty/assessment.md.')
    expect(readFileSync(join(run.worktreePath!, '.specify/bugs/cart-empty/assessment.md'), 'utf8')).toBe('# A\n')
  })

  it('opened from a bug whose fix is recorded in the primary checkout, fixes it again in the worktree rather than testing base', async () => {
    const path = project({ extensions: ['bug'] })
    write(path, '.specify/bugs/cart-empty/assessment.md', '# A\n')
    write(path, '.specify/bugs/cart-empty/fix.md', '# F\n')
    write(path, '.specify/bugs/cart-empty/test.md', '- **Result**: verified\n')
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: bug('Cart empties', '', 'cart-empty'), autopilot: true, autoShip: false })
    expect(run.stage).toBe('fix')
    expect(h.sent[0].text).toMatch(/^\/speckit-bug-fix slug=cart-empty /)
    expect(h.sent[0].text).toContain('already exists, overwrite it')
  })

  it('sends a bug whose test did not verify back to Fix with what the test found, and never lets Skip past it', async () => {
    const t = await atTest()
    write(t.root, '.specify/bugs/login-times-out/test.md', '# Test\n\n- **Result**: partial\n')
    t.h.flow.onFlowMarker(t.session, marker('test'))
    const failed = t.h.repos.flowStages.get(t.run.id, 'test')!
    expect(flowStageActions(t.h.repos.flowRuns.byId(t.run.id)!, failed)).toEqual(['fix', 'retry'])
    await expect(t.h.flow.skip(t.run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })

    await t.h.flow.fix(t.run.id)

    expect(t.h.repos.flowRuns.byId(t.run.id)?.stage).toBe('fix')
    const refix = textsTo(t.h, sessionOf(t.h, t.run.id, 'fix')).at(-1)!
    expect(refix).toMatch(/^\/speckit-bug-fix slug=login-times-out /)
    expect(refix).toContain('The bug test reported partial')
    expect(refix).toContain('.specify/bugs/login-times-out/test.md')
    t.h.flow.onFlowMarker(sessionOf(t.h, t.run.id, 'fix'), marker('fix'))
    await t.h.flow.approve(t.run.id)
    expect(t.h.repos.flowRuns.byId(t.run.id)?.stage).toBe('test')
    expect(t.h.repos.flowStages.get(t.run.id, 'test')?.status).toBe('running')
  })

  it('keeps its reports in the primary checkout when its worktree is removed', async () => {
    const t = await atTest()
    write(t.root, '.specify/bugs/login-times-out/test.md', '- **Result**: verified\n')
    await t.h.flow.cancel(t.run.id)

    await t.h.flow.removeWorktree(t.run.id, true)

    const primary = t.h.project.path
    expect(readFileSync(join(primary, '.specify/bugs/login-times-out/test.md'), 'utf8')).toBe('- **Result**: verified\n')
    expect(readFileSync(join(primary, '.specify/bugs/login-times-out/fix.md'), 'utf8')).toBe('# F\n')
    rmSync(t.root, { recursive: true, force: true })
    expect((await t.h.flow.artefact(t.run.id, 'test'))?.content).toBe('- **Result**: verified\n')
  })

  it('refuses a slug that is not one', async () => {
    const h = setup(project({ extensions: ['bug'] }))
    await expect(
      h.flow.start({ projectId: h.project.id, source: bug('X', '', '../etc'), autopilot: false, autoShip: false }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })
})

describe('an idea run', () => {
  it('runs in the primary checkout with no worktree and no branch, even with no source code', async () => {
    const path = project({ sln: false, extensions: ['assess'] })
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: idea(), autopilot: false, autoShip: false, baseBranch: 'x' })
    expect(h.git.create).not.toHaveBeenCalled()
    expect(run.kind).toBe('idea')
    expect(run.worktreePath).toBeNull()
    expect(run.branch).toBeNull()
    expect(run.baseBranch).toBeNull()
    expect(run.stage).toBe('intake')
    expect(h.manager.startSession).toHaveBeenCalledWith(
      h.project.id,
      false,
      h.project.defaultSessionMode,
      expect.objectContaining({ cwd: path }),
    )
    expect(h.sent[0].text).toMatch(/^\/speckit-assess-intake "Let users work offline\." slug=offline-mode\n/)
  })

  it('refuses other repositories', async () => {
    const h = setup(project({ extensions: ['assess'] }))
    const other = h.repos.projects.insert({ name: 'api', path: project(), source: 'manual' })
    await expect(
      h.flow.start({ projectId: h.project.id, source: idea(), autopilot: false, autoShip: false, companions: [{ projectId: other.id }] }),
    ).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
  })

  it('walks intake, research, define, shape and decide, and a go decision seeds a feature', async () => {
    const path = project({ extensions: ['assess'] })
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: idea(), autopilot: false, autoShip: false })
    const files: Record<string, string> = {
      intake: 'intake.md',
      research: 'research.md',
      define: 'problem.md',
      shape: 'concept.md',
      decide: 'decision.md',
    }
    for (const stage of flowStagesOf('idea')) {
      expect(h.repos.flowRuns.byId(run.id)?.stage).toBe(stage)
      if (stage !== 'intake') expect(textsTo(h, sessionOf(h, run.id, stage))[0]).toMatch(new RegExp(`^/speckit-assess-${stage} slug=offline-mode\\n`))
      const body =
        stage === 'decide'
          ? '# Decision\n\n- **Verdict**: go\n\n## If go — Handoff to `/speckit-specify`\n\nBuild offline sync for the cart.\n'
          : `# ${stage}\n`
      write(path, `.specify/assessments/offline-mode/${files[stage]}`, body)
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), marker(stage, stage === 'decide' ? { decision: 'kill' } : {}))
      expect(h.repos.flowStages.get(run.id, stage)?.status).toBe('review')
      await h.flow.approve(run.id)
    }
    const done = h.repos.flowRuns.byId(run.id)!
    expect(done.status).toBe('done')
    const decideRow = h.repos.flowStages.get(run.id, 'decide')!
    expect(decideRow.report?.decision).toBe('go')
    expect(flowStageActions(done, decideRow)).toEqual(['feature'])
    expect(await h.flow.feature(run.id)).toEqual({ title: 'Offline mode', description: 'Build offline sync for the cart.' })
  })

  it('opened from an idea that is already decided, finishes at once with that decision, so a go offers the feature', async () => {
    const path = project({ extensions: ['assess'] })
    for (const file of ['intake', 'research', 'problem', 'concept']) write(path, `.specify/assessments/offline-mode/${file}.md`, '# x\n')
    write(path, '.specify/assessments/offline-mode/decision.md', '# Decision\n\n- **Verdict**: go\n')
    const h = setup(path)

    const run = await h.flow.start({ projectId: h.project.id, source: { kind: 'idea', title: 'Offline mode', idea: '', slug: 'offline-mode' }, autopilot: true, autoShip: false })

    expect(run.status).toBe('done')
    expect(h.manager.startSession).not.toHaveBeenCalled()
    const decideRow = h.repos.flowStages.get(run.id, 'decide')!
    expect(decideRow).toMatchObject({ status: 'approved', summary: 'Already decided in .specify/assessments/offline-mode/decision.md.' })
    expect(flowStageActions(run, decideRow)).toEqual(['feature'])
  })

  it('offers no feature after a kill', async () => {
    const path = project({ extensions: ['assess'] })
    for (const file of ['intake', 'research', 'problem', 'concept']) write(path, `.specify/assessments/offline-mode/${file}.md`, '# x\n')
    const h = setup(path)
    const run = await h.flow.start({ projectId: h.project.id, source: { kind: 'idea', title: 'Offline mode', idea: '', slug: 'offline-mode' }, autopilot: false, autoShip: false })
    expect(run.stage).toBe('decide')
    write(path, '.specify/assessments/offline-mode/decision.md', '- **Verdict**: kill\n')
    h.flow.onFlowMarker(sessionOf(h, run.id, 'decide'), marker('decide'))
    await h.flow.approve(run.id)
    await expect(h.flow.feature(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
  })
})
