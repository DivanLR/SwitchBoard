import { existsSync } from 'node:fs'
import { cp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
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
import type { FlowArtefactKind, FlowStartSource, IpcError } from '@shared/ipc-types'
import { nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import {
  ANALYZE_PROMPT,
  TASKS_PROMPT,
  buildHandshake,
  buildSteps,
  cleanHandshake,
  cleanSteps,
  clarifyPrompt,
  fixFindingsPrompt,
  planHandshake,
  planPrompt,
  reviewHandshake,
  reviewSteps,
  revisePrompt,
  shipPrompt,
  specHandshake,
  specifyPrompt,
  testWritePrompt,
  featuresPrompt,
} from './flow-prompts'
import type { FlowMarker, FlowStageMarker } from './flow-markers'
import { artefactRelPath, defaultArtefactKind, resolveArtefactPath } from './artefacts'
import { detectFlowStacks } from './stacks'
import { readSpecKitState } from '@main/specs/spec-kit'
import { defaultSelection, stackById } from '@shared/test-catalog'
import { planSuites, verifyPrompt as buildVerifyPrompt, type PlannedSuite } from '@main/evals/verify-dispatch'
import { createWorktree, currentBranch, removeWorktree, resolvesToCommit, worktreeRoot } from './worktrees'
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
}

const defaultGit: FlowGit = {
  create: createWorktree,
  remove: removeWorktree,
  branch: currentBranch,
  root: worktreeRoot,
  resolves: resolvesToCommit,
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

interface StagePlan {
  steps: string[]
  handshake: string | null
}

export class FlowSupervisor {
  private featuresWaiters = new Map<string, FeaturesWaiter>()
  private sessionStage = new Map<string, { runId: string; stage: FlowStage }>()
  private pending = new Map<string, string[]>()

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
    const session = await this.manager.startSession(project.id, false, project.defaultSessionMode, undefined, {
      background: true,
    })
    this.manager.markSection(session.id, 'flow')
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
  }): Promise<FlowRun> {
    const project = this.requireProject(input.projectId)
    const stacks = await detectFlowStacks(project.path)
    if (stacks.length === 0) {
      throw { code: 'UNSUPPORTED', message: 'Flow supports .NET and Angular projects.' } satisfies IpcError
    }
    if (input.source.kind === 'spec') await this.requireSpec(project.path, input.source.specId)
    const base = await this.baseFor(project.path, input.baseBranch)

    const title = this.deriveTitle(input.source)
    const root = this.git.root(project.path, this.settings().flowWorktreeRoot)
    const tree = await this.git.create({ repoRoot: project.path, root, title, base })
    const worktreePath = tree.path
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
      stacks,
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
    this.repos.flowRuns.update(run.id, { branch: tree.branch, worktreePath, specDir })
    this.callbacks.onFlowChanged(project.id)
    await this.beginStage(run.id, startStage)
    return this.requireRun(run.id)
  }

  async approve(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    const stageRow = this.requireAction(run, 'approve')
    this.release(stageRow.sessionId)
    this.repos.flowStages.update(runId, run.stage, { status: 'approved' })
    this.callbacks.onFlowChanged(run.projectId)
    await this.advance(runId)
    return this.requireRun(runId)
  }

  async retry(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    this.requireAction(run, 'retry')
    await this.beginStage(runId, run.stage)
    return this.requireRun(runId)
  }

  async skip(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    const stageRow = this.requireAction(run, 'skip')
    await this.stopStageSession(stageRow)
    this.repos.flowStages.update(runId, run.stage, { status: 'skipped', finishedAt: nowIso() })
    this.callbacks.onFlowChanged(run.projectId)
    if (run.stage === 'ship') {
      this.repos.flowRuns.finish(runId, 'done', null)
      this.callbacks.onFlowChanged(run.projectId)
      return this.requireRun(runId)
    }
    await this.advance(runId)
    return this.requireRun(runId)
  }

  async fix(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    const stageRow = this.requireAction(run, 'fix')
    await this.restartStage(run, stageRow, fixFindingsPrompt(stageRow.report, run), stageRow.feedback)
    return this.requireRun(runId)
  }

  async revise(runId: string, feedback: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    const stageRow = this.requireAction(run, 'revise')
    await this.restartStage(run, stageRow, revisePrompt(run, run.stage, feedback), feedback)
    return this.requireRun(runId)
  }

  async ship(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    this.requireAction(run, 'ship')
    await this.beginStage(runId, 'ship')
    return this.requireRun(runId)
  }

  async cancel(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    if (run.finishedAt) return run
    const stageRow = this.repos.flowStages.get(runId, run.stage)
    if (stageRow) await this.stopStageSession(stageRow)
    if (stageRow && stageRow.status === 'running') {
      this.repos.flowStages.update(runId, run.stage, {
        status: 'failed',
        summary: 'Cancelled.',
        finishedAt: nowIso(),
      })
    }
    this.repos.flowRuns.finish(runId, 'cancelled', 'You stopped this flow.')
    this.callbacks.onFlowChanged(run.projectId)
    return this.requireRun(runId)
  }

  setAutopilot(runId: string, autopilot: boolean): FlowRun {
    this.repos.flowRuns.update(runId, { autopilot })
    const run = this.requireRun(runId)
    this.callbacks.onFlowChanged(run.projectId)
    return run
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
    const project = this.requireProject(run.projectId)
    const outcome = await this.git.remove(project.path, run.worktreePath, { force })
    if (!outcome.removed) {
      throw {
        code: 'CONFIRM_REQUIRED',
        message: `The worktree has ${outcome.dirty.length} uncommitted change${outcome.dirty.length === 1 ? '' : 's'}.`,
      } satisfies IpcError
    }
    this.repos.flowRuns.update(runId, { worktreePath: null })
    this.callbacks.onFlowChanged(project.id)
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
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    this.failStage(ctx.runId, ctx.stage, SESSION_ENDED, { retryOnce: true })
  }

  onTurnEnded(sessionId: string): void {
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx) return
    const queue = this.pending.get(sessionId)
    if (queue && queue.length > 0) {
      const next = queue.shift()
      if (next) this.manager.sendMessage(sessionId, next)
      return
    }
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    this.failStage(ctx.runId, ctx.stage, ctx.stage === 'test' ? NO_VERIFY_REPORT : NO_REPORT, { retryOnce: true })
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

  private async baseFor(repoRoot: string, requested: string | undefined): Promise<string> {
    const named = requested?.trim()
    if (named) {
      if (named.startsWith('-') || !(await this.git.resolves(repoRoot, named))) {
        throw {
          code: 'INVALID_PATH',
          message: `The base branch "${named}" is not a branch or commit in this repository.`,
        } satisfies IpcError
      }
      return named
    }
    const current = await this.git.branch(repoRoot)
    if (!current) {
      throw {
        code: 'INVALID_PATH',
        message: 'This checkout is on a detached HEAD, so Flow cannot tell which branch to build on. Name a base branch and start again.',
      } satisfies IpcError
    }
    return current
  }

  private deriveTitle(source: FlowStartSource): string {
    if (source.kind === 'ado') return source.featureTitle
    if (source.kind === 'text') return source.title
    return source.specId
  }

  private async startStageSession(run: FlowRun, project: Project, stage: FlowStage): Promise<{ id: string }> {
    const settings = this.repos.settings.get()
    const effort = stage === 'build' ? 'max' : settings.effort
    const session = await this.manager.startSession(project.id, false, project.defaultSessionMode, undefined, {
      background: true,
      cwd: run.worktreePath ?? project.path,
      effort,
    })
    this.manager.markSection(session.id, 'flow')
    this.manager.renameSession(session.id, `Flow · ${FLOW_STAGE_LABELS[stage]} · ${run.title}`.slice(0, 60))
    return session
  }

  private release(sessionId: string | null): void {
    if (!sessionId) return
    this.sessionStage.delete(sessionId)
    this.pending.delete(sessionId)
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
    this.pending.set(session.id, this.tailFor(run, run.stage))
    this.manager.sendMessage(session.id, prompt)
  }

  private verifyStepPrompt(run: FlowRun): string {
    const plans: PlannedSuite[] = []
    for (const stackId of run.stacks) {
      const stack = stackById(stackId)
      if (!stack) continue
      plans.push(...planSuites(stack.suites, defaultSelection(stack.suites)))
    }
    const label = run.stacks.map((id) => stackById(id)?.label ?? id).join(' + ') || 'project'
    return buildVerifyPrompt(plans, label)
  }

  private planFor(run: FlowRun, stage: FlowStage): StagePlan {
    const base = run.baseBranch ?? 'main'
    switch (stage) {
      case 'spec':
        return { steps: [specifyPrompt(run), clarifyPrompt(run.autopilot)], handshake: specHandshake() }
      case 'plan':
        return { steps: [planPrompt(run.stacks), TASKS_PROMPT, ANALYZE_PROMPT], handshake: planHandshake() }
      case 'build':
        return { steps: buildSteps(run.stacks), handshake: buildHandshake() }
      case 'clean':
        return { steps: cleanSteps(run.stacks, base), handshake: cleanHandshake() }
      case 'test':
        return { steps: [testWritePrompt(run, run.stacks), this.verifyStepPrompt(run)], handshake: null }
      case 'review':
        return { steps: reviewSteps(run.stacks, base), handshake: reviewHandshake(base) }
      case 'ship':
        return { steps: [], handshake: shipPrompt(run) }
    }
  }

  private tailFor(run: FlowRun, stage: FlowStage): string[] {
    if (stage === 'test') return [this.verifyStepPrompt(run)]
    const plan = this.planFor(run, stage)
    return plan.handshake ? [plan.handshake] : []
  }

  private async beginStage(runId: string, stage: FlowStage): Promise<void> {
    const run = this.requireRun(runId)
    const project = this.requireProject(run.projectId)
    const stageRow = this.repos.flowStages.get(runId, stage)
    this.release(stageRow?.sessionId ?? null)
    let session: { id: string }
    try {
      session = await this.startStageSession(run, project, stage)
    } catch (error) {
      this.repos.flowRuns.update(runId, { stage })
      this.failStage(runId, stage, errorText(error), { retryOnce: false })
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
        this.failStage(runId, stage, errorText(error), { retryOnce: false })
        return
      }
    }
    const plan = this.planFor(run, stage)
    const queue = [...plan.steps]
    if (plan.handshake) queue.push(plan.handshake)
    const first = queue.shift()
    this.pending.set(session.id, queue)
    if (first) this.manager.sendMessage(session.id, first)
  }

  private completeStage(runId: string, stage: FlowStage, marker: FlowStageMarker): void {
    const patch: Parameters<Repositories['flowRuns']['update']>[1] = {}
    if (stage === 'spec' && marker.specDir) patch.specDir = marker.specDir
    if (stage === 'ship') {
      patch.prUrl = marker.prUrl
      patch.prId = marker.prId
    }
    this.toReview(
      runId,
      stage,
      {
        summary: marker.summary || null,
        report: {
          tasksDone: marker.tasksDone,
          tasksTotal: marker.tasksTotal,
          verdict: marker.verdict,
          findings: marker.findings,
          unmet: marker.unmet,
          prUrl: marker.prUrl,
          prId: marker.prId,
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
    if (!run?.autopilot) return
    const stageRow = this.repos.flowStages.get(runId, stage)
    if (!stageRow || stageRow.status !== 'review') return
    if (stage === 'review' && stageRow.report?.verdict === 'needs_fixes') {
      if (stageRow.attempts <= MAX_FIX_ROUNDS) void this.fix(runId).catch(() => {})
      return
    }
    void this.approve(runId).catch(() => {})
  }

  private async advance(runId: string): Promise<void> {
    const run = this.requireRun(runId)
    const idx = FLOW_STAGES.indexOf(run.stage)
    const next = FLOW_STAGES[idx + 1]
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
