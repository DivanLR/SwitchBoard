import type { FlowFeature, FlowItem, FlowRun, ScopedItem, SessionEndReason } from '@shared/domain'
import { flowRuleId } from '@shared/domain'
import type { IpcError } from '@shared/ipc-types'
import { nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import {
  crosscheckPrompt,
  featuresPrompt,
  implementPrompt,
  lessonsPrompt,
  prPrompt,
  publishPrompt,
  reviseScopePrompt,
  scopePrompt,
} from './flow-prompts'
import { appendRule } from './claude-md'
import { branchNameFor, createWorktree, currentBranch, worktreeDirty, worktreePathFor, worktreeRoot } from './worktrees'
import type { FlowMarker } from './flow-markers'

export const ADO_SERVER = 'ado'

const ADO_WAIT_MS = 30_000

export const MAX_ITEM_ATTEMPTS = 3

export const FLOW_BACKOFF_MS = [5_000, 30_000, 120_000] as const

export const MAX_CROSSCHECK_ROUNDS = 2

const SCOPE_LOST =
  'The scoping session ended without handing back a breakdown. Nothing was written to Azure DevOps.'

const PUBLISH_LOST =
  'The publishing session ended before it reported. Work items may or may not have been created, so check the Feature in Azure DevOps before retrying.'

interface FlowCallbacks {
  onFlowChanged: (projectId: string) => void
}

type FeaturesWaiter = {
  resolve: (features: FlowFeature[]) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export interface FlowGit {
  create: (input: { repoRoot: string; path: string; branch: string; base: string }) => Promise<unknown>
  dirty: (path: string) => Promise<string[]>
  branch: (path: string) => Promise<string>
  root: (projectPath: string, override?: string | null) => string
}

const defaultGit: FlowGit = {
  create: createWorktree,
  dirty: worktreeDirty,
  branch: currentBranch,
  root: worktreeRoot,
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(error)
}

export class FlowSupervisor {
  private featuresWaiters = new Map<string, FeaturesWaiter>()
  private backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pumping = new Set<string>()

  constructor(
    private repos: Repositories,
    private manager: SessionManager,
    private callbacks: FlowCallbacks,
    private git: FlowGit = defaultGit,
  ) {}

  private settings(): { flowConcurrency: number; flowWorktreeRoot: string } {
    const settings = this.repos.settings.get()
    return {
      flowConcurrency: Math.min(8, Math.max(1, settings.flowConcurrency ?? 4)),
      flowWorktreeRoot: settings.flowWorktreeRoot ?? '',
    }
  }

  reconcileOnStartup(): void {
    for (const projectId of this.repos.flowRuns.reconcileRunning(
      'Switchboard closed while this run was working, so it was stopped on the next launch.',
    )) {
      this.callbacks.onFlowChanged(projectId)
    }
  }

  async features(projectId: string, query: string, timeoutMs = 120_000): Promise<FlowFeature[]> {
    const session = await this.flowSession(projectId)
    await this.requireAdo(session.id)
    return new Promise<FlowFeature[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.featuresWaiters.delete(session.id)
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

  async start(input: {
    projectId: string
    featureId: string
    featureTitle: string
  }): Promise<FlowRun> {
    if (this.repos.flowRuns.openFor(input.projectId)) {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'A flow is already open for this project. Finish or cancel it first.',
      } satisfies IpcError
    }
    const session = await this.manager.startSession(input.projectId, false, 'plan', undefined, {
      background: true,
      engine: 'claude',
    })
    await this.requireAdo(session.id)
    this.manager.markSection(session.id, 'flow')
    this.manager.renameSession(session.id, `Flow: ${input.featureTitle}`.slice(0, 60))
    const run = this.repos.flowRuns.start({
      ...input,
      sessionId: session.id,
      concurrency: this.settings().flowConcurrency,
    })
    this.manager.watchFlow(session.id)
    this.manager.sendMessage(
      session.id,
      scopePrompt({ featureId: input.featureId, featureTitle: input.featureTitle }),
    )
    this.callbacks.onFlowChanged(input.projectId)
    return run
  }

  saveItems(runId: string, items: readonly ScopedItem[]): FlowItem[] {
    const run = this.requireRun(runId)
    if (run.status !== 'awaiting_approval') {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'This run is not waiting for a breakdown to be approved.',
      } satisfies IpcError
    }
    const saved = this.repos.flowItems.replaceForRun(runId, run.projectId, items)
    this.callbacks.onFlowChanged(run.projectId)
    return saved
  }

  async publish(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    if (run.status !== 'awaiting_approval' && run.status !== 'publish_interrupted') {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'This run is not ready to write its items to Azure DevOps.',
      } satisfies IpcError
    }
    const items = this.repos.flowItems.listForRun(runId).filter((item) => item.status === 'proposed')
    if (items.length === 0) {
      throw {
        code: 'INVALID_PATH',
        message: 'There is nothing to create: every item is already in Azure DevOps.',
      } satisfies IpcError
    }
    const session = await this.flowSession(run.projectId, run.sessionId)
    await this.requireAdo(session.id)
    this.repos.flowRuns.update(runId, { status: 'publishing', sessionId: session.id, note: null })
    this.manager.watchFlow(session.id)
    this.manager.sendMessage(session.id, publishPrompt({ run, items }))
    this.callbacks.onFlowChanged(run.projectId)
    return this.requireRun(runId)
  }

  private async crosscheck(runId: string, items: readonly ScopedItem[]): Promise<void> {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) return
    try {
      // Lead B is always a fresh session: a reviewer that shares the author's context
      // is not a second opinion.
      const session = await this.manager.startSession(run.projectId, false, 'plan', undefined, {
        background: true,
        engine: 'claude',
      })
      this.manager.markSection(session.id, 'flow')
      this.manager.renameSession(session.id, `Flow review: ${run.featureTitle}`.slice(0, 60))
      this.repos.flowRuns.update(runId, { sessionId: session.id })
      this.manager.watchFlow(session.id)
      this.manager.sendMessage(
        session.id,
        crosscheckPrompt({
          featureId: run.featureId,
          featureTitle: run.featureTitle,
          items,
          round: run.crosscheckRound,
        }),
      )
    } catch (error) {
      this.repos.flowRuns.update(runId, {
        status: 'awaiting_approval',
        note: `The cross-check could not run (${errorText(error)}), so this breakdown has had one pair of eyes only.`,
      })
      this.callbacks.onFlowChanged(run.projectId)
    }
  }

  private settleSignoff(
    run: FlowRun,
    verdict: 'approve' | 'revise',
    concerns: string[],
    revised: ScopedItem[] | null,
  ): void {
    if (verdict === 'approve') {
      this.repos.flowRuns.update(run.id, {
        status: 'awaiting_approval',
        concerns,
        note: concerns.length > 0 ? 'The reviewer approved it, with notes.' : null,
      })
      this.callbacks.onFlowChanged(run.projectId)
      return
    }
    if (revised) this.repos.flowItems.replaceForRun(run.id, run.projectId, revised)
    const round = run.crosscheckRound + 1
    if (round >= MAX_CROSSCHECK_ROUNDS) {
      this.repos.flowRuns.update(run.id, {
        status: 'awaiting_approval',
        crosscheckRound: round,
        concerns,
        note: `The two sessions did not agree after ${round} rounds, so the breakdown is yours to settle.`,
      })
      this.callbacks.onFlowChanged(run.projectId)
      return
    }
    this.repos.flowRuns.update(run.id, { status: 'scoping', crosscheckRound: round, concerns })
    this.callbacks.onFlowChanged(run.projectId)
    void this.relayConcerns(run.id, concerns)
  }

  private async relayConcerns(runId: string, concerns: string[]): Promise<void> {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) return
    try {
      const session = await this.manager.startSession(run.projectId, false, 'plan', undefined, {
        background: true,
        engine: 'claude',
      })
      this.manager.markSection(session.id, 'flow')
      this.manager.renameSession(session.id, `Flow rescope: ${run.featureTitle}`.slice(0, 60))
      this.repos.flowRuns.update(runId, { sessionId: session.id })
      this.manager.watchFlow(session.id)
      this.manager.sendMessage(session.id, reviseScopePrompt(concerns))
    } catch (error) {
      this.repos.flowRuns.update(runId, {
        status: 'awaiting_approval',
        note: `The revision could not be dispatched (${errorText(error)}). The reviewer's concerns are below, unanswered.`,
      })
      this.callbacks.onFlowChanged(run.projectId)
    }
  }

  async learn(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    const items = this.repos.flowItems.listForRun(runId)
    if (!items.some((item) => item.prId)) {
      throw {
        code: 'INVALID_PATH',
        message: 'No pull request was raised for this feature, so there are no comments to read.',
      } satisfies IpcError
    }
    const session = await this.manager.startSession(run.projectId, false, 'plan', undefined, {
      background: true,
      engine: 'claude',
    })
    await this.requireAdo(session.id)
    this.manager.markSection(session.id, 'flow')
    this.manager.renameSession(session.id, `Flow lessons: ${run.featureTitle}`.slice(0, 60))
    this.repos.flowRuns.update(runId, { status: 'learning', sessionId: session.id, note: null })
    this.manager.watchFlow(session.id)
    this.manager.sendMessage(
      session.id,
      lessonsPrompt({ run, items, rejected: this.repos.flowLessons.rejectedRules(run.projectId) }),
    )
    this.callbacks.onFlowChanged(run.projectId)
    return this.requireRun(runId)
  }

  async decideLesson(
    lessonId: string,
    accept: boolean,
    reason: string | null,
  ): Promise<{ appliedLines: number; path: string | null }> {
    const lesson = this.repos.flowLessons.byId(lessonId)
    if (!lesson) throw { code: 'NOT_FOUND', message: 'Lesson not found' } satisfies IpcError
    if (!accept) {
      this.repos.flowLessons.decide(lessonId, 'rejected', reason)
      this.callbacks.onFlowChanged(lesson.projectId)
      return { appliedLines: 0, path: null }
    }
    const project = this.repos.projects.byId(lesson.projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
    const written = await appendRule(project.path, lesson)
    this.repos.flowLessons.decide(lessonId, 'accepted', reason)
    this.callbacks.onFlowChanged(lesson.projectId)
    return written
  }

  async startWork(runId: string): Promise<FlowRun> {
    const run = this.requireRun(runId)
    if (run.status !== 'ready' && run.status !== 'implementing') {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'This run has no work items in Azure DevOps yet.',
      } satisfies IpcError
    }
    const project = this.repos.projects.byId(run.projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError

    const dirty = await this.git.dirty(project.path)
    if (dirty.length > 0) {
      throw {
        code: 'CONFIRM_REQUIRED',
        message: `The main checkout has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}, and every work item branches from it. Commit or stash them first — Flow will not do that for you.`,
      } satisfies IpcError
    }

    const queued = this.repos.flowItems.queuePublished(runId)
    if (queued === 0 && this.repos.flowItems.countActive(runId) === 0) {
      throw {
        code: 'INVALID_PATH',
        message: 'There is nothing to work on: no item reached Azure DevOps.',
      } satisfies IpcError
    }
    this.repos.flowRuns.update(runId, {
      status: 'implementing',
      baseBranch: run.baseBranch ?? (await this.git.branch(project.path)),
      worktreeRoot: run.worktreeRoot ?? this.git.root(project.path, this.settings().flowWorktreeRoot),
      note: null,
    })
    this.callbacks.onFlowChanged(run.projectId)
    await this.pump(runId)
    return this.requireRun(runId)
  }

  async retryItem(itemId: string): Promise<void> {
    const item = this.repos.flowItems.byId(itemId)
    if (!item) throw { code: 'NOT_FOUND', message: 'Work item not found' } satisfies IpcError
    if (item.sessionId) await this.manager.interruptSession(item.sessionId).catch(() => {})
    this.repos.flowItems.update(itemId, {
      status: 'queued',
      attempts: 0,
      sessionId: null,
      note: null,
    })
    this.callbacks.onFlowChanged(item.projectId)
    void this.pump(item.runId)
  }

  private async pump(runId: string): Promise<void> {
    if (this.pumping.has(runId)) return
    this.pumping.add(runId)
    try {
      await this.fill(runId)
    } finally {
      this.pumping.delete(runId)
    }
  }

  private async fill(runId: string): Promise<void> {
    const run = this.repos.flowRuns.byId(runId)
    if (!run || run.status !== 'implementing') return
    while (this.repos.flowItems.countActive(runId) < run.concurrency) {
      const next = this.repos.flowItems.nextQueued(runId)
      if (!next) break
      this.repos.flowItems.update(next.id, { status: 'preparing', startedAt: nowIso() })
      await this.beginItem(run, next.id)
    }
    const items = this.repos.flowItems.listForRun(runId)
    const settled = items.every((item) =>
      ['pr_open', 'done', 'failed', 'blocked', 'cancelled'].includes(item.status),
    )
    if (settled && items.length > 0) {
      this.repos.flowRuns.update(runId, { status: 'ready', note: null })
    }
    this.callbacks.onFlowChanged(run.projectId)
  }

  private async beginItem(run: FlowRun, itemId: string): Promise<void> {
    const item = this.repos.flowItems.byId(itemId)
    const project = this.repos.projects.byId(run.projectId)
    if (!item || !project) return
    const branch = item.branch ?? branchNameFor(item.workItemId ?? item.localId, item.title)
    const root = run.worktreeRoot ?? this.git.root(project.path, this.settings().flowWorktreeRoot)
    const path = item.worktreePath ?? worktreePathFor(root, branch)
    try {
      await this.git.create({
        repoRoot: project.path,
        path,
        branch,
        base: run.baseBranch ?? 'HEAD',
      })
    } catch (error) {
      this.repos.flowItems.update(itemId, {
        status: 'blocked',
        note: `The worktree could not be created: ${errorText(error)}`,
      })
      return
    }
    this.repos.flowItems.update(itemId, { branch, worktreePath: path })
    await this.startImplementer(run, itemId)
  }

  private async startImplementer(run: FlowRun, itemId: string): Promise<void> {
    const item = this.repos.flowItems.byId(itemId)
    if (!item?.worktreePath || !item.branch) return
    try {
      const session = await this.manager.startSession(run.projectId, false, 'acceptEdits', undefined, {
        background: true,
        engine: 'claude',
        cwd: item.worktreePath,
        effort: 'max',
      })
      this.manager.markSection(session.id, 'flow')
      this.manager.renameSession(session.id, `PBI ${item.workItemId ?? item.localId}`.slice(0, 60))
      this.repos.flowItems.update(itemId, {
        status: 'implementing',
        sessionId: session.id,
        attempts: item.attempts + 1,
      })
      this.manager.watchFlow(session.id)
      this.manager.sendMessage(
        session.id,
        implementPrompt({ run, item, branch: item.branch, resumed: item.attempts > 0 }),
      )
    } catch (error) {
      this.repos.flowItems.update(itemId, {
        status: 'blocked',
        note: `A session could not be started for this item: ${errorText(error)}`,
      })
    }
  }

  private async raisePr(run: FlowRun, itemId: string): Promise<void> {
    const item = this.repos.flowItems.byId(itemId)
    if (!item?.worktreePath || !item.branch) return
    try {
      const session = await this.manager.startSession(run.projectId, false, 'acceptEdits', undefined, {
        background: true,
        engine: 'claude',
        cwd: item.worktreePath,
      })
      await this.requireAdo(session.id)
      this.manager.markSection(session.id, 'flow')
      this.manager.renameSession(session.id, `PR ${item.workItemId ?? item.localId}`.slice(0, 60))
      this.repos.flowItems.update(itemId, { status: 'raising_pr', sessionId: session.id })
      this.manager.watchFlow(session.id)
      this.manager.sendMessage(
        session.id,
        prPrompt({ run, item, branch: item.branch, baseBranch: run.baseBranch ?? 'main' }),
      )
    } catch (error) {
      this.repos.flowItems.update(itemId, {
        status: 'blocked',
        note: `The pull request step could not start: ${errorText(error)}`,
      })
      this.callbacks.onFlowChanged(run.projectId)
    }
  }

  private restartItem(item: FlowItem, why: string): void {
    if (item.attempts >= MAX_ITEM_ATTEMPTS) {
      this.repos.flowItems.update(item.id, {
        status: 'failed',
        sessionId: null,
        note: `${why} Gave up after ${item.attempts} attempts.`,
        finishedAt: nowIso(),
      })
      this.callbacks.onFlowChanged(item.projectId)
      void this.pump(item.runId)
      return
    }
    this.repos.flowItems.update(item.id, {
      status: 'queued',
      sessionId: null,
      note: `${why} Restarting, attempt ${item.attempts + 1} of ${MAX_ITEM_ATTEMPTS}.`,
    })
    this.callbacks.onFlowChanged(item.projectId)
    const wait = FLOW_BACKOFF_MS[Math.min(Math.max(item.attempts - 1, 0), FLOW_BACKOFF_MS.length - 1)]
    const timer = setTimeout(() => {
      this.backoffTimers.delete(item.id)
      void this.pump(item.runId)
    }, wait)
    timer.unref?.()
    this.backoffTimers.set(item.id, timer)
  }

  async cancel(runId: string): Promise<void> {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    if (run.finishedAt) return
    if (run.sessionId) await this.manager.interruptSession(run.sessionId).catch(() => {})
    this.repos.flowRuns.finish(runId, 'cancelled', 'You stopped this flow.')
    this.callbacks.onFlowChanged(run.projectId)
  }

  onFlowMarker(sessionId: string, marker: FlowMarker): void {
    if (marker.kind === 'item' || marker.kind === 'pr') {
      const item = this.repos.flowItems.bySessionId(sessionId)
      if (!item) return
      const run = this.repos.flowRuns.byId(item.runId)
      if (!run) return
      if (marker.kind === 'item') {
        if (marker.outcome === 'blocked') {
          this.repos.flowItems.update(item.id, {
            status: 'blocked',
            note: marker.why ?? marker.summary ?? 'The session reported it was blocked.',
          })
          this.callbacks.onFlowChanged(run.projectId)
          void this.pump(run.id)
          return
        }
        this.repos.flowItems.update(item.id, { note: marker.summary || null })
        void this.raisePr(run, item.id)
        return
      }
      this.repos.flowItems.update(item.id, {
        status: 'pr_open',
        prId: marker.prId,
        prUrl: marker.url,
        finishedAt: nowIso(),
      })
      this.callbacks.onFlowChanged(run.projectId)
      void this.pump(run.id)
      return
    }
    if (marker.kind === 'features') {
      const waiter = this.featuresWaiters.get(sessionId)
      if (!waiter) return
      this.featuresWaiters.delete(sessionId)
      clearTimeout(waiter.timer)
      waiter.resolve(marker.features)
      return
    }
    const run = this.repos.flowRuns.bySessionId(sessionId)
    if (!run) return
    if (marker.kind === 'scope' && run.status === 'scoping') {
      this.repos.flowItems.replaceForRun(run.id, run.projectId, marker.items)
      this.repos.flowRuns.update(run.id, {
        status: 'crosscheck',
        risks: marker.risks,
        outOfScope: marker.outOfScope,
        note: null,
      })
      this.callbacks.onFlowChanged(run.projectId)
      void this.crosscheck(run.id, marker.items)
      return
    }
    if (marker.kind === 'signoff' && run.status === 'crosscheck') {
      this.settleSignoff(run, marker.verdict, marker.concerns, marker.items)
      return
    }
    if (marker.kind === 'lessons' && run.status === 'learning') {
      const rejected = new Set(
        this.repos.flowLessons.rejectedRules(run.projectId).map((rule) => flowRuleId(rule)),
      )
      let suppressed = 0
      for (const lesson of marker.lessons) {
        const ruleId = flowRuleId(lesson.rule)
        // The prompt asks for rejected rules to be left out; this is what enforces it.
        if (rejected.has(ruleId)) {
          suppressed += 1
          continue
        }
        this.repos.flowLessons.propose({
          projectId: run.projectId,
          runId: run.id,
          ruleId,
          rule: lesson.rule,
          section: lesson.section,
          evidence: lesson.evidence,
        })
      }
      const parts = [marker.note]
      if (suppressed > 0) {
        parts.push(
          `${suppressed} rule${suppressed === 1 ? ' was' : 's were'} left out because you rejected ${suppressed === 1 ? 'it' : 'them'} before.`,
        )
      }
      if (marker.lessons.length === 0) parts.push('No reviewer comment became a rule.')
      this.repos.flowRuns.update(run.id, {
        status: 'done',
        note: parts.filter((part): part is string => Boolean(part)).join(' ') || null,
        finishedAt: nowIso(),
      })
      this.callbacks.onFlowChanged(run.projectId)
      return
    }
    if (marker.kind === 'published' && run.status === 'publishing') {
      for (const made of marker.created) {
        const item = this.repos.flowItems.byLocalId(run.id, made.localId)
        if (!item) continue
        this.repos.flowItems.update(item.id, {
          workItemId: made.workItemId,
          workItemUrl: made.url,
          status: 'published',
          note: null,
        })
      }
      for (const miss of marker.failed) {
        const item = this.repos.flowItems.byLocalId(run.id, miss.localId)
        if (!item) continue
        this.repos.flowItems.update(item.id, { status: 'failed', note: miss.why })
      }
      const remaining = this.repos.flowItems
        .listForRun(run.id)
        .filter((item) => item.status === 'proposed').length
      this.repos.flowRuns.update(run.id, {
        status: 'ready',
        note:
          marker.failed.length > 0
            ? `${marker.failed.length} item${marker.failed.length === 1 ? '' : 's'} could not be created.`
            : remaining > 0
              ? `${remaining} item${remaining === 1 ? '' : 's'} were not reported either way.`
              : null,
      })
      this.callbacks.onFlowChanged(run.projectId)
    }
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
    const item = this.repos.flowItems.bySessionId(sessionId)
    if (item) {
      if (item.status === 'implementing') {
        this.restartItem(item, 'The session ended before it reported on this item.')
        return
      }
      if (item.status === 'raising_pr') {
        this.repos.flowItems.update(item.id, {
          status: 'pr_interrupted',
          sessionId: null,
          note: 'The session ended while raising the pull request. A branch may already be pushed, and a pull request may already exist, so check Azure Repos before retrying.',
        })
        this.callbacks.onFlowChanged(item.projectId)
        void this.pump(item.runId)
      }
      return
    }

    const run = this.repos.flowRuns.bySessionId(sessionId)
    if (!run) return
    if (run.status === 'scoping') {
      this.repos.flowRuns.finish(run.id, 'failed', SCOPE_LOST)
      this.callbacks.onFlowChanged(run.projectId)
      return
    }
    if (run.status === 'publishing') {
      this.repos.flowRuns.update(run.id, { status: 'publish_interrupted', note: PUBLISH_LOST })
      this.callbacks.onFlowChanged(run.projectId)
    }
  }

  private requireRun(runId: string): FlowRun {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    return run
  }

  private async flowSession(projectId: string, preferred?: string | null): Promise<{ id: string }> {
    if (preferred && this.manager.workdirFor(preferred)) return { id: preferred }
    return this.manager.startSession(projectId, false, 'plan', undefined, {
      background: true,
      engine: 'claude',
    })
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
