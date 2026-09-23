import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  FlowKind,
  FlowRepo,
  FlowRun,
  FlowStage,
  FlowStageAction,
  FlowStageRecord,
  FlowStageReport,
  Project,
  SddProcess,
  SessionEndReason,
  SpecSummary,
  VerifyReport,
} from '@shared/domain'
import {
  FLOW_STAGE_LABELS,
  emptyFlowStageReport,
  flowStageActions,
  flowStagesOf,
  verifyVerdict,
} from '@shared/domain'
import type { FlowArtefactKind, FlowCompanionRequest, FlowStartSource, IpcError } from '@shared/ipc-types'
import {
  SDD_COMMANDS,
  bugResultOf,
  decisionOf,
  handoffOf,
  isSddSlug,
  sddDirOf,
  sddDocPath,
  sddProcessOf,
  sddSlug,
} from '@shared/sdd'
import { nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import {
  bugAssessPrompt,
  bugFixPrompt,
  bugRefixPrompt,
  bugTestPrompt,
  buildHandshake,
  buildSteps,
  checklistSteps,
  cleanHandshake,
  cleanSteps,
  clarifyPrompt,
  constitutionPrompt,
  convergePrompt,
  fixFindingsPrompt,
  ideaPrompt,
  planHandshake,
  planSteps,
  reviewHandshake,
  reviewSteps,
  revisePrompt,
  sddHandshake,
  shipForbidden,
  shipPrompt,
  specHandshake,
  specifyPrompt,
  testWritePrompt,
  adoSignInPrompt,
  featuresPrompt,
  withRepos,
  type ShipTest,
} from './flow-prompts'
import { allowedPullRequestUrl, type FlowMarker, type FlowStageMarker } from './flow-markers'
import { artefactRelPath, defaultArtefactKind, resolveArtefactPath } from './artefacts'
import { STACK_ORDER, detectFlowStacks } from './stacks'
import {
  isExtensionInstalled,
  isSpecKitInstalled,
  pinFeature,
  readConstitutionState,
  readSpecKitState,
} from '@main/specs/spec-kit'
import { defaultSelection, stackById, type TestSuite } from '@shared/test-catalog'
import {
  detectProjectSuites,
  planSuites,
  verifyPrompt as buildVerifyPrompt,
  type PlannedSuite,
} from '@main/verify/verify-dispatch'
import { createWorktree, currentBranch, originHost, removeWorktree, resolvesToCommit, worktreeRoot } from './worktrees'
import type { FlowFeatureList } from '@shared/domain'

export const ADO_SERVER = 'ado'

const ADO_HOLD_MS = 10 * 60_000

const ADO_LISTED_MS = 10_000

export const FEATURES_TIMEOUT_MS = 10 * 60_000

export const LISTING_ENV = { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '300000' }

const LISTING_CANCELLED: IpcError = { code: 'NOT_LIVE', message: 'The Feature list was cancelled.' }

const LISTING_TIMED_OUT: IpcError = {
  code: 'NOT_LIVE',
  message: 'The session did not answer with a Feature list in time.',
}

function adoProblem(
  state: { status: string; error: string | null } | null,
  waitMs: number,
  again: 'Reconnect' | 'Retry' = 'Reconnect',
): IpcError {
  if (!state) return { code: 'NOT_LIVE', message: 'The session ended before the Azure DevOps MCP server connected.' }
  const why: Record<string, string> = {
    pending: `it is still starting after ${Math.round(waitMs / 1000)} seconds, and npx may still be fetching it. ${again} to wait for it again`,
    'needs-auth': `it needs you to sign in. Sign in to it in Claude Code with /mcp, then ${again}`,
    failed: `it failed to start: ${state.error?.trim() || 'it gave no reason'}. Check the ado server in your Claude Code configuration, then ${again}`,
    disabled: `it is disabled in your Claude Code configuration. Enable it, then ${again}`,
    missing: `no MCP server named ado is configured for it. Add the ado server to your Claude Code configuration, then ${again}`,
  }
  return {
    code: state.status === 'needs-auth' ? 'MCP_NEEDS_AUTH' : 'MCP_NOT_CONNECTED',
    message: `The Azure DevOps MCP server is not connected for this session: ${why[state.status] ?? `it reports ${state.status}. ${again} to try again`}.`,
  }
}

const ADO_DOWN: ReadonlySet<unknown> = new Set(['MCP_NOT_CONNECTED', 'MCP_NEEDS_AUTH'])

const MAX_FIX_ROUNDS = 2

export const MAX_CONVERGE_ROUNDS = 3

interface FlowCallbacks {
  onFlowChanged: (projectId: string) => void
}

type FeaturesWaiter = {
  resolve: (list: FlowFeatureList) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  thenList: string | null
}

type Listing = { sessionId: string | null; signingIn?: boolean }

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
  feature: 'A feature starts from the Flow intake.',
}

