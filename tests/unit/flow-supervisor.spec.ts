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

const WAIT = { timeout: 5000 }

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
    origin: vi.fn<FlowGit['origin']>(async () => 'git.example.internal'),
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
  mkdirSync(join(dir, '.specify', 'memory'), { recursive: true })
  writeFileSync(join(dir, '.specify', 'memory', 'constitution.md'), '# Alpha Constitution\n')
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

type McpState = { status: string; error: string | null } | null

function setup(options?: { ado?: boolean; projectPath?: string; mcp?: () => McpState }) {
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
    mcpStatus: vi.fn(async (): Promise<McpState> => {
      if (options?.mcp) return options.mcp()
      return options?.ado === false ? { status: 'failed', error: 'spawn npx ENOENT' } : { status: 'connected', error: null }
    }),
    reconnectMcpServer: vi.fn(async (_sessionId: string, _name: string) => {}),
    liveSessionIds: () => Array.from({ length: sessionCount }, (_, at) => `session-${at + 1}`).filter((id) => !ended.includes(id)),
    sendMessage: (sessionId: string, text: string) => sent.push({ sessionId, text }),
    watchFlow: (sessionId: string) => watched.push(sessionId),
    endFlowSession: (sessionId: string) => ended.push(sessionId),
    stopSession: vi.fn(async (sessionId: string) => {
      stopped.push(sessionId)
    }),
    renameSession: vi.fn(),
  }

  const git = fakeGit()
  const flow = new FlowSupervisor(repos, manager as never, { onFlowChanged: (id) => changed.push(id) }, git, {
    waitMs: 1000,
    pollMs: 10,
  })

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
    pullRequests: [],
    converged: true,
    result: null,
    decision: null,
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

describe('actions racing each other', () => {
  function slowStop(h: ReturnType<typeof setup>) {
    h.manager.stopSession.mockImplementation(async (sessionId: string) => {
      h.stopped.push(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }

  it('refuses a second Skip while the first is still stopping the session', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    slowStop(h)
    const first = h.flow.skip(run.id)
    await expect(h.flow.skip(run.id)).rejects.toMatchObject({ code: 'RULE_NOT_ALLOWED' })
    await first
    const stages = h.repos.flowStages.listForRun(run.id)
    expect(stages.filter((s) => s.status === 'running').map((s) => s.stage)).toEqual(['plan'])
    expect(h.manager.startSession).toHaveBeenCalledTimes(2)
  })

  it('starts nothing once Cancel lands while a Skip is still stopping the session', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    slowStop(h)
    const skipping = h.flow.skip(run.id)
    await h.flow.cancel(run.id)
    await skipping
    const after = h.repos.flowRuns.byId(run.id)!
    expect(after.status).toBe('cancelled')
    expect(h.repos.flowStages.listForRun(run.id).filter((s) => s.status === 'running')).toEqual([])
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
  })

  it('ends a stage session that finished starting after the run was cancelled', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())
    let release: () => void = () => {}
    h.manager.startSession.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ id: 'late-session' }))),
    )
    const approving = h.flow.approve(run.id)
    await vi.waitFor(() => expect(h.manager.startSession).toHaveBeenCalledTimes(2))
    await h.flow.cancel(run.id)
    release()
    await approving
    expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('pending')
    expect(h.ended).toContain('late-session')
    expect(h.sent.filter((send) => send.sessionId === 'late-session')).toEqual([])
  })
})

