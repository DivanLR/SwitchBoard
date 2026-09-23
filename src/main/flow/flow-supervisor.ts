import { existsSync, readFileSync } from 'node:fs'
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type {
  FlowRepo,
  FlowRun,
  FlowStage,
  FlowStageAction,
  FlowStageRecord,
  FlowStageReport,
  Project,
  SessionEndReason,
  SpecSummary,
  VerifyReport,
} from '@shared/domain'
import {
  FLOW_STAGE_LABELS,
  FLOW_STAGES,
  emptyFlowStageReport,
  flowStageActions,
  verifyVerdict,
} from '@shared/domain'
import type { FlowArtefactKind, FlowCompanionRequest, FlowStartSource, IpcError } from '@shared/ipc-types'
import { nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import {
  buildHandshake,
  buildSteps,
  cleanHandshake,
  cleanSteps,
  clarifyPrompt,
  fixFindingsPrompt,
  planHandshake,
  planSteps,
  reviewHandshake,
  reviewSteps,
  revisePrompt,
  shipForbidden,
  shipPrompt,
  specHandshake,
  specifyPrompt,
  testWritePrompt,
  featuresPrompt,
  withRepos,
} from './flow-prompts'
import { allowedPullRequestUrl, type FlowMarker, type FlowStageMarker } from './flow-markers'
import { artefactRelPath, defaultArtefactKind, resolveArtefactPath } from './artefacts'
import { STACK_ORDER, detectFlowStacks } from './stacks'
import { readSpecKitState } from '@main/specs/spec-kit'
import { defaultSelection, stackById, type TestSuite } from '@shared/test-catalog'
import {
  detectProjectSuites,
  planSuites,
  verifyPrompt as buildVerifyPrompt,
  type PlannedSuite,
} from '@main/verify/verify-dispatch'
import { createWorktree, currentBranch, originHost, removeWorktree, resolvesToCommit, worktreeRoot } from './worktrees'
import type { FlowFeature } from '@shared/domain'

export const ADO_SERVER = 'ado'

const ADO_WAIT_MS = 30_000

const MAX_FIX_ROUNDS = 2

interface FlowCallbacks {
  onFlowChanged: (projectId: string) => void
}

type FeaturesWaiter = {
  resolve: (features: FlowFeature[]) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export interface FlowGit {
  create: typeof createWorktree
  remove: typeof removeWorktree
  branch: typeof currentBranch
  root: typeof worktreeRoot
  resolves: typeof resolvesToCommit
  origin: typeof originHost
}

const defaultGit: FlowGit = {
  create: createWorktree,
  remove: removeWorktree,
  branch: currentBranch,
  root: worktreeRoot,
  resolves: resolvesToCommit,
  origin: originHost,
}

const REFUSED: Record<FlowStageAction, string> = {
  approve: 'This stage is not waiting for approval.',
  fix: 'Fix only applies to a review that found something to fix.',
  revise: 'This stage is not waiting for approval.',
  retry: 'This stage has not failed.',
  ship: 'This run is not waiting to raise its pull request.',
  skip: 'This stage cannot be skipped now.',
}

const NO_REPORT = 'The stage finished without reporting its result.'
const NO_VERIFY_REPORT = 'The verification step did not return a report.'
const SESSION_ENDED = 'The session ended before this stage reported.'

async function copyMissing(fromRoot: string, toRoot: string, rel: string): Promise<void> {
  const from = join(fromRoot, rel)
  const to = join(toRoot, rel)
  if (!existsSync(from) || existsSync(to)) return
  await cp(from, to, { recursive: true }).catch(() => {})
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(error)
}

function inRepository(suite: TestSuite, name: string, root: string): TestSuite {
  return {
    ...suite,
    id: `${name}/${suite.id}`,
    label: `${name} ${suite.label}`,
    command: suite.mcp ? `For ${name} (${root}): ${suite.command}` : `cd "${root}" && ${suite.command}`,
  }
}

interface StagePlan {
  steps: string[]
  handshake: string | null
}

export class FlowSupervisor {
  private featuresWaiters = new Map<string, FeaturesWaiter>()
  private sessionStage = new Map<string, { runId: string; stage: FlowStage }>()
  private pending = new Map<string, string[]>()
  private current = new Map<string, { text: string; resent: boolean }>()
  private busy = new Set<string>()
  private origins = new Map<string, Record<string, string | null>>()

  constructor(
    private repos: Repositories,
    private manager: SessionManager,
    private callbacks: FlowCallbacks,
    private git: FlowGit = defaultGit,
  ) {}

  private settings(): { flowWorktreeRoot: string } {
    const settings = this.repos.settings.get()
    return { flowWorktreeRoot: settings.flowWorktreeRoot ?? '' }
  }

  reconcileOnStartup(): void {
    for (const projectId of this.repos.flowRuns.reconcileRunning(
      'Switchboard closed while this stage was running. Retry it.',
    )) {
      this.callbacks.onFlowChanged(projectId)
    }
  }

  async features(projectId: string, query: string, timeoutMs = 120_000): Promise<FlowFeature[]> {
    const project = this.requireProject(projectId)
    const session = await this.manager.startSession(project.id, false, project.defaultSessionMode, {
      background: true,
      section: 'flow',
    })
    try {
      await this.requireAdo(session.id)
    } catch (error) {
      this.manager.endFlowSession(session.id)
      throw error
    }
    return new Promise<FlowFeature[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.featuresWaiters.delete(session.id)
        this.manager.endFlowSession(session.id)
        reject({
          code: 'NOT_LIVE',
          message: 'The session did not answer with a Feature list in time.',
        } satisfies IpcError)
      }, timeoutMs)
      timer.unref?.()
      this.featuresWaiters.set(session.id, { resolve, reject, timer })
      this.manager.watchFlow(session.id)
      this.manager.sendMessage(session.id, featuresPrompt(query))
    })
  }

  async existingSpecs(projectId: string): Promise<SpecSummary[]> {
    const project = this.requireProject(projectId)
    const state = await readSpecKitState(project.path)
    return state.specs
  }

  async start(input: {
    projectId: string
    source: FlowStartSource
    autopilot: boolean
    autoShip: boolean
    baseBranch?: string
    companions?: readonly FlowCompanionRequest[]
  }): Promise<FlowRun> {
    const project = this.requireProject(input.projectId)
    const stacks = await detectFlowStacks(project.path)
    if (stacks.length === 0) {
      throw { code: 'UNSUPPORTED', message: 'Flow supports .NET and Angular projects.' } satisfies IpcError
    }
    const companions = await this.companionsFor(project, input.companions ?? [])
    if (input.source.kind === 'spec') await this.requireSpec(project.path, input.source.specId)
    const base = await this.baseFor(project.path, input.baseBranch)

    const title = this.deriveTitle(input.source)
    const override = this.settings().flowWorktreeRoot.trim()
    const root = this.git.root(project.path, override)
    const taken = new Set<string>()
    const others = companions.map((repo) => {
      let folder = `${basename(repo.path)}.worktrees`
      for (let n = 2; taken.has(folder.toLowerCase()); n += 1) folder = `${basename(repo.path)}-${n}.worktrees`
      taken.add(folder.toLowerCase())
      return { repoRoot: repo.path, root: this.git.root(repo.path, override ? join(override, folder) : null) }
    })
    const tree = await this.git.create({ repoRoot: project.path, root, title, base, others })
    const worktreePath = tree.path
    const made: FlowRepo[] = []
    for (const [at, repo] of companions.entries()) {
      try {
        const branch = tree.branch ?? undefined
        const companion = await this.git.create({ repoRoot: repo.path, root: others[at].root, title, base: repo.baseBranch, branch })
        made.push({ ...repo, branch: companion.branch, worktreePath: companion.path })
      } catch (error) {
        for (const done of made.reverse()) {
          await this.git
            .remove(done.path, done.worktreePath ?? '', { force: true, deleteBranch: done.branch ?? undefined })
            .catch(() => {})
        }
        await this.git.remove(project.path, worktreePath, { force: true, deleteBranch: tree.branch ?? undefined }).catch(() => {})
        throw {
          code: 'INTERNAL',
          message: `Flow could not make the worktree in ${repo.name}, so it removed the ones it had made: ${errorText(error)}`,
        } satisfies IpcError
      }
    }
    await copyMissing(project.path, worktreePath, '.specify')

    let specDir: string | null = null
    let startStage: FlowStage = 'spec'
    if (input.source.kind === 'spec') {
      specDir = `specs/${input.source.specId}`
      await copyMissing(project.path, worktreePath, specDir)
      startStage = existsSync(join(worktreePath, specDir, 'tasks.md')) ? 'build' : 'plan'
    }

    const run = this.repos.flowRuns.start({
      projectId: project.id,
      title,
      source: input.source.kind,
      sourceRef:
        input.source.kind === 'ado'
          ? input.source.featureId
          : input.source.kind === 'spec'
            ? input.source.specId
            : null,
      sourceUrl: input.source.kind === 'ado' ? input.source.url : null,
      description: input.source.kind === 'text' ? input.source.description : '',
      stacks: STACK_ORDER.filter((id) => [stacks, ...made.map((repo) => repo.stacks)].some((list) => list.includes(id))),
      stage: startStage,
      autopilot: input.autopilot,
      autoShip: input.autoShip,
      baseBranch: base,
    })
    this.repos.flowStages.ensureAll(run.id)
    for (const stage of FLOW_STAGES) {
      if (FLOW_STAGES.indexOf(stage) < FLOW_STAGES.indexOf(startStage)) {
        this.repos.flowStages.update(run.id, stage, {
          status: 'skipped',
          summary: 'Started from an existing spec.',
          finishedAt: nowIso(),
        })
      }
    }
    const primary: FlowRepo = {
      projectId: project.id,
      name: project.name,
      path: project.path,
      stacks,
      baseBranch: base,
      branch: tree.branch,
      worktreePath,
      prUrl: null,
      prId: null,
    }
    const repos = made.length > 0 ? [primary, ...made] : []
    this.repos.flowRuns.update(run.id, { branch: tree.branch, worktreePath, specDir, repos })
    this.callbacks.onFlowChanged(project.id)
    return this.exclusive(run.id, () => this.beginStage(run.id, startStage))
  }

  approve(runId: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      const stageRow = this.requireAction(run, 'approve')
      this.release(stageRow.sessionId)
      this.repos.flowStages.update(runId, run.stage, { status: 'approved' })
      this.callbacks.onFlowChanged(run.projectId)
      await this.advance(runId, run.stage)
    })
  }

  retry(runId: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      this.requireAction(run, 'retry')
      await this.beginStage(runId, run.stage)
    })
  }

  skip(runId: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      const stageRow = this.requireAction(run, 'skip')
      this.repos.flowStages.update(runId, run.stage, { status: 'skipped', finishedAt: nowIso() })
      this.callbacks.onFlowChanged(run.projectId)
      await this.stopStageSession(stageRow)
      if (this.movedOn(runId, run.stage)) return
      if (run.stage === 'ship') {
        this.repos.flowRuns.finish(runId, 'done', null)
        this.callbacks.onFlowChanged(run.projectId)
        return
      }
      await this.advance(runId, run.stage)
    })
  }

  fix(runId: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      const stageRow = this.requireAction(run, 'fix')
      await this.restartStage(run, stageRow, fixFindingsPrompt(stageRow.report, run), stageRow.feedback)
    })
  }

  revise(runId: string, feedback: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      const stageRow = this.requireAction(run, 'revise')
      await this.restartStage(run, stageRow, revisePrompt(run, run.stage, feedback), feedback)
    })
  }

  ship(runId: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      this.requireAction(run, 'ship')
      await this.beginStage(runId, 'ship')
    })
  }

  async cancel(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    if (run.finishedAt) return run
    const stageRow = this.repos.flowStages.get(runId, run.stage)
    if (stageRow?.status === 'running') {
      this.repos.flowStages.update(runId, run.stage, {
        status: 'failed',
        summary: 'Cancelled.',
        finishedAt: nowIso(),
      })
    }
    this.repos.flowRuns.finish(runId, 'cancelled', 'You stopped this flow.')
    this.callbacks.onFlowChanged(run.projectId)
    if (stageRow) await this.stopStageSession(stageRow)
    return this.requireRun(runId)
  }

  setAutopilot(runId: string, autopilot: boolean): FlowRun {
    this.repos.flowRuns.update(runId, { autopilot })
    const run = this.requireRun(runId)
    this.callbacks.onFlowChanged(run.projectId)
    const row = this.repos.flowStages.get(runId, run.stage)
    if (autopilot && !run.finishedAt && row) {
      if (row.status === 'review') this.maybeAutopilot(runId, run.stage)
      else if (run.stage === 'ship' && row.status === 'pending' && run.autoShip) void this.ship(runId).catch(() => {})
    }
    return run
  }

  async pullRequestUrl(runId: string, projectId?: string): Promise<string> {
    const run = this.requireRun(runId)
    const repo = this.reposOf(run).find((entry) => entry.projectId === (projectId ?? run.projectId))
    if (!repo?.prUrl) throw { code: 'NOT_FOUND', message: 'This run has no pull request yet.' } satisfies IpcError
    const url = allowedPullRequestUrl(repo.prUrl, await this.git.origin(repo.path))
    if (!url) {
      throw {
        code: 'INVALID_PATH',
        message: 'That pull request link is not an https address on GitHub, Azure DevOps or this repository’s own host.',
      } satisfies IpcError
    }
    return url
  }

  private async exclusive(runId: string, work: () => Promise<void>): Promise<FlowRun> {
    if (this.busy.has(runId)) {
      throw { code: 'RULE_NOT_ALLOWED', message: 'Another action on this run is still in progress.' } satisfies IpcError
    }
    this.busy.add(runId)
    try {
      await work()
    } finally {
      this.busy.delete(runId)
    }
    return this.requireRun(runId)
  }

  private movedOn(runId: string, stage: FlowStage): boolean {
    const run = this.repos.flowRuns.byId(runId)
    return !run || run.finishedAt !== null || run.stage !== stage
  }

  private stillOn(runId: string, stage: FlowStage, sessionId: string): boolean {
    const row = this.repos.flowStages.get(runId, stage)
    return !this.movedOn(runId, stage) && row?.status === 'running' && row.sessionId === sessionId
  }

  async removeWorktree(runId: string, force: boolean): Promise<FlowRun> {
    const run = this.requireRun(runId)
    if (!run.worktreePath) return run
    if (!run.finishedAt) {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'This run still uses its worktree. Cancel the run or let it finish first.',
      } satisfies IpcError
    }
    const repos = this.reposOf(run).map((repo) => ({ ...repo }))
    const multi = run.repos.length > 0
    for (const repo of [...repos.slice(1), repos[0]]) {
      if (!repo.worktreePath) continue
      const outcome = await this.git.remove(repo.path, repo.worktreePath, { force })
      if (!outcome.removed) {
        if (multi) this.repos.flowRuns.update(runId, { repos })
        throw {
          code: 'CONFIRM_REQUIRED',
          message: `The worktree${multi ? ` of ${repo.name}` : ''} has ${outcome.dirty.length} uncommitted change${outcome.dirty.length === 1 ? '' : 's'}.`,
        } satisfies IpcError
      }
      repo.worktreePath = null
    }
    this.repos.flowRuns.update(runId, { worktreePath: null, ...(multi ? { repos } : {}) })
    this.callbacks.onFlowChanged(run.projectId)
    return this.requireRun(runId)
  }

  async artefact(
    runId: string,
    stage: FlowStage,
    kind?: FlowArtefactKind,
  ): Promise<{ path: string | null; content: string } | null> {
    const run = this.requireRun(runId)
    const resolvedKind = kind ?? defaultArtefactKind(stage)
    if (resolvedKind === 'report') {
      const stageRow = this.repos.flowStages.get(runId, stage)
      if (!stageRow?.report) return null
      return { path: null, content: JSON.stringify(stageRow.report, null, 2) }
    }
    if (!run.worktreePath) return null
    const rel = artefactRelPath(run.specDir, resolvedKind)
    if (!rel) return null
    if (resolvedKind === 'postman') {
      const dir = resolveArtefactPath(run.worktreePath, rel)
      if (!dir) return null
      try {
        const files = await readdir(dir)
        const file = files.find((name) => name.endsWith('.postman_collection.json'))
        if (!file) return null
        const full = resolveArtefactPath(run.worktreePath, join(rel, file))
        if (!full) return null
        return { path: join(rel, file), content: await readFile(full, 'utf8') }
      } catch {
        return null
      }
    }
    const abs = resolveArtefactPath(run.worktreePath, rel)
    if (!abs) return null
    try {
      return { path: rel, content: await readFile(abs, 'utf8') }
    } catch {
      return null
    }
  }

  onFlowMarker(sessionId: string, marker: FlowMarker): void {
    if (marker.kind === 'features') {
      const waiter = this.featuresWaiters.get(sessionId)
      if (!waiter) return
      this.featuresWaiters.delete(sessionId)
      clearTimeout(waiter.timer)
      this.manager.endFlowSession(sessionId)
      waiter.resolve(marker.features)
      return
    }
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx || ctx.stage !== marker.stage) return
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    if (marker.outcome === 'blocked') {
      this.failStage(ctx.runId, ctx.stage, marker.why ?? marker.summary ?? 'The session reported it was blocked.', {
        retryOnce: false,
      })
      return
    }
    this.completeStage(ctx.runId, ctx.stage, marker)
  }

  onVerifyReport(sessionId: string, report: VerifyReport): void {
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx || ctx.stage !== 'test') return
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    const flowReport: FlowStageReport = { ...emptyFlowStageReport(), verify: report }
    if (report.suites.length > 0 && verifyVerdict(report) === 'pass') {
      this.toReview(ctx.runId, ctx.stage, {
        summary: `${report.suites.length} suite${report.suites.length === 1 ? '' : 's'} passed.`,
        report: flowReport,
      })
      return
    }
    const failed = report.suites.filter((s) => s.status === 'fail').map((s) => s.id)
    const why =
      failed.length > 0
        ? `The following suites failed: ${failed.join(', ')}.`
        : 'No suite reported a pass or fail result — open the session output to see what ran.'
    this.failStage(ctx.runId, ctx.stage, why, { retryOnce: false }, flowReport)
  }

  onSessionEnded(sessionId: string, _reason: SessionEndReason | 'crashed'): void {
    const waiter = this.featuresWaiters.get(sessionId)
    if (waiter) {
      this.featuresWaiters.delete(sessionId)
      clearTimeout(waiter.timer)
      waiter.reject({
        code: 'NOT_LIVE',
        message: 'The session ended before it listed any Features.',
      } satisfies IpcError)
    }
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx) return
    this.sessionStage.delete(sessionId)
    this.pending.delete(sessionId)
    this.current.delete(sessionId)
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    this.failStage(ctx.runId, ctx.stage, SESSION_ENDED, { retryOnce: true })
  }

  onTurnEnded(sessionId: string, error: string | null = null): void {
    const waiter = this.featuresWaiters.get(sessionId)
    if (waiter) {
      this.featuresWaiters.delete(sessionId)
      clearTimeout(waiter.timer)
      this.manager.endFlowSession(sessionId)
      waiter.reject({
        code: 'NOT_LIVE',
        message: error
          ? `The session could not list the Features: ${error}`
          : 'The session answered without a Feature list. Open its output to see what it said.',
      } satisfies IpcError)
      return
    }
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx) return
    const step = this.current.get(sessionId)
    if (error) {
      if (step && !step.resent) {
        step.resent = true
        this.manager.sendMessage(sessionId, step.text)
        return
      }
      this.failStage(ctx.runId, ctx.stage, `A step of this stage failed twice: ${error}`, { retryOnce: false })
      return
    }
    const queue = this.pending.get(sessionId)
    if (queue && queue.length > 0) {
      const next = queue.shift()
      if (next) this.sendStep(sessionId, next)
      return
    }
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    this.failStage(ctx.runId, ctx.stage, ctx.stage === 'test' ? NO_VERIFY_REPORT : NO_REPORT, { retryOnce: true })
  }

  private sendStep(sessionId: string, text: string): void {
    this.current.set(sessionId, { text, resent: false })
    this.manager.sendMessage(sessionId, text)
  }

  private async requireSpec(projectPath: string, specId: string): Promise<void> {
    const state = await readSpecKitState(projectPath)
    if (!state.installed) {
      throw { code: 'UNSUPPORTED', message: 'Spec Kit is not set up in this project yet.' } satisfies IpcError
    }
    if (!state.specs.some((spec) => spec.id === specId) || !existsSync(join(projectPath, 'specs', specId, 'spec.md'))) {
      throw {
        code: 'NOT_FOUND',
        message: 'That spec is not a folder with a spec.md in this project’s specs folder.',
      } satisfies IpcError
    }
  }

  private async baseFor(repoRoot: string, requested: string | undefined, name?: string): Promise<string> {
    const named = requested?.trim()
    if (named) {
      if (named.startsWith('-') || !(await this.git.resolves(repoRoot, named))) {
        throw {
          code: 'INVALID_PATH',
          message: `The base branch "${named}" is not a branch or commit in ${name ?? 'this repository'}.`,
        } satisfies IpcError
      }
      return named
    }
    const current = await this.git.branch(repoRoot)
    if (!current) {
      throw {
        code: 'INVALID_PATH',
        message: `${name ? `The checkout of ${name}` : 'This checkout'} is on a detached HEAD, so Flow cannot tell which branch to build on. Name a base branch and start again.`,
      } satisfies IpcError
    }
    return current
  }

  private async companionsFor(primary: Project, requested: readonly FlowCompanionRequest[]): Promise<FlowRepo[]> {
    const names = new Set([primary.name.toLowerCase()])
    const repos: FlowRepo[] = []
    for (const want of requested) {
      const project = this.repos.projects.byId(want.projectId)
      if (!project || project.archivedAt) {
        throw { code: 'NOT_FOUND', message: 'One of the other repositories is not a registered project any more.' } satisfies IpcError
      }
      if (names.has(project.name.toLowerCase())) {
        throw {
          code: 'DUPLICATE',
          message: `${project.name} is already part of this run. Pick each repository once, and rename a project that shares another's name.`,
        } satisfies IpcError
      }
      names.add(project.name.toLowerCase())
      const stacks = await detectFlowStacks(project.path)
      if (stacks.length === 0) {
        throw {
          code: 'UNSUPPORTED',
          message: `${project.name} has neither a .NET nor an Angular project, and Flow supports only those.`,
        } satisfies IpcError
      }
      repos.push({
        projectId: project.id,
        name: project.name,
        path: project.path,
        stacks,
        baseBranch: await this.baseFor(project.path, want.baseBranch, project.name),
        branch: null,
        worktreePath: null,
        prUrl: null,
        prId: null,
      })
    }
    return repos
  }

  private reposOf(run: FlowRun): FlowRepo[] {
    if (run.repos.length > 0) return run.repos
    const project = this.requireProject(run.projectId)
    return [
      {
        projectId: project.id,
        name: project.name,
        path: project.path,
        stacks: run.stacks,
        baseBranch: run.baseBranch ?? 'main',
        branch: run.branch,
        worktreePath: run.worktreePath,
        prUrl: run.prUrl,
        prId: run.prId,
      },
    ]
  }

  private deriveTitle(source: FlowStartSource): string {
    if (source.kind === 'ado') return source.featureTitle
    if (source.kind === 'text') return source.title
    return source.specId
  }

  private async startStageSession(run: FlowRun, project: Project, stage: FlowStage): Promise<{ id: string }> {
    const session = await this.manager.startSession(project.id, false, project.defaultSessionMode, {
      background: true,
      cwd: run.worktreePath ?? project.path,
      additionalDirectories: run.repos.slice(1).flatMap((repo) => (repo.worktreePath ? [repo.worktreePath] : [])),
      effort: stage === 'build' ? 'max' : undefined,
      section: 'flow',
      denyTool: stage === 'ship' ? shipForbidden : undefined,
    })
    this.manager.renameSession(session.id, `Flow · ${FLOW_STAGE_LABELS[stage]} · ${run.title}`.slice(0, 60))
    return session
  }

  private release(sessionId: string | null): void {
    if (!sessionId) return
    this.sessionStage.delete(sessionId)
    this.pending.delete(sessionId)
    this.current.delete(sessionId)
    this.manager.endFlowSession(sessionId)
  }

  private async stopStageSession(stageRow: FlowStageRecord): Promise<void> {
    this.release(stageRow.sessionId)
    if (stageRow.status === 'running' && stageRow.sessionId) {
      await this.manager
        .stopSession(stageRow.sessionId, 'This Flow stage was stopped before it finished.')
        .catch(() => {})
    }
  }

  private requireAction(run: FlowRun, action: FlowStageAction): FlowStageRecord {
    const stageRow = this.repos.flowStages.get(run.id, run.stage)
    if (!stageRow || !flowStageActions(run, stageRow).includes(action)) {
      throw { code: 'RULE_NOT_ALLOWED', message: REFUSED[action] } satisfies IpcError
    }
    return stageRow
  }

  private async restartStage(
    run: FlowRun,
    stageRow: FlowStageRecord,
    prompt: string,
    feedback: string | null,
  ): Promise<void> {
    const project = this.requireProject(run.projectId)
    this.release(stageRow.sessionId)
    const session = await this.startStageSession(run, project, run.stage)
    if (this.movedOn(run.id, run.stage)) {
      this.release(session.id)
      return
    }
    this.repos.flowStages.update(run.id, run.stage, {
      status: 'running',
      sessionId: session.id,
      attempts: stageRow.attempts + 1,
      startedAt: nowIso(),
      finishedAt: null,
      feedback,
    })
    this.repos.flowRuns.update(run.id, { status: 'running' })
    this.callbacks.onFlowChanged(project.id)
    this.manager.watchFlow(session.id)
    this.sessionStage.set(session.id, { runId: run.id, stage: run.stage })
    await this.prepare(run, run.stage)
    const tail = await this.tailFor(run, run.stage, session.id)
    if (!this.stillOn(run.id, run.stage, session.id)) return
    this.pending.set(session.id, tail)
    this.sendStep(session.id, withRepos(prompt, run.repos))
  }

  private async prepare(run: FlowRun, stage: FlowStage): Promise<void> {
    await this.pinFeature(run, stage)
    if (stage !== 'ship') return
    const hosts: Record<string, string | null> = {}
    for (const repo of this.reposOf(run)) hosts[repo.projectId] = await this.git.origin(repo.path)
    this.origins.set(run.id, hosts)
  }

  private async pinFeature(run: FlowRun, stage: FlowStage): Promise<void> {
    if (stage === 'spec' || !run.specDir || !run.worktreePath) return
    const specify = join(run.worktreePath, '.specify')
    if (!existsSync(specify)) return
    const file = join(specify, 'feature.json')
    let current: Record<string, unknown> = {}
    try {
      current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    } catch {}
    await writeFile(file, `${JSON.stringify({ ...current, feature_directory: run.specDir }, null, 2)}\n`, 'utf8').catch(() => {})
  }

  private resolveSpecDir(run: FlowRun, reported: string | null): string | null {
    const root = run.worktreePath
    if (!root) return null
    let pinned: string | null = null
    try {
      const raw = (JSON.parse(readFileSync(join(root, '.specify', 'feature.json'), 'utf8')) as { feature_directory?: unknown })
        .feature_directory
      pinned = typeof raw === 'string' ? raw : null
    } catch {}
    for (const candidate of [pinned, reported]) {
      if (!candidate) continue
      const rel = (isAbsolute(candidate) ? relative(root, candidate) : candidate).replace(/\\/g, '/').replace(/\/+$/, '')
      const spec = resolveArtefactPath(root, join(rel, 'spec.md'))
      if (rel && spec && existsSync(spec)) return rel
    }
    return null
  }

  private async verifyStepPrompt(run: FlowRun, sessionId: string): Promise<string> {
    const settings = this.repos.settings.get()
    const multi = run.repos.length > 0
    const plans: PlannedSuite[] = []
    const labels: string[] = []
    for (const repo of this.reposOf(run)) {
      const overrides = settings.projectSuiteCommands?.[repo.projectId] ?? {}
      const root = repo.worktreePath ?? repo.path
      const detected = await detectProjectSuites(root).catch(() => [])
      for (const stackId of repo.stacks) {
        const found = detected.find((stack) => stack.stackId === stackId)
        const suites = (found?.suites ?? stackById(stackId)?.suites ?? []).map((suite) =>
          overrides[suite.id] ? { ...suite, command: overrides[suite.id] } : suite,
        )
        if (suites.length === 0) continue
        const planned = planSuites(suites, defaultSelection(suites))
        const label = found?.stackLabel ?? stackById(stackId)?.label ?? stackId
        plans.push(
          ...(multi ? planned.map((entry) => ({ ...entry, suite: inRepository(entry.suite, repo.name, root) })) : planned),
        )
        labels.push(multi ? `${repo.name} (${label})` : label)
      }
    }
    const dbServers = await this.manager.connectedMcpServers(sessionId, settings.databaseMcpServers ?? [])
    return buildVerifyPrompt(plans, labels.join(' + ') || 'project', dbServers)
  }

  private async shipTest(run: FlowRun): Promise<{ verify: VerifyReport | null; postman: string | null }> {
    const verify = this.repos.flowStages.get(run.id, 'test')?.report?.verify ?? null
    const postman = (await this.artefact(run.id, 'test', 'postman'))?.path?.replace(/\\/g, '/') ?? null
    return { verify, postman }
  }

  private async planFor(run: FlowRun, stage: FlowStage, sessionId: string): Promise<StagePlan> {
    const base = run.baseBranch ?? 'main'
    const repos = run.repos
    switch (stage) {
      case 'spec':
        return { steps: [specifyPrompt(run), clarifyPrompt(run.autopilot)], handshake: specHandshake() }
      case 'plan':
        return { steps: planSteps(run.stacks, run.specDir, repos), handshake: planHandshake() }
      case 'build':
        return { steps: buildSteps(run.stacks, run.specDir, repos), handshake: buildHandshake() }
      case 'clean':
        return { steps: cleanSteps(run.stacks, base, repos), handshake: cleanHandshake() }
      case 'test':
        return {
          steps: [testWritePrompt(run, run.stacks, repos), await this.verifyStepPrompt(run, sessionId)],
          handshake: null,
        }
      case 'review':
        return {
          steps: reviewSteps(run.stacks, base, repos),
          handshake: reviewHandshake(base, run.specDir, run.stacks, repos),
        }
      case 'ship':
        return { steps: [], handshake: shipPrompt(run, await this.shipTest(run), repos) }
    }
  }

  private async tailFor(run: FlowRun, stage: FlowStage, sessionId: string): Promise<string[]> {
    if (stage === 'test') return [await this.verifyStepPrompt(run, sessionId)]
    const plan = await this.planFor(run, stage, sessionId)
    return plan.handshake ? [plan.handshake] : []
  }

  private async beginStage(runId: string, stage: FlowStage): Promise<void> {
    const run = this.requireRun(runId)
    if (this.movedOn(runId, stage)) return
    const project = this.requireProject(run.projectId)
    const stageRow = this.repos.flowStages.get(runId, stage)
    this.release(stageRow?.sessionId ?? null)
    let session: { id: string }
    try {
      session = await this.startStageSession(run, project, stage)
    } catch (error) {
      if (!this.movedOn(runId, stage)) this.failStage(runId, stage, errorText(error), { retryOnce: false })
      return
    }
    if (this.movedOn(runId, stage)) {
      this.release(session.id)
      return
    }
    this.repos.flowStages.update(runId, stage, {
      status: 'running',
      sessionId: session.id,
      attempts: (stageRow?.attempts ?? 0) + 1,
      summary: null,
      feedback: null,
      startedAt: nowIso(),
      finishedAt: null,
    })
    this.repos.flowRuns.update(runId, { stage, status: 'running' })
    this.callbacks.onFlowChanged(project.id)
    this.manager.watchFlow(session.id)
    this.sessionStage.set(session.id, { runId, stage })
    if (stage === 'spec' && run.source === 'ado') {
      try {
        await this.requireAdo(session.id)
      } catch (error) {
        if (this.stillOn(runId, stage, session.id)) this.failStage(runId, stage, errorText(error), { retryOnce: false })
        return
      }
    }
    await this.prepare(run, stage)
    const plan = await this.planFor(run, stage, session.id)
    if (!this.stillOn(runId, stage, session.id)) return
    const queue = [...plan.steps]
    if (plan.handshake) queue.push(plan.handshake)
    const first = queue.shift()
    this.pending.set(session.id, queue)
    if (first) this.sendStep(session.id, withRepos(first, run.repos))
  }

  private completeStage(runId: string, stage: FlowStage, marker: FlowStageMarker): void {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) return
    const patch: Parameters<Repositories['flowRuns']['update']>[1] = {}
    if (stage === 'spec') patch.specDir = this.resolveSpecDir(run, marker.specDir)
    let prUrl = marker.prUrl
    let prId = marker.prId
    let summary = marker.summary || null
    if (stage === 'ship') {
      const hosts = this.origins.get(runId) ?? {}
      const dropped: string[] = []
      const unreported: string[] = []
      const keep = (repo: Pick<FlowRepo, 'name' | 'projectId'>, raw: string | null): string | null => {
        const url = allowedPullRequestUrl(raw, hosts[repo.projectId] ?? null)
        if (raw && !url) dropped.push(repo.name)
        return url
      }
      if (run.repos.length > 0) {
        const repos = run.repos.map((repo) => {
          const name = repo.name.toLowerCase()
          const reported = marker.pullRequests.find((pr) => {
            const label = pr.repository.trim().toLowerCase()
            return label === name || label.startsWith(`${name} (`)
          })
          if (!reported) unreported.push(repo.name)
          return { ...repo, prUrl: keep(repo, reported?.prUrl ?? null), prId: reported?.prId ?? null }
        })
        patch.repos = repos
        prUrl = repos[0].prUrl
        prId = repos[0].prId
      } else {
        prUrl = keep({ name: '', projectId: run.projectId }, marker.prUrl)
      }
      patch.prUrl = prUrl
      patch.prId = prId
      if (dropped.length > 0) {
        const whose = run.repos.length > 0 ? ` for ${dropped.join(' and ')}` : ''
        summary = [summary, `The reported pull request link${whose} was not an https address on an allowed host, so it was not kept.`]
          .filter(Boolean)
          .join(' ')
      }
      if (unreported.length > 0) {
        summary = [summary, `The Ship session reported no pull request for ${unreported.join(' or ')}.`].filter(Boolean).join(' ')
      }
    }
    const mustFix = marker.findings.some((finding) => finding.severity === 'must_fix')
    const verdict =
      stage === 'review'
        ? marker.verdict === 'ready' && !mustFix && marker.unmet.length === 0
          ? 'ready'
          : 'needs_fixes'
        : marker.verdict
    this.toReview(
      runId,
      stage,
      {
        summary,
        report: {
          tasksDone: marker.tasksDone,
          tasksTotal: marker.tasksTotal,
          verdict,
          findings: marker.findings,
          unmet: marker.unmet,
          prUrl,
          prId,
          verify: null,
        },
      },
      patch,
    )
  }

  private toReview(
    runId: string,
    stage: FlowStage,
    result: { summary: string | null; report: FlowStageReport },
    runPatch: Parameters<Repositories['flowRuns']['update']>[1] = {},
  ): void {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) return
    this.release(this.repos.flowStages.get(runId, stage)?.sessionId ?? null)
    this.repos.flowStages.update(runId, stage, {
      status: 'review',
      summary: result.summary,
      report: result.report,
      finishedAt: nowIso(),
    })
    this.repos.flowRuns.update(runId, { ...runPatch, status: 'waiting' })
    this.callbacks.onFlowChanged(run.projectId)
    this.maybeAutopilot(runId, stage)
  }

  private failStage(
    runId: string,
    stage: FlowStage,
    why: string,
    opts: { retryOnce: boolean },
    report?: FlowStageReport | null,
  ): void {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) return
    const stageRow = this.repos.flowStages.get(runId, stage)
    this.release(stageRow?.sessionId ?? null)
    this.repos.flowStages.update(runId, stage, {
      status: 'failed',
      summary: why,
      report: report ?? stageRow?.report ?? null,
      finishedAt: nowIso(),
    })
    this.repos.flowRuns.update(runId, { status: 'waiting' })
    this.callbacks.onFlowChanged(run.projectId)
    if (opts.retryOnce && run.autopilot && stageRow?.attempts === 1) {
      void this.retry(runId).catch(() => {})
    }
  }

  private maybeAutopilot(runId: string, stage: FlowStage): void {
    const run = this.repos.flowRuns.byId(runId)
    if (!run?.autopilot || run.finishedAt) return
    const stageRow = this.repos.flowStages.get(runId, stage)
    if (!stageRow || stageRow.status !== 'review') return
    const report = stageRow.report
    if (stage === 'build' && report?.tasksDone != null && report.tasksTotal != null && report.tasksDone < report.tasksTotal) {
      return
    }
    if (stage === 'review' && report?.verdict !== 'ready') {
      if (report?.verdict === 'needs_fixes' && stageRow.attempts <= MAX_FIX_ROUNDS) void this.fix(runId).catch(() => {})
      return
    }
    void this.approve(runId).catch(() => {})
  }

  private async advance(runId: string, from: FlowStage): Promise<void> {
    if (this.movedOn(runId, from)) return
    const run = this.requireRun(runId)
    const next = FLOW_STAGES[FLOW_STAGES.indexOf(from) + 1]
    if (!next) {
      this.repos.flowRuns.finish(runId, 'done', null)
      this.callbacks.onFlowChanged(run.projectId)
      return
    }
    this.repos.flowRuns.update(runId, { stage: next, status: 'waiting' })
    this.callbacks.onFlowChanged(run.projectId)
    if (next === 'ship' && !(run.autopilot && run.autoShip)) return
    await this.beginStage(runId, next)
  }

  private requireRun(runId: string): FlowRun {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    return run
  }

  private requireProject(projectId: string): Project {
    const project = this.repos.projects.byId(projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
    return project
  }

  private async requireAdo(sessionId: string): Promise<void> {
    const connected = await this.manager.connectedMcpServers(sessionId, [ADO_SERVER], ADO_WAIT_MS)
    if (connected.includes(ADO_SERVER)) return
    throw {
      code: 'NOT_LIVE',
      message:
        'The Azure DevOps MCP server is not connected for this session, so Flow cannot read or write the board. Check the ado server in your Claude Code configuration and try again.',
    } satisfies IpcError
  }
}