function kindOf(source: FlowStartSource): FlowKind {
  return source.kind === 'bug' ? 'bug' : source.kind === 'idea' ? 'idea' : 'feature'
}

function openChecklistItems(worktreePath: string, specDir: string): number | null {
  const dir = resolveArtefactPath(worktreePath, join(specDir, 'checklists'))
  if (!dir) return null
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.md'))
    if (files.length === 0) return null
    return files.reduce((sum, name) => sum + (readFileSync(join(dir, name), 'utf8').match(/^\s*-\s*\[ \]/gm)?.length ?? 0), 0)
  } catch {
    return null
  }
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

async function copyNewer(fromRoot: string, toRoot: string, rel: string): Promise<void> {
  const from = join(fromRoot, rel)
  if (!existsSync(from)) return
  await cp(from, join(toRoot, rel), {
    recursive: true,
    filter: (src, dest) =>
      statSync(src).isDirectory() || !existsSync(dest) || statSync(src).mtimeMs > statSync(dest).mtimeMs,
  }).catch(() => {})
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
  private rounds = new Map<string, number>()
  private looped = new Set<string>()
  private adoSessions = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>()
  private listings = new Map<string, Listing>()

  constructor(
    private repos: Repositories,
    private manager: SessionManager,
    private callbacks: FlowCallbacks,
    private git: FlowGit = defaultGit,
    private ado: { waitMs: number; pollMs: number } = { waitMs: 90_000, pollMs: 1_000 },
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

  listingSession(projectId: string): string | null {
    return this.listings.get(projectId)?.sessionId ?? null
  }

  signingIn(projectId: string): boolean {
    return this.listings.get(projectId)?.signingIn === true
  }

  async features(projectId: string, query: string, timeoutMs = FEATURES_TIMEOUT_MS): Promise<FlowFeatureList> {
    const project = this.requireProject(projectId)
    const listing = this.beginListing(projectId, null)
    let session: { id: string }
    try {
      session = await this.manager.startSession(project.id, false, project.defaultSessionMode, {
        background: true,
        section: 'flow',
        env: LISTING_ENV,
      })
    } catch (error) {
      this.dropListing(projectId, listing)
      throw error
    }
    return this.listFeatures(projectId, listing, session.id, query, timeoutMs)
  }

  async reconnectAdo(projectId: string, query: string, timeoutMs = FEATURES_TIMEOUT_MS): Promise<FlowFeatureList> {
    this.requireProject(projectId)
    const held = this.adoSessions.get(projectId)
    if (!held || !this.manager.liveSessionIds().includes(held.sessionId)) return this.features(projectId, query, timeoutMs)
    clearTimeout(held.timer)
    this.adoSessions.delete(projectId)
    const listing = this.beginListing(projectId, held.sessionId)
    await this.manager.reconnectMcpServer(held.sessionId, ADO_SERVER).catch(() => {})
    return this.listFeatures(projectId, listing, held.sessionId, query, timeoutMs, true)
  }

  cancelFeatures(projectId: string): void {
    this.dropAdoSession(projectId)
    const listing = this.listings.get(projectId)
    if (!listing) return
    this.dropListing(projectId, listing)
    if (listing.sessionId) this.settleListing(listing.sessionId, LISTING_CANCELLED, 'stop')
  }

  private beginListing(projectId: string, sessionId: string | null): Listing {
    this.cancelFeatures(projectId)
    const listing: Listing = { sessionId }
    this.listings.set(projectId, listing)
    this.callbacks.onFlowChanged(projectId)
    return listing
  }

  private dropListing(projectId: string, listing: Listing): void {
    if (this.listings.get(projectId) !== listing) return
    this.listings.delete(projectId)
    this.callbacks.onFlowChanged(projectId)
  }

  private async listFeatures(
    projectId: string,
    listing: Listing,
    sessionId: string,
    query: string,
    timeoutMs: number,
    signIn = false,
  ): Promise<FlowFeatureList> {
    if (this.listings.get(projectId) !== listing) {
      if (listing.sessionId !== sessionId) this.settleListing(sessionId, LISTING_CANCELLED, 'stop')
      throw LISTING_CANCELLED
    }
    if (listing.sessionId !== sessionId) {
      listing.sessionId = sessionId
      this.callbacks.onFlowChanged(projectId)
    }
    try {
      await this.requireAdo(sessionId)
    } catch (error) {
      if (this.listings.get(projectId) !== listing) throw LISTING_CANCELLED
      this.dropListing(projectId, listing)
      if (ADO_DOWN.has((error as Partial<IpcError>).code)) this.holdAdoSession(projectId, sessionId)
      else this.manager.endFlowSession(sessionId)
      throw error
    }
    if (this.listings.get(projectId) !== listing) throw LISTING_CANCELLED
    return new Promise<FlowFeatureList>((resolve, reject) => {
      const timer = setTimeout(() => this.settleListing(sessionId, LISTING_TIMED_OUT, 'stop'), timeoutMs)
      timer.unref?.()
      this.featuresWaiters.set(sessionId, { resolve, reject, timer, thenList: signIn ? query : null })
      if (signIn) {
        listing.signingIn = true
        this.callbacks.onFlowChanged(projectId)
      }
      this.askListing(sessionId, signIn ? adoSignInPrompt() : featuresPrompt(query))
    })
  }

  private askListing(sessionId: string, text: string): void {
    try {
      this.manager.watchFlow(sessionId)
      this.manager.sendMessage(sessionId, text)
    } catch (error) {
      this.settleListing(
        sessionId,
        { code: 'NOT_LIVE', message: `The session could not take the Feature list request: ${errorText(error)}` },
        'end',
      )
    }
  }

  private listAfterSignIn(sessionId: string, waiter: FeaturesWaiter): void {
    const query = waiter.thenList ?? ''
    waiter.thenList = null
    for (const [projectId, listed] of this.listings) {
      if (listed.sessionId !== sessionId || !listed.signingIn) continue
      listed.signingIn = false
      this.callbacks.onFlowChanged(projectId)
    }
    this.askListing(sessionId, featuresPrompt(query))
  }

  private failSignIn(sessionId: string, error: string | null): void {
    const projectId = [...this.listings].find(([, listed]) => listed.sessionId === sessionId)?.[0]
    this.settleListing(
      sessionId,
      {
        code: 'MCP_NOT_CONNECTED',
        message: `Azure DevOps did not sign in: ${error ?? 'the call failed and gave no reason'}. Reconnect to try again.`,
      },
      'gone',
    )
    if (projectId) this.holdAdoSession(projectId, sessionId)
  }

  private isListing(sessionId: string): boolean {
    return this.featuresWaiters.has(sessionId) || [...this.listings.values()].some((listing) => listing.sessionId === sessionId)
  }

  private settleListing(sessionId: string, outcome: FlowFeatureList | IpcError, close: 'end' | 'stop' | 'gone'): void {
    const waiter = this.featuresWaiters.get(sessionId)
    if (waiter) {
      this.featuresWaiters.delete(sessionId)
      clearTimeout(waiter.timer)
    }
    for (const [projectId, listed] of [...this.listings]) {
      if (listed.sessionId !== sessionId) continue
      this.listings.delete(projectId)
      this.callbacks.onFlowChanged(projectId)
    }
    if (close === 'end') this.manager.endFlowSession(sessionId)
    if (close === 'stop') {
      void this.manager.stopSession(sessionId, 'The Feature list was stopped before it finished.').catch(() => {})
    }
    if (!waiter) return
    if ('features' in outcome) waiter.resolve(outcome)
    else waiter.reject(outcome)
  }

  private holdAdoSession(projectId: string, sessionId: string): void {
    this.dropAdoSession(projectId)
    const timer = setTimeout(() => this.dropAdoSession(projectId), ADO_HOLD_MS)
    timer.unref?.()
    this.adoSessions.set(projectId, { sessionId, timer })
  }

  private dropAdoSession(projectId: string): void {
    const held = this.adoSessions.get(projectId)
    if (!held) return
    clearTimeout(held.timer)
    this.adoSessions.delete(projectId)
    this.manager.endFlowSession(held.sessionId)
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
    checklist?: boolean
    baseBranch?: string
    companions?: readonly FlowCompanionRequest[]
  }): Promise<FlowRun> {
    const project = this.requireProject(input.projectId)
    const kind = kindOf(input.source)
    const stacks = await detectFlowStacks(project.path)
    if (stacks.length === 0 && kind !== 'idea') {
      throw { code: 'UNSUPPORTED', message: 'Flow supports .NET and Angular projects.' } satisfies IpcError
    }
    if (kind === 'idea' && (input.companions?.length ?? 0) > 0) {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'An idea run changes no code, so it takes no other repositories.',
      } satisfies IpcError
    }
    const process = sddProcessOf(kind)
    if (process) await this.requireExtension(project.path, process)
    const slug = process ? this.slugFor(project, process, input.source) : null
    const companions = await this.companionsFor(project, input.companions ?? [])
    if (input.source.kind === 'spec') await this.requireSpec(project.path, input.source.specId)
    const title = this.deriveTitle(input.source)

    if (kind === 'idea') return this.startIdea(project, input, title, slug ?? sddSlug(title), stacks)

    const base = await this.baseFor(project.path, input.baseBranch, project.name)
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
    if (process && slug) await this.carrySdd(project.path, worktreePath, process, slug)

    let specDir: string | null = null
    let startStage: FlowStage = flowStagesOf(kind)[0]
    if (input.source.kind === 'spec') {
      specDir = `specs/${input.source.specId}`
      await copyMissing(project.path, worktreePath, specDir)
      startStage = existsSync(join(worktreePath, specDir, 'tasks.md')) ? 'build' : 'plan'
    }
    if (slug) startStage = this.firstUndone(kind, worktreePath, slug) === 'assess' ? 'assess' : 'fix'

    const run = this.repos.flowRuns.start({
      projectId: project.id,
      kind,
      slug,
      checklist: kind === 'feature' && input.checklist === true,
      title,
      source: input.source.kind === 'ado' || input.source.kind === 'spec' ? input.source.kind : 'text',
      sourceRef:
        input.source.kind === 'ado'
          ? input.source.featureId
          : input.source.kind === 'spec'
            ? input.source.specId
            : null,
      sourceUrl: input.source.kind === 'ado' ? input.source.url : null,
      description: this.describe(input.source),
      stacks: STACK_ORDER.filter((id) => [stacks, ...made.map((repo) => repo.stacks)].some((list) => list.includes(id))),
      stage: startStage,
      autopilot: input.autopilot,
      autoShip: input.autoShip,
      baseBranch: base,
    })
    this.skipBefore(run, startStage)
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

  private async startIdea(
    project: Project,
    input: { source: FlowStartSource; autopilot: boolean },
    title: string,
    slug: string,
    stacks: readonly string[],
  ): Promise<FlowRun> {
    const open = this.firstUndone('idea', project.path, slug)
    const startStage = open ?? 'decide'
    const run = this.repos.flowRuns.start({
      projectId: project.id,
      kind: 'idea',
      slug,
      title,
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: this.describe(input.source),
      stacks: STACK_ORDER.filter((id) => stacks.includes(id)),
      stage: startStage,
      autopilot: input.autopilot,
      autoShip: false,
      baseBranch: null,
    })
    this.skipBefore(run, startStage)
    if (!open) {
      const doc = sddDocPath('idea', slug, 'decide') ?? ''
      this.repos.flowStages.update(run.id, 'decide', {
        status: 'approved',
        summary: `Already decided in ${doc}.`,
        report: { ...emptyFlowStageReport(), decision: decisionOf(this.readDoc(run, doc)) },
        finishedAt: nowIso(),
      })
      this.repos.flowRuns.finish(run.id, 'done', null)
      this.callbacks.onFlowChanged(project.id)
      return this.requireRun(run.id)
    }
    this.callbacks.onFlowChanged(project.id)
    return this.exclusive(run.id, () => this.beginStage(run.id, startStage))
  }

  private skipBefore(run: FlowRun, startStage: FlowStage): void {
    this.repos.flowStages.ensureAll(run.id)
    const stages = flowStagesOf(run.kind)
    for (const stage of stages.slice(0, stages.indexOf(startStage))) {
      const doc = sddDocPath(run.kind, run.slug, stage)
      this.repos.flowStages.update(run.id, stage, {
        status: 'skipped',
        summary: doc ? `Already written in ${doc}.` : 'Started from an existing spec.',
        finishedAt: nowIso(),
      })
    }
  }

  private firstUndone(kind: FlowKind, root: string, slug: string): FlowStage | null {
    const docs = flowStagesOf(kind).filter((stage) => sddDocPath(kind, slug, stage) !== null)
    return docs.find((stage) => !existsSync(join(root, sddDocPath(kind, slug, stage) ?? ''))) ?? null
  }

  private async carrySdd(from: string, to: string, process: SddProcess, slug: string): Promise<void> {
    await copyMissing(from, to, join('.specify', 'extensions', process))
    for (const command of SDD_COMMANDS[process]) await copyMissing(from, to, join('.claude', 'skills', command.command))
    await copyMissing(from, to, sddDirOf(process, slug))
  }

  private describe(source: FlowStartSource): string {
    if (source.kind === 'text') return source.description
    if (source.kind === 'bug') return source.symptom.trim()
    if (source.kind === 'idea') return source.idea.trim()
    return ''
  }

  private slugFor(project: Project, process: SddProcess, source: FlowStartSource): string {
    const explicit = source.kind === 'bug' || source.kind === 'idea' ? source.slug?.trim() : undefined
    if (explicit) {
      if (!isSddSlug(explicit)) {
        throw {
          code: 'INVALID_PATH',
          message: `"${explicit}" is not a slug. Use lowercase letters, digits and hyphens.`,
        } satisfies IpcError
      }
      return explicit
    }
    const taken = new Set(this.repos.flowRuns.listForProject(project.id).map((run) => run.slug))
    const base = sddSlug(this.deriveTitle(source))
    let slug = base
    for (let n = 2; taken.has(slug) || existsSync(join(project.path, sddDirOf(process, slug))); n += 1) {
      slug = `${base}-${n}`
    }
    return slug
  }

  private async requireExtension(projectPath: string, process: SddProcess): Promise<void> {
    if ((await isSpecKitInstalled(projectPath)) && (await isExtensionInstalled(projectPath, process))) return
    throw {
      code: 'UNSUPPORTED',
      message: `The ${process} extension is not installed in this project. Install it from the SDD tab first.`,
    } satisfies IpcError
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
      await this.advance(runId, run.stage)
    })
  }

  fix(runId: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      const stageRow = this.requireAction(run, 'fix')
      if (run.stage === 'test') {
        await this.refix(run, stageRow)
        return
      }
      await this.restartStage(run, stageRow, fixFindingsPrompt(stageRow.report, run), stageRow.feedback)
    })
  }

  private async refix(run: FlowRun, testRow: FlowStageRecord): Promise<void> {
    const fixRow = this.repos.flowStages.get(run.id, 'fix')
    if (!fixRow) return
    this.repos.flowStages.update(run.id, 'test', { status: 'pending', finishedAt: null })
    this.repos.flowRuns.update(run.id, { stage: 'fix', status: 'waiting' })
    const back = { ...run, stage: 'fix' as const }
    await this.restartStage(back, fixRow, bugRefixPrompt(back, run.stacks, run.repos, testRow.summary), null)
  }

  revise(runId: string, feedback: string): Promise<FlowRun> {
    return this.exclusive(runId, async () => {
      const run = this.requireRun(runId)
      const stageRow = this.requireAction(run, 'revise')
      await this.restartStage(run, stageRow, revisePrompt(run, run.stage, feedback), feedback)
    })
  }

  async feature(runId: string): Promise<{ title: string; description: string }> {
    const run = this.requireRun(runId)
    this.requireAction(run, 'feature')
    const decision = this.readDoc(run, sddDocPath(run.kind, run.slug, 'decide') ?? '')
    return { title: run.title, description: handoffOf(decision) ?? run.description }
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
    if (run.kind === 'bug' && run.slug) {
      await copyNewer(run.worktreePath, this.requireProject(run.projectId).path, sddDirOf('bug', run.slug))
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
    const resolvedKind = kind ?? defaultArtefactKind(stage, run.kind)
    if (resolvedKind === 'report') {
      const stageRow = this.repos.flowStages.get(runId, stage)
      if (!stageRow?.report) return null
      return { path: null, content: JSON.stringify(stageRow.report, null, 2) }
    }
    if (resolvedKind === 'doc') {
      const rel = sddDocPath(run.kind, run.slug, stage)
      const content = rel ? this.readDoc(run, rel) : null
      return rel && content !== null ? { path: rel, content } : null
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
      if (this.featuresWaiters.has(sessionId)) {
        this.settleListing(sessionId, { features: marker.features, note: marker.note }, 'end')
      }
      return
    }
    if (marker.kind === 'ado') {
      const waiter = this.featuresWaiters.get(sessionId)
      if (!waiter || waiter.thenList === null) return
      if (marker.ok) this.listAfterSignIn(sessionId, waiter)
      else this.failSignIn(sessionId, marker.error)
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

  private rootOf(run: FlowRun): string | null {
    return run.worktreePath ?? (run.kind !== 'feature' ? (this.repos.projects.byId(run.projectId)?.path ?? null) : null)
  }

  private readDoc(run: FlowRun, rel: string): string | null {
    const root = this.rootOf(run)
    const abs = root ? resolveArtefactPath(root, rel) : null
    if (!abs) return null
    try {
      return readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  }

  onVerifyReport(sessionId: string, report: VerifyReport): void {
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx || ctx.stage !== 'test' || this.repos.flowRuns.byId(ctx.runId)?.kind === 'bug') return
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
    if (this.isListing(sessionId)) {
      this.settleListing(sessionId, { code: 'NOT_LIVE', message: 'The session ended before it listed any Features.' }, 'gone')
    }
    const ctx = this.sessionStage.get(sessionId)
    if (!ctx) return
    this.sessionStage.delete(sessionId)
    this.pending.delete(sessionId)
    this.current.delete(sessionId)
    this.rounds.delete(sessionId)
    this.looped.delete(sessionId)
    const stageRow = this.repos.flowStages.get(ctx.runId, ctx.stage)
    if (!stageRow || stageRow.status !== 'running') return
    this.failStage(ctx.runId, ctx.stage, SESSION_ENDED, { retryOnce: true })
  }

  onTurnEnded(sessionId: string, error: string | null = null): void {
    const waiter = this.featuresWaiters.get(sessionId)
    if (waiter && waiter.thenList !== null && !error) {
      this.listAfterSignIn(sessionId, waiter)
      return
    }
    if (waiter) {
      this.settleListing(
        sessionId,
        {
          code: 'NOT_LIVE',
          message: error
            ? `The session could not list the Features: ${error}`
            : 'The session answered without a Feature list. Open its output to see what it said.',
        },
        'end',
      )
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
    const verifying = ctx.stage === 'test' && this.repos.flowRuns.byId(ctx.runId)?.kind !== 'bug'
    this.failStage(ctx.runId, ctx.stage, verifying ? NO_VERIFY_REPORT : NO_REPORT, { retryOnce: true })
  }

  private sendStep(sessionId: string, text: string): void {
    this.looped.delete(sessionId)
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
    if (!(await this.git.resolves(repoRoot, current))) {
      throw {
        code: 'INVALID_PATH',
        message: `${name ?? 'This repository'} has no commits yet, so Flow has nothing to branch its worktree from. Make a first commit on ${current} and start again.`,
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
    if (source.kind === 'spec') return source.specId
    return source.title.trim()
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
    this.rounds.delete(sessionId)
    this.looped.delete(sessionId)
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
    if (!existsSync(join(run.worktreePath, '.specify'))) return
    await pinFeature(run.worktreePath, run.specDir).catch(() => {})
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

  private async shipTest(run: FlowRun): Promise<ShipTest> {
    const test = this.repos.flowStages.get(run.id, 'test')?.report ?? null
    if (run.kind === 'bug') {
      return { verify: null, postman: null, bug: { doc: sddDocPath('bug', run.slug, 'test') ?? '', result: test?.bugResult ?? null } }
    }
    const postman = (await this.artefact(run.id, 'test', 'postman'))?.path?.replace(/\\/g, '/') ?? null
    return { verify: test?.verify ?? null, postman }
  }

  private buildRound(run: FlowRun): string[] {
    return [...buildSteps(run.stacks, run.specDir, run.repos), convergePrompt(run.specDir)]
  }

  private async planFor(run: FlowRun, stage: FlowStage, sessionId: string): Promise<StagePlan> {
    const base = run.baseBranch ?? 'main'
    const repos = run.repos
    switch (stage) {
      case 'spec': {
        const root = this.rootOf(run) ?? this.requireProject(run.projectId).path
        const constitution = (await readConstitutionState(root)) === 'written' ? [] : [constitutionPrompt(run.autopilot)]
        return { steps: [...constitution, specifyPrompt(run), clarifyPrompt(run.autopilot)], handshake: specHandshake(run.source === 'ado') }
      }
      case 'plan':
        return {
          steps: [...planSteps(run.stacks, run.specDir, repos), ...(run.checklist ? checklistSteps(run.specDir, run.autopilot) : [])],
          handshake: planHandshake(),
        }
      case 'build':
        return { steps: this.buildRound(run), handshake: buildHandshake() }
      case 'clean':
        return { steps: cleanSteps(run.stacks, base, repos), handshake: cleanHandshake() }
      case 'test':
        if (run.kind === 'bug') return { steps: [bugTestPrompt(run)], handshake: sddHandshake(stage) }
        return {
          steps: [testWritePrompt(run, run.stacks, repos), await this.verifyStepPrompt(run, sessionId)],
          handshake: null,
        }
      case 'review':
        return {
          steps: reviewSteps(run.stacks, base, repos),
          handshake: reviewHandshake(
            base,
            run.specDir,
            run.stacks,
            repos,
            run.kind === 'bug' ? sddDocPath('bug', run.slug, 'assess') : null,
          ),
        }
      case 'ship':
        return { steps: [], handshake: shipPrompt(run, await this.shipTest(run), repos) }
      case 'assess':
        return { steps: [bugAssessPrompt(run)], handshake: sddHandshake(stage) }
      case 'fix':
        return { steps: [bugFixPrompt(run, run.stacks, repos)], handshake: sddHandshake(stage) }
      case 'intake':
      case 'research':
      case 'define':
      case 'shape':
      case 'decide':
        return { steps: [ideaPrompt(stage, run)], handshake: sddHandshake(stage) }
    }
  }

  private async tailFor(run: FlowRun, stage: FlowStage, sessionId: string): Promise<string[]> {
    if (stage === 'test' && run.kind !== 'bug') return [await this.verifyStepPrompt(run, sessionId)]
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
        await this.requireAdo(session.id, 'Retry')
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

  private convergeAgain(run: FlowRun, marker: FlowStageMarker): boolean {
    const sessionId = this.repos.flowStages.get(run.id, 'build')?.sessionId
    if (!sessionId || run.kind !== 'feature') return false
    if (this.looped.has(sessionId)) return true
    const round = this.rounds.get(sessionId) ?? 1
    if (marker.converged !== false || round >= MAX_CONVERGE_ROUNDS) return false
    this.rounds.set(sessionId, round + 1)
    this.looped.add(sessionId)
    const [first, ...rest] = this.buildRound(run)
    this.pending.set(sessionId, [withRepos(first, run.repos), ...rest, buildHandshake()])
    this.repos.flowStages.update(run.id, 'build', {
      summary: `Converge round ${round} appended unbuilt work, so round ${round + 1} of ${MAX_CONVERGE_ROUNDS} is running.`,
    })
    this.callbacks.onFlowChanged(run.projectId)
    return true
  }

  private stageFindings(
    run: FlowRun,
    stage: FlowStage,
    marker: FlowStageMarker,
  ): { fail: { why: string; report: FlowStageReport | null } | null; extra: Partial<FlowStageReport>; notes: string[] } {
    const extra: Partial<FlowStageReport> = {}
    const notes: string[] = []
    const doc = sddDocPath(run.kind, run.slug, stage)
    const text = doc ? this.readDoc(run, doc) : null
    const verifying = run.kind === 'bug' && stage === 'test'
    if (doc && text === null) {
      const why = verifying
        ? `The bug test wrote no ${doc}, and a fix nobody verified is not a successful fix.`
        : `The ${FLOW_STAGE_LABELS[stage]} stage finished without writing ${doc}.`
      return { fail: { why, report: null }, extra, notes }
    }
    if (verifying) {
      const result = bugResultOf(text)
      if (result !== 'verified') {
        const why = result
          ? `The bug test reported ${result}, not verified, so the fix is not done.`
          : `${doc} records no verified, partial or failed result, and a fix nobody verified is not a successful fix.`
        return { fail: { why, report: { ...emptyFlowStageReport(), bugResult: result } }, extra, notes }
      }
      extra.bugResult = result
    }
    if (stage === 'decide') extra.decision = decisionOf(text) ?? marker.decision
    if (stage === 'build' && run.kind === 'feature') {
      const sessionId = this.repos.flowStages.get(run.id, 'build')?.sessionId ?? ''
      extra.rounds = this.rounds.get(sessionId) ?? 1
      extra.converged = marker.converged === true
      if (marker.converged === null) notes.push('The build did not say whether /speckit-converge reported Converged.')
      else if (!marker.converged) {
        notes.push(`Converge still found unbuilt work after ${extra.rounds} round${extra.rounds === 1 ? '' : 's'}.`)
      }
    }
    if (stage === 'plan' && run.checklist && run.specDir && run.worktreePath) {
      const open = openChecklistItems(run.worktreePath, run.specDir)
      extra.checklistOpen = open
      if (open === null) notes.push(`No checklist was written in ${run.specDir}/checklists/, so the checklist gate did not run.`)
      else if (open) notes.push(`The checklist has ${open} open item${open === 1 ? '' : 's'}.`)
    }
    return { fail: null, extra, notes }
  }

  private completeStage(runId: string, stage: FlowStage, marker: FlowStageMarker): void {
    const run = this.repos.flowRuns.byId(runId)
    if (!run) return
    if (stage === 'build' && this.convergeAgain(run, marker)) return
    const found = this.stageFindings(run, stage, marker)
    if (found.fail) {
      this.failStage(runId, stage, found.fail.why, { retryOnce: false }, found.fail.report)
      return
    }
    const patch: Parameters<Repositories['flowRuns']['update']>[1] = {}
    if (stage === 'spec') patch.specDir = this.resolveSpecDir(run, marker.specDir)
    if (stage === 'spec' && run.source === 'ado' && marker.title) patch.title = marker.title
    let prUrl = marker.prUrl
    let prId = marker.prId
    let summary = [marker.summary, ...found.notes].filter(Boolean).join(' ') || null
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
          ...found.extra,
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
    if (stage === 'build' && report?.converged === false) return
    if (stage === 'plan' && run.checklist && report?.checklistOpen !== 0) return
    if (stage === 'review' && report?.verdict !== 'ready') {
      if (report?.verdict === 'needs_fixes' && stageRow.attempts <= MAX_FIX_ROUNDS) void this.fix(runId).catch(() => {})
      return
    }
    void this.approve(runId).catch(() => {})
  }

  private async advance(runId: string, from: FlowStage): Promise<void> {
    if (this.movedOn(runId, from)) return
    const run = this.requireRun(runId)
    const stages = flowStagesOf(run.kind)
    const next = stages[stages.indexOf(from) + 1]
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

  private async requireAdo(sessionId: string, again: 'Reconnect' | 'Retry' = 'Reconnect'): Promise<void> {
    const started = Date.now()
    const waiting = (state: { status: string } | null): boolean => {
      const elapsed = Date.now() - started
      if (!state || elapsed >= this.ado.waitMs) return false
      return state.status === 'pending' || (state.status === 'missing' && elapsed < ADO_LISTED_MS)
    }
    let state = await this.manager.mcpStatus(sessionId, ADO_SERVER)
    while (waiting(state)) {
      await delay(this.ado.pollMs)
      state = await this.manager.mcpStatus(sessionId, ADO_SERVER)
    }
    if (state?.status === 'connected') return
    throw adoProblem(state, this.ado.waitMs, again)
  }
}