describe('autopilot', () => {
  async function toStage(h: ReturnType<typeof setup>, stop: FlowStage) {
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: true, autoShip: true })
    for (const stage of FLOW_STAGES.slice(0, FLOW_STAGES.indexOf(stop))) {
      await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, stage)?.status).toBe('running'), WAIT)
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage }))
    }
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, stop)?.status).toBe('running'), WAIT)
    return run
  }

  it('holds a build that reports fewer tasks done than planned', async () => {
    const h = setup()
    const run = await toStage(h, 'build')
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ stage: 'build', tasksDone: 6, tasksTotal: 14 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.repos.flowRuns.byId(run.id)?.stage).toBe('build')
    expect(h.repos.flowStages.get(run.id, 'build')?.status).toBe('review')
  })

  it('treats a review without a clean ready verdict as needing fixes, and never ships it', async () => {
    const h = setup()
    const run = await toStage(h, 'review')
    const before = h.repos.flowStages.get(run.id, 'review')!.attempts
    h.flow.onFlowMarker(
      sessionOf(h, run.id),
      specMarker({ stage: 'review', verdict: null, findings: [{ severity: 'must_fix', file: 'A.cs', line: 3, what: 'SQL injection' }] }),
    )
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'review')?.attempts).toBe(before + 1), WAIT)
    expect(h.repos.flowStages.get(run.id, 'ship')?.status).toBe('pending')

    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ stage: 'review', verdict: 'ready', unmet: ['Guests can pay.'] }))
    expect(h.repos.flowStages.get(run.id, 'review')?.report?.verdict).toBe('needs_fixes')
  })

  it('acts on a stage already waiting for approval when it is switched on', async () => {
    const h = setup()
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker())
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('review')
    h.flow.setAutopilot(run.id, true)
    await vi.waitFor(() => expect(h.repos.flowStages.get(run.id, 'plan')?.status).toBe('running'))
  })
})

describe('the pull request link', () => {
  async function toShip(h: ReturnType<typeof setup>) {
    const run = await h.flow.start({ projectId: h.project.id, source: textSource(), autopilot: false, autoShip: false })
    for (const stage of ['spec', 'plan', 'build', 'clean', 'test', 'review'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage, verdict: stage === 'review' ? 'ready' : null }))
      await h.flow.approve(run.id)
    }
    await h.flow.ship(run.id)
    return run
  }

  it('keeps a GitHub, Azure DevOps or origin-host https link and drops any other', async () => {
    const h = setup()
    const run = await toShip(h)
    h.flow.onFlowMarker(sessionOf(h, run.id), specMarker({ stage: 'ship', prUrl: 'https://git.example.internal/x/y/pulls/3', prId: '3' }))
    expect(h.repos.flowRuns.byId(run.id)?.prUrl).toBe('https://git.example.internal/x/y/pulls/3')
    expect(await h.flow.pullRequestUrl(run.id)).toBe('https://git.example.internal/x/y/pulls/3')

    const other = await toShip(h)
    h.flow.onFlowMarker(sessionOf(h, other.id), specMarker({ stage: 'ship', prUrl: 'https://github.com.evil.example/pr/1', prId: '1' }))
    expect(h.repos.flowRuns.byId(other.id)?.prUrl).toBeNull()
    expect(h.repos.flowStages.get(other.id, 'ship')?.summary).toContain('not kept')
  })

  it('refuses to open a stored link that is not allowed', async () => {
    const h = setup()
    const run = await toShip(h)
    h.repos.flowRuns.update(run.id, { prUrl: 'https://user:pw@github.com/o/r/pull/1' })
    await expect(h.flow.pullRequestUrl(run.id)).rejects.toMatchObject({ code: 'INVALID_PATH' })
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

  it.each([
    [{ status: 'pending', error: null }, 'it is still starting after 1 seconds, and npx may still be fetching it'],
    [{ status: 'needs-auth', error: null }, 'it needs you to sign in'],
    [{ status: 'failed', error: 'spawn npx ENOENT' }, 'it failed to start: spawn npx ENOENT'],
    [{ status: 'disabled', error: null }, 'it is disabled'],
    [{ status: 'missing', error: null }, 'no MCP server named ado is configured'],
  ])('names the ado server state %o, and keeps the session for Reconnect', async (state, why) => {
    const h = setup({ mcp: () => state })
    await expect(h.flow.features(h.project.id, '')).rejects.toEqual({
      code: 'MCP_NOT_CONNECTED',
      message: expect.stringContaining(`The Azure DevOps MCP server is not connected for this session: ${why}`),
    })
    expect(h.ended).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('waits while the server is still starting, then lists the Features once it connects', async () => {
    let polls = 0
    const h = setup({ mcp: () => (++polls < 5 ? { status: 'pending', error: null } : { status: 'connected', error: null }) })
    const listing = h.flow.features(h.project.id, '')
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    h.flow.onFlowMarker(h.sent[0].sessionId, { kind: 'features', features: [{ id: '1', title: 'A', state: null, url: null }] })
    await expect(listing).resolves.toEqual([{ id: '1', title: 'A', state: null, url: null }])
    expect(polls).toBe(5)
  })

  it('reconnects ado on the same session and retries the Feature list there', async () => {
    let state: McpState = { status: 'failed', error: 'npm ERR! 404' }
    const h = setup({ mcp: () => state })
    await expect(h.flow.features(h.project.id, 'checkout')).rejects.toMatchObject({ code: 'MCP_NOT_CONNECTED' })
    state = { status: 'connected', error: null }
    const listing = h.flow.reconnectAdo(h.project.id, 'checkout')
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(h.manager.reconnectMcpServer).toHaveBeenCalledWith('session-1', 'ado')
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
    expect(h.sent[0]).toMatchObject({ sessionId: 'session-1', text: expect.stringContaining('Only Features matching: checkout') })
    h.flow.onFlowMarker('session-1', { kind: 'features', features: [] })
    await expect(listing).resolves.toEqual([])
  })

  it('keeps the session again when a reconnect still leaves ado down, and starts afresh once it is gone', async () => {
    const h = setup({ mcp: () => ({ status: 'needs-auth', error: null }) })
    await expect(h.flow.features(h.project.id, '')).rejects.toMatchObject({ code: 'MCP_NOT_CONNECTED' })
    await expect(h.flow.reconnectAdo(h.project.id, '')).rejects.toMatchObject({ code: 'MCP_NOT_CONNECTED' })
    expect(h.manager.startSession).toHaveBeenCalledTimes(1)
    expect(h.ended).toEqual([])
    await expect(h.flow.features(h.project.id, '')).rejects.toMatchObject({ code: 'MCP_NOT_CONNECTED' })
    expect(h.ended).toEqual(['session-1'])
    await expect(h.flow.reconnectAdo(h.project.id, '')).rejects.toMatchObject({ code: 'MCP_NOT_CONNECTED' })
    expect(h.manager.reconnectMcpServer).toHaveBeenLastCalledWith('session-2', 'ado')
  })

  it('checks the ado state again when the spec stage of an ado run is retried', async () => {
    let state: McpState = { status: 'pending', error: null }
    const h = setup({ mcp: () => state })
    const run = await h.flow.start({
      projectId: h.project.id,
      source: { kind: 'ado', featureId: '4711', featureTitle: 'Checkout v2', url: null },
      autopilot: false,
      autoShip: false,
    })
    const failed = h.repos.flowStages.get(run.id, 'spec')!
    expect(failed.status).toBe('failed')
    expect(failed.summary).toContain('it is still starting after 1 seconds')
    state = { status: 'connected', error: null }
    await h.flow.retry(run.id)
    expect(h.repos.flowStages.get(run.id, 'spec')?.status).toBe('running')
    expect(h.sent.at(-1)?.text).toContain('/speckit-specify')
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
    const opts = h.manager.startSession.mock.calls.map((call) => (call as unknown[])[3] as Record<string, unknown>)
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
      await vi.waitFor(() => expect(h.repos.flowStages.get(runId, next)?.sessionId).toBeTruthy(), WAIT)
    }
    const atReview = h.repos.flowRuns.byId(runId)!
    expect(atReview.stage).toBe('review')

    for (let round = 0; round < 3; round += 1) {
      const sid = h.repos.flowStages.get(atReview.id, 'review')!.sessionId!
      const attemptsBefore = h.repos.flowStages.get(atReview.id, 'review')!.attempts
      h.flow.onFlowMarker(sid, specMarker({ stage: 'review', verdict: 'needs_fixes', unmet: ['x'] }))
      if (round < 2) {
        await vi.waitFor(
          () => expect(h.repos.flowStages.get(atReview.id, 'review')!.attempts).toBe(attemptsBefore + 1),
          WAIT,
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

describe('a run across two repositories', () => {
  function angularProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sup-ng-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'angular.json'), '{"projects":{}}')
    return dir
  }

  function twoRepos() {
    const h = setup()
    const beta = h.repos.projects.insert({ name: 'beta', path: angularProject(), source: 'manual' })
    return { ...h, beta }
  }

  type Two = ReturnType<typeof twoRepos>

  const startBoth = (h: Two, baseBranch?: string) =>
    h.flow.start({
      projectId: h.project.id,
      source: textSource(),
      autopilot: false,
      autoShip: false,
      companions: [{ projectId: h.beta.id, baseBranch }],
    })

  function stageTexts(h: Two, runId: string, stage: FlowStage): string[] {
    const sid = sessionOf(h, runId, stage)
    const texts = () => h.sent.filter((sent) => sent.sessionId === sid).map((sent) => sent.text)
    while (!texts().at(-1)!.includes('SWB_FLOW:')) h.flow.onTurnEnded(sid)
    h.flow.onFlowMarker(sid, specMarker({ stage, verdict: stage === 'review' ? 'ready' : null }))
    return texts()
  }

  it('makes a worktree in each on one branch name free in both, and gives every stage session the companion', async () => {
    const h = twoRepos()
    const run = await startBoth(h, 'develop')
    const companion = join(h.beta.path, '.worktrees', 'checkout-v2')

    expect(h.git.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        repoRoot: h.project.path,
        base: 'main',
        others: [{ repoRoot: h.beta.path, root: join(h.beta.path, '.worktrees') }],
      }),
    )
    expect(h.git.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ repoRoot: h.beta.path, base: 'develop', branch: 'feature/checkout-v2' }),
    )
    expect(run.stacks).toEqual(['dotnet', 'angular'])
    expect(run.repos.map((repo) => [repo.name, repo.branch, repo.baseBranch, repo.stacks, repo.worktreePath])).toEqual([
      ['alpha', 'feature/checkout-v2', 'main', ['dotnet'], run.worktreePath],
      ['beta', 'feature/checkout-v2', 'develop', ['angular'], companion],
    ])
    expect(h.manager.startSession).toHaveBeenCalledWith(
      h.project.id,
      false,
      h.project.defaultSessionMode,
      expect.objectContaining({ cwd: run.worktreePath, additionalDirectories: [companion] }),
    )
    expect(h.sent[0].text).toMatch(/^\/speckit-specify Checkout v2/)
    expect(h.sent[0].text).toContain(`- alpha (${run.worktreePath}), the primary: the spec and tasks.md live here; .NET; base main`)
    expect(h.sent[0].text).toContain(`- beta (${companion}); Angular; base develop`)
  })

  it('checks the companion base like the primary one, before making any worktree', async () => {
    const h = twoRepos()
    await expect(startBoth(h, '--orphan')).rejects.toMatchObject({ code: 'INVALID_PATH', message: expect.stringContaining('in beta') })
    h.git.resolves = vi.fn(async (root: string) => root !== h.beta.path)
    await expect(startBoth(h, 'nope')).rejects.toMatchObject({ code: 'INVALID_PATH', message: expect.stringContaining('in beta') })
    h.git.branch = vi.fn(async (root: string) => (root === h.beta.path ? null : 'main'))
    await expect(startBoth(h)).rejects.toMatchObject({
      code: 'INVALID_PATH',
      message: expect.stringContaining('The checkout of beta is on a detached HEAD'),
    })
    expect(h.git.create).not.toHaveBeenCalled()
  })

  it('refuses a companion with neither stack, a repeated repository and an archived one', async () => {
    const h = twoRepos()
    const empty = mkdtempSync(join(tmpdir(), 'flow-sup-docs-'))
    tempDirs.push(empty)
    const docs = h.repos.projects.insert({ name: 'docs', path: empty, source: 'manual' })
    const withCompanions = (...ids: string[]) =>
      h.flow.start({
        projectId: h.project.id,
        source: textSource(),
        autopilot: false,
        autoShip: false,
        companions: ids.map((projectId) => ({ projectId })),
      })
    await expect(withCompanions(docs.id)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('docs') })
    await expect(withCompanions(h.project.id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    await expect(withCompanions(h.beta.id, h.beta.id)).rejects.toMatchObject({ code: 'DUPLICATE' })
    h.repos.projects.archive(h.beta.id)
    await expect(withCompanions(h.beta.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.git.create).not.toHaveBeenCalled()
  })

  it('removes the worktree and the branch it already made and keeps no run when the next one fails', async () => {
    const h = twoRepos()
    const create = h.git.create
    h.git.create = vi.fn(async (input: Parameters<FlowGit['create']>[0]) => {
      if (input.repoRoot === h.beta.path) throw new Error('fatal: a branch named feature/checkout-v2 already exists')
      return create(input)
    })
    await expect(startBoth(h)).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('beta') })
    expect(h.git.remove).toHaveBeenCalledWith(h.project.path, join(h.project.path, '.worktrees', 'checkout-v2'), {
      force: true,
      deleteBranch: 'feature/checkout-v2',
    })
    expect(h.repos.flowRuns.listForProject(h.project.id)).toEqual([])
    expect(h.manager.startSession).not.toHaveBeenCalled()
  })

  it('names the repository of every task, implement step, cleanup and review, each against its own base', async () => {
    const h = twoRepos()
    const run = await startBoth(h, 'develop')
    const primary = `alpha (${run.worktreePath})`
    const companion = `beta (${run.repos[1].worktreePath})`
    const repoLine = `- ${companion}; Angular; base develop`

    const spec = stageTexts(h, run.id, 'spec')
    expect(spec[0]).toContain(repoLine)
    await h.flow.approve(run.id)

    const plan = stageTexts(h, run.id, 'plan')
    expect(plan[0]).toContain(repoLine)
    expect(plan[1]).toContain('Every task names the repository it belongs to, as [alpha] or [beta] right after its id.')
    await h.flow.approve(run.id)

    const build = stageTexts(h, run.id, 'build')
    expect(build[0]).toMatch(/^\/speckit-implement-scaffold /)
    expect(build[0]).toContain(`Work in ${primary}, on every unchecked task tasks.md gives that repository.`)
    expect(build[1]).toMatch(/^\/speckit-implement /)
    expect(build[1]).toContain(`Work in ${companion}, on every unchecked task tasks.md gives that repository.`)
    await h.flow.approve(run.id)

    const clean = stageTexts(h, run.id, 'clean')
    expect(clean[0]).toContain(`/dotnet-claude-kit:de-sloppify Only touch files in ${primary} changed on this branch against main.`)
    expect(clean.filter((text) => text.includes('de-sloppify'))).toHaveLength(1)
    expect(clean).toContain(`/ponytail:ponytail-review Review the diff of ${primary} on this branch against main.`)
    expect(clean).toContain(`/ponytail:ponytail-review Review the diff of ${companion} on this branch against develop.`)
    await h.flow.approve(run.id)

    const test = h.sent.filter((sent) => sent.sessionId === sessionOf(h, run.id, 'test'))[0].text
    expect(test).toContain('in each repository')
    expect(test).toContain(`- ${primary}, .NET: `)
    expect(test).toContain(`- ${companion}, Angular: `)
    await h.flow.skip(run.id)

    const review = stageTexts(h, run.id, 'review')
    expect(review[0]).toContain(repoLine)
    expect(review).toContain(`/dotnet-claude-kit:security-scan Scope: the changes in ${primary} on this branch against main.`)
    expect(review.filter((text) => text.includes('security-scan'))).toHaveLength(1)
    expect(review.at(-1)).toContain('each against its own base (alpha against main, beta against develop)')
  })

  it('builds the verify step from the suites in each worktree, each run inside it under an id naming its repository', async () => {
    const h = twoRepos()
    h.repos.settings.set({ projectSuiteCommands: { [h.project.id]: { 'dotnet-unit': 'dotnet test Only.sln' } } })
    const run = await startBoth(h)
    const companion = run.repos[1].worktreePath!
    writeFileSync(join(run.worktreePath!, 'App.sln'), '')
    writeFileSync(join(companion, 'angular.json'), '{"projects":{}}')
    writeFileSync(join(companion, 'package.json'), '{"devDependencies":{}}')
    for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage }))
      await h.flow.approve(run.id)
    }
    h.flow.onTurnEnded(sessionOf(h, run.id, 'test'))
    const verify = h.sent.at(-1)!.text
    expect(verify).toContain(`- alpha/dotnet-unit (alpha Unit tests): cd "${run.worktreePath}" && dotnet test Only.sln`)
    expect(verify).toContain(`- beta/ng-unit (beta Unit tests (Karma/Jasmine)): cd "${companion}" && npx ng test`)
    expect(verify).not.toContain('- dotnet-unit')
  })

  it('raises a pull request per repository and keeps each link only on an allowed host or its own origin', async () => {
    const h = twoRepos()
    h.git.origin = vi.fn(async (root: string) => (root === h.beta.path ? 'git.beta.internal' : 'git.example.internal'))
    const run = await startBoth(h, 'develop')
    for (const stage of ['spec', 'plan', 'build', 'clean', 'test', 'review'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage, verdict: stage === 'review' ? 'ready' : null }))
      await h.flow.approve(run.id)
    }
    await h.flow.ship(run.id)
    const prompt = h.sent.at(-1)!.text
    expect(prompt).toContain('Raise one pull request per repository')
    expect(prompt).toContain(`- beta (${run.repos[1].worktreePath}) into develop`)
    expect(prompt).toContain('edit each description to link the others')
    expect(prompt).toContain('"pullRequests":[{"repository":')

    h.flow.onFlowMarker(
      sessionOf(h, run.id, 'ship'),
      specMarker({
        stage: 'ship',
        pullRequests: [
          { repository: 'alpha', prUrl: 'https://github.com/o/alpha/pull/1', prId: '1' },
          { repository: 'Beta', prUrl: 'https://git.beta.internal/beta/pulls/2', prId: '2' },
        ],
      }),
    )
    let after = h.repos.flowRuns.byId(run.id)!
    expect(after.repos.map((repo) => [repo.prUrl, repo.prId])).toEqual([
      ['https://github.com/o/alpha/pull/1', '1'],
      ['https://git.beta.internal/beta/pulls/2', '2'],
    ])
    expect(after.prUrl).toBe('https://github.com/o/alpha/pull/1')
    expect(await h.flow.pullRequestUrl(run.id)).toBe('https://github.com/o/alpha/pull/1')
    expect(await h.flow.pullRequestUrl(run.id, h.beta.id)).toBe('https://git.beta.internal/beta/pulls/2')

    await h.flow.revise(run.id, 'Link the two pull requests.')
    h.flow.onFlowMarker(
      sessionOf(h, run.id, 'ship'),
      specMarker({
        stage: 'ship',
        pullRequests: [
          { repository: 'alpha', prUrl: 'https://git.beta.internal/alpha/pulls/1', prId: '1' },
          { repository: 'beta', prUrl: 'https://git.beta.internal/beta/pulls/2', prId: '2' },
        ],
      }),
    )
    after = h.repos.flowRuns.byId(run.id)!
    expect(after.repos.map((repo) => repo.prUrl)).toEqual([null, 'https://git.beta.internal/beta/pulls/2'])
    expect(h.repos.flowStages.get(run.id, 'ship')?.summary).toContain('link for alpha was not an https address on an allowed host')
    await expect(h.flow.pullRequestUrl(run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('keeps a pull request reported under its labelled repository name, and names a repository with none', async () => {
    const h = twoRepos()
    const run = await startBoth(h, 'develop')
    for (const stage of ['spec', 'plan', 'build', 'clean', 'test', 'review'] as const) {
      h.flow.onFlowMarker(sessionOf(h, run.id, stage), specMarker({ stage, verdict: stage === 'review' ? 'ready' : null }))
      await h.flow.approve(run.id)
    }
    await h.flow.ship(run.id)
    expect(h.sent.at(-1)!.text).toContain('named exactly as the repository name before the brackets')

    h.flow.onFlowMarker(
      sessionOf(h, run.id, 'ship'),
      specMarker({
        stage: 'ship',
        pullRequests: [{ repository: `alpha (${run.worktreePath})`, prUrl: 'https://github.com/o/alpha/pull/1', prId: '1' }],
      }),
    )

    expect(h.repos.flowRuns.byId(run.id)!.repos.map((repo) => repo.prUrl)).toEqual(['https://github.com/o/alpha/pull/1', null])
    expect(h.repos.flowStages.get(run.id, 'ship')?.summary).toContain('reported no pull request for beta')
  })

  it('gives each companion its own folder under the worktree root setting, apart from every primary worktree', async () => {
    const h = setup()
    const parent = mkdtempSync(join(tmpdir(), 'flow-sup-web-'))
    tempDirs.push(parent)
    const webs = ['a', 'b'].map((side) => {
      const path = join(parent, side, 'web')
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'angular.json'), '{"projects":{}}')
      return h.repos.projects.insert({ name: `web ${side}`, path, source: 'manual' })
    })
    const override = join(parent, 'wt')
    h.repos.settings.set({ flowWorktreeRoot: override })

    await h.flow.start({
      projectId: h.project.id,
      source: textSource(),
      autopilot: false,
      autoShip: false,
      companions: webs.map((web) => ({ projectId: web.id })),
    })

    expect(h.git.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        root: override,
        others: [
          { repoRoot: webs[0].path, root: join(override, 'web.worktrees') },
          { repoRoot: webs[1].path, root: join(override, 'web-2.worktrees') },
        ],
      }),
    )
  })

  it('removes every worktree of the run, the companion first, and names the one that is dirty', async () => {
    const h = twoRepos()
    const run = await startBoth(h)
    await h.flow.cancel(run.id)
    const after = await h.flow.removeWorktree(run.id, true)
    expect(h.git.remove).toHaveBeenNthCalledWith(1, h.beta.path, run.repos[1].worktreePath, { force: true })
    expect(h.git.remove).toHaveBeenNthCalledWith(2, h.project.path, run.worktreePath, { force: true })
    expect(after.worktreePath).toBeNull()
    expect(after.repos.map((repo) => repo.worktreePath)).toEqual([null, null])

    const dirty = await startBoth(h)
    await h.flow.cancel(dirty.id)
    h.git.remove = vi.fn(async (root: string) =>
      root === h.beta.path ? { removed: false, dirty: ['?? scratch.ts'] } : { removed: true, dirty: [] },
    )
    await expect(h.flow.removeWorktree(dirty.id, false)).rejects.toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: 'The worktree of beta has 1 uncommitted change.',
    })
    expect(h.repos.flowRuns.byId(dirty.id)?.worktreePath).not.toBeNull()
  })
})
