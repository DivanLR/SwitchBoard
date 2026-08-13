// Session registry (one hosted session per project, clarified invariant),
// event persistence with per-session seq, and the fan-out hook the IPC layer
// subscribes to (T012). Also owns git branch observation (FR-003).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const GIT_EXEC_OPTS = { timeout: 8000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as const
import type {
  AvailableModel,
  DiffFileEntry,
  DiffFileStatus,
  DiffListResult,
  EventKind,
  EventPayloadMap,
  FileDiffContent,
  ModelMode,
  ProjectCommand,
  QueuedTask,
  Session,
  SessionEvent,
  SessionMode,
  SessionStatus,
  TranscriptSummary,
  VerifyReport,
} from '@shared/domain'
import { SWALLOWABLE_KINDS, verifyVerdict } from '@shared/domain'
import type { IpcError, SessionStatusPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import { readComboDoc, readSchemaDoc } from '@main/mcp/schema-doc'
import { HostedSession, type PermissionGate } from './session'
import { probeAvailableModels } from './model-catalog'
import { foldModelTotals, type EventSink } from './message-mapper'
import {
  adhdSystemPromptAppend,
  heavySubagentSystemPromptAppend,
  heavySubagentModelMode,
  modesSystemPromptAppend,
  sandboxSystemPromptAppend,
  terseSystemPromptAppend,
} from './session-shaping'
import {
  TRANSCRIPT_EVENT_CAP,
  listTranscripts,
  transcriptContextAppend,
  transcriptFor,
  writeTranscript,
} from './transcript'
import { parseEvalMarker } from '@main/evals/eval-dispatch'
import { parseVerifyReport, verifyMarkerBroken } from '@main/evals/verify-dispatch'
import { reconcile } from '@main/evals/artefacts'
import { scanArtefacts } from '@main/evals/artefact-scan'
import { parseApiRequests } from '@main/evals/api-dispatch'
import type { ApiRequestPlan } from '@shared/api-endpoints'
import { mainLoopModel } from './model-routing'
import { resolveClaudeExecutable } from './claude-executable'
import {
  ensureSandboxImage,
  gitNotice,
  gitRoot,
  hasNodeModulesVolume,
  refMounts,
  sweepOrphanedContainers,
} from './docker-sandbox'

/** Classifier hook installed by the swallow rule engine (FR-015a); null until then. */
type NoiseClassifier = (event: SessionEvent) => string | null

interface SessionManagerCallbacks {
  onEvent: (event: SessionEvent) => void
  onSessionStatus: (push: SessionStatusPush) => void
  onCountersChanged: () => void
  /** Wired to the permission broker so pending items expire on session death. */
  onSessionExit: (sessionId: string) => void
  /** Fired when a project's planned task queue changes (add/remove/auto-run). */
  onQueueChanged: (projectId: string) => void
  /** Fired when a session reports an acceptance line's check outcome or judge
   *  verdict, so the Tests tab reflects the gate without a manual refresh. */
  onEvalsChanged: (projectId: string) => void
  /** Fired when a verification run's report lands (or the run closes without
   *  one), so the Tests tab's gates and panels update as it finishes. */
  onVerifyChanged: (projectId: string) => void
  /**
   * Fired when a session reports the request data for an API eval set. The app
   * then makes the calls itself — this callback carries data, never a result.
   */
  onApiRequests: (projectId: string, runId: string, requests: ApiRequestPlan[]) => void
  /** Fired when an API run's row changes without the runner writing it — today
   *  only the stale sweep, which finishes a run the app itself never closed. */
  onApiChanged: (projectId: string) => void
  /** Fired when a session reports its available slash commands / skills (init message). */
  onProjectCommands: (projectId: string, commands: ProjectCommand[]) => void
  gate: PermissionGate
}

interface LiveEventEntry {
  event: SessionEvent
  persisted: boolean
}

export interface HostedEntry {
  session: HostedSession
  row: Session
  projectPath: string
  seq: number
  /** Events that may still be updated in place (partials, tool pairs, markers, questions). */
  live: Map<string, LiveEventEntry>
  /** Whether this session holds a Docker container, so the admission ceiling in
   *  startSession can count them without reaching into HostedSession's own state. */
  containerised: boolean
  /** Started by a section rather than by the developer, so nobody is sitting in
   *  it and it can close itself when its work is done (see endIfIdleBackground). */
  background: boolean
}

/**
 * How many sessions may hold a Docker container at once.
 *
 * Two, because every container shares ONE WSL virtual machine of fixed size and
 * each is capped independently: at the 6g default that is 12 GiB of claim
 * against a VM that is typically 16 GiB or more, which fits, and a third would
 * not reliably. The failure this prevents is not a slow machine but a wrong
 * accusation — the VM's kernel kills whichever container it likes, so the
 * session that dies is rarely the one that was greedy, and it dies as exit 137
 * with no stderr, which reads as a crash in the developer's own code.
 *
 * ponytail: a constant, not a calculation. The honest version reads the VM's
 * size (`docker info --format {{.MemTotal}}`) and divides by the configured cap,
 * so raising Sandbox memory lowers this by itself instead of silently
 * oversubscribing. Do that when someone actually runs a cap this number cannot
 * carry; two is safe for every default.
 */
const MAX_CONTAINERS = 2

/**
 * How long a verification or API run may go without reporting before the
 * watchdog presumes its session is dead and closes it.
 *
 * ponytail: a flat wall-clock ceiling, not history-aware. It cannot tell a stuck
 * run from a genuinely slow one, so it is set well past any real run — mutation
 * testing takes minutes where a unit pass takes seconds. Its job is to notice a
 * process that obviously died, not to police how long a run may take. Upgrade it
 * to a per-selection estimate (estimateRunMs, already computed for the Tests
 * panel) only if a real slow run is ever swept.
 */
const RUN_DEADLINE_MS = 45 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

/** Why a cancelled run proved nothing — distinct from a session that gave up on
 *  its own, which reads the same on the row without this. */
const CANCEL_NOTE = 'You stopped this run before it reported, so nothing it measured is known.'

const UPDATABLE_KINDS: ReadonlySet<EventKind> = new Set([
  'prompt',
  'assistant_text',
  'tool_activity',
  'question',
  'permission_marker',
  'plan_marker',
])

/**
 * Kinds whose updates only ever arrive while they are still streaming, so an old
 * one can be forgotten. Markers and questions are deliberately NOT here: a
 * permission decided ten minutes later still updates its marker, so evicting
 * those would silently drop the decision from the stream.
 */
const STREAM_LOCAL_KINDS: ReadonlySet<EventKind> = new Set([
  'prompt',
  'assistant_text',
  'tool_activity',
])

/**
 * How many stream-local events stay updatable. Without a cap, `live` held every
 * partial's full payload for the session's entire life, which on a long run is
 * unbounded main-process memory. Generous on purpose: updates target the last
 * few events, so 200 is far beyond what streaming actually reaches back for, and
 * `update()` already no-ops on an id it does not hold.
 */
const MAX_LIVE_STREAM_EVENTS = 200

/** The kinds the transcript body carries, and so the only ones worth rewriting
 *  the file for. Tool calls are counted in its digest but not transcribed. */
const TRANSCRIBED_KINDS: ReadonlySet<EventKind> = new Set(['prompt', 'assistant_text', 'summary'])

/**
 * How long after the last transcribed event the transcript is rewritten. Long
 * enough that a streaming turn costs one write rather than dozens, short enough
 * that a crash loses seconds of conversation rather than a session's worth.
 */
const TRANSCRIPT_DEBOUNCE_MS = 3000

function evictStaleLive(entry: HostedEntry): void {
  let streamLocal = 0
  for (const { event } of entry.live.values()) {
    if (STREAM_LOCAL_KINDS.has(event.kind)) streamLocal++
  }
  if (streamLocal <= MAX_LIVE_STREAM_EVENTS) return
  let toDrop = streamLocal - MAX_LIVE_STREAM_EVENTS
  // Map iterates in insertion order, so this drops the oldest first.
  for (const [id, { event }] of entry.live) {
    if (toDrop === 0) break
    if (!STREAM_LOCAL_KINDS.has(event.kind)) continue
    entry.live.delete(id)
    toDrop--
  }
}

async function readGitBranch(projectPath: string): Promise<string | null> {
  try {
    // --show-current returns the branch even on an unborn branch (no commits)
    // and empty on detached HEAD, unlike rev-parse --abbrev-ref. Async
    // (execFile + promisify) so it never blocks the main-process event loop —
    // this runs on every session start and after every completed turn.
    // The repository, which may be one folder below the project root (gitRoot).
    // Without this a project registered by its containing folder showed no
    // branch on any of its sessions, and the sidebar had nothing to name them by.
    const root = gitRoot(projectPath) ?? projectPath
    const { stdout } = await execFileAsync('git', ['-C', root, 'branch', '--show-current'], {
      timeout: 4000,
      windowsHide: true,
    })
    const branch = stdout.trim()
    return branch.length > 0 ? branch : null
  } catch {
    return null
  }
}

/** First 8000 bytes containing a NUL byte — the same heuristic git itself
 *  uses to decide whether to print "Binary files ... differ". */
function isBinaryContent(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

type NumstatEntry = { adds: number | null; dels: number | null; binary: boolean }

/**
 * `git diff --numstat`, read ONCE and answering both questions it can answer:
 * the working tree's total line churn for the header counters, and the per-file
 * counts the Diff tab lists.
 *
 * These were two functions running the same command against the same working
 * tree moments apart on every completed turn, because one wanted the sum and
 * the other wanted the rows. Neither cached, so a refresh paid for four git
 * spawns where three do — and on Windows the spawn is the expensive part, not
 * the diff.
 *
 * `totals` is null when git itself failed, which is not the same as a clean
 * tree: the header then shows no counters rather than a fabricated zero. Binary
 * files report "-" for both counts (git's own convention) and map to null
 * rather than 0, so they read as "unavailable" and not as "no change"; they add
 * nothing to the totals. Tracked changes only — untracked files never appear.
 */
async function readNumstat(projectPath: string): Promise<{
  totals: { adds: number; dels: number } | null
  byPath: Map<string, NumstatEntry>
}> {
  const byPath = new Map<string, NumstatEntry>()
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'git',
      ['-C', projectPath, 'diff', '--numstat'],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return { totals: null, byPath }
  }
  let adds = 0
  let dels = 0
  for (const line of stdout.split('\n')) {
    const [a, d, path] = line.split('\t')
    if (path === undefined) continue
    const binary = a === '-' && d === '-'
    const fileAdds = binary ? null : Number.parseInt(a, 10) || 0
    const fileDels = binary ? null : Number.parseInt(d, 10) || 0
    byPath.set(path, { adds: fileAdds, dels: fileDels, binary })
    adds += fileAdds ?? 0
    dels += fileDels ?? 0
  }
  return { totals: { adds, dels }, byPath }
}

/** A new, untracked file has no git-tracked baseline: its whole readable
 *  content counts as added lines (research.md decision 4 — no `--no-index`,
 *  no index mutation). */
async function readUntrackedEntry(projectPath: string, path: string): Promise<DiffFileEntry> {
  try {
    const content = await readFile(join(projectPath, path))
    if (isBinaryContent(content)) {
      return { path, status: 'untracked', addedLines: null, removedLines: null, binary: true }
    }
    const text = content.toString('utf8')
    const lineCount = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return { path, status: 'untracked', addedLines: lineCount, removedLines: 0, binary: false }
  } catch {
    // Vanished between the status read and this read — counts unavailable
    // rather than a fabricated zero.
    return { path, status: 'untracked', addedLines: null, removedLines: null, binary: false }
  }
}

/**
 * Every file with an uncommitted change in the project's working tree,
 * tracked and untracked alike (FR-002). `git status --porcelain=v1 -z` is
 * the one call that reports both in a single, unambiguous (NUL-terminated)
 * read; `git diff --numstat` then supplies line counts for the tracked ones.
 */
export async function readDiffList(projectPath: string): Promise<DiffListResult> {
  // The repository, which is not always the project root: see gitRoot. This
  // used to refuse outright on any gitNotice, but that notice describes what
  // will not work INSIDE THE CONTAINER — a worktree pointer at a gitdir outside
  // the mount, a parent repository the mount does not reach. The diff runs here,
  // on the host, where none of those limits apply, so a project whose repository
  // sits one folder down showed an empty Diff tab and a reason that was not
  // about it.
  const root = gitRoot(projectPath)
  if (!root) {
    return { gitNotice: 'The project is not a git repository — there is no git history to diff.', files: [] }
  }

  let statusOut: string
  try {
    ;({ stdout: statusOut } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z'],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return { gitNotice: 'Unable to read this project’s working tree.', files: [] }
  }

  const { byPath: numstat } = await readNumstat(root)
  const tokens = statusOut.split('\0').filter((t) => t.length > 0)
  const files: DiffFileEntry[] = []
  const untrackedPaths: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const code = token.slice(0, 2)
    const path = token.slice(3)
    // A rename/copy status carries a second NUL-terminated field (the
    // original path) that this tab has no use for (spec.md edge cases: no
    // dedicated rename-detection UI) — consume and discard it.
    if (code[0] === 'R' || code[0] === 'C') i++
    const status: DiffFileStatus =
      code === '??'
        ? 'untracked'
        : code.includes('D')
          ? 'deleted'
          : code[0] === 'R'
            ? 'renamed'
            : code.includes('A')
              ? 'added'
              : 'modified'

    if (status === 'untracked') {
      untrackedPaths.push(path)
      continue
    }
    const counts = numstat.get(path)
    files.push({
      path,
      status,
      addedLines: counts?.adds ?? null,
      removedLines: counts?.dels ?? null,
      binary: counts?.binary ?? false,
    })
  }
  // Untracked files are read after the status walk, a bounded batch at a time,
  // rather than one at a time inside it. Each read opens and counts a whole
  // file, so serially this cost the sum of every read; in batches it costs the
  // slowest read in each batch. The cap is deliberate: readFile against ten
  // thousand paths at once exhausts the process's file handles, and
  // readUntrackedEntry answers that with "counts unavailable", so the failure
  // would be silent wrong numbers rather than an error anyone sees.
  const BATCH = 32
  for (let i = 0; i < untrackedPaths.length; i += BATCH) {
    const batch = untrackedPaths.slice(i, i + BATCH)
    files.push(...(await Promise.all(batch.map((p) => readUntrackedEntry(root, p)))))
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { gitNotice: null, files }
}

/** Unified-diff body → typed lines, skipping the header/hunk noise. Detects
 *  git's own "Binary files ... differ" line rather than trying to decode
 *  binary content as text. */
function parseUnifiedDiff(diffText: string): FileDiffContent {
  if (/^Binary files /m.test(diffText)) return { binary: true, lines: [] }
  const lines: FileDiffContent['lines'] = []
  for (const raw of diffText.split('\n')) {
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw.startsWith('@@') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename from') ||
      raw.startsWith('rename to')
    ) {
      continue
    }
    if (raw.startsWith('+')) lines.push({ type: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) lines.push({ type: 'del', text: raw.slice(1) })
    else if (raw.startsWith(' ')) lines.push({ type: 'context', text: raw.slice(1) })
    // A trailing split artefact or "\ No newline at end of file" — neither is a line.
  }
  return { binary: false, lines }
}

/**
 * One file's diff content, fetched only on selection (FR-006). `git status`
 * for that single path decides the branch: no current entry → null (nothing
 * to show); `??` → the untracked whole-file-as-additions path; anything else
 * → an ordinary tracked `git diff`.
 */
export async function readFileDiff(projectPath: string, path: string): Promise<FileDiffContent | null> {
  // Same repository resolution as readDiffList, and it has to be: the paths this
  // is asked about came from that listing, so they are relative to whatever root
  // it used. Reading them against a different directory finds nothing.
  const root = gitRoot(projectPath) ?? projectPath
  let statusOut: string
  try {
    ;({ stdout: statusOut } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '--', path],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return null
  }
  if (statusOut.trim().length === 0) return null // no current change for this path

  if (statusOut.startsWith('??')) {
    const entry = await readUntrackedEntry(root, path)
    if (entry.binary) return { binary: true, lines: [] }
    if (entry.addedLines === null) return null // vanished since the status read
    const content = await readFile(join(root, path), 'utf8')
    const rawLines = content.length === 0 ? [] : content.split('\n')
    if (content.endsWith('\n')) rawLines.pop()
    return { binary: false, lines: rawLines.map((text) => ({ type: 'add', text })) }
  }

  let diffOut: string
  try {
    ;({ stdout: diffOut } = await execFileAsync(
      'git',
      ['-C', root, 'diff', '--', path],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return { binary: false, lines: [] }
  }
  return parseUnifiedDiff(diffOut)
}

export class SessionManager {
  private hosted = new Map<string, HostedEntry>()
  /* The starting-reservation guard is gone; a project is no longer capped at
     one session (see startSession's doc). */
  private classifier: NoiseClassifier | null = null
  /** Pending debounced transcript writes, keyed by session id. */
  private transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Models this subscription can select, captured from the SDK's supportedModels()
   *  on any session start, or probed on demand by `models()`. Account-global and
   *  in-memory: the account's model list is whatever the CLI reports today. */
  availableModels: AvailableModel[] = []
  private probingModels: Promise<AvailableModel[]> | null = null

  constructor(
    private repos: Repositories,
    private callbacks: SessionManagerCallbacks,
  ) {}

  /**
   * The selectable model list, probing the CLI once when no session has reported
   * one yet (a cold start opening Settings). Empty only when the CLI is missing
   * or too old to answer, in which case the picker offers the account default.
   */
  async models(): Promise<AvailableModel[]> {
    if (this.availableModels.length > 0) return this.availableModels
    // ponytail: concurrent callers share one in-flight probe; a failure simply
    // re-probes on the next ask (no backoff, no cached negative result).
    this.probingModels ??= probeAvailableModels(
      this.repos.projects.listActive()[0]?.path ?? process.cwd(),
    )
    try {
      const models = await this.probingModels
      if (models.length > 0) this.availableModels = models
    } finally {
      this.probingModels = null
    }
    return this.availableModels
  }

  setNoiseClassifier(classifier: NoiseClassifier): void {
    this.classifier = classifier
  }

  /** Startup reconciliation (FR-022): nothing from a previous run stays live. */
  reconcileOnStartup(): void {
    this.repos.sessions.reconcileAllEnded('app_exit')
    for (const request of this.repos.requests.pending()) {
      this.repos.requests.resolve(request.id, 'expired')
    }
    // Verification and API runs close when the session's turn ends, which never
    // happens if the container was SIGKILLed or the app was killed. Left alone, one
    // orphaned row makes the Tests section read as permanently Running and refuse
    // to start another run, which is exactly what FR-022 exists to prevent.
    const note =
      'The application closed before this run reported a result, so nothing it measured is known.'
    this.repos.verifyRuns.reconcileRunning(note)
    this.repos.apiRuns.reconcileRunning(note)
    // Sessions are not only DB rows now: a bypass session owns a container that
    // outlives a hard kill, so reconciling the rows without reaping those would
    // leave an autonomous agent running against the project folder.
    sweepOrphanedContainers()
  }

  /**
   * The same repair as reconcileOnStartup, on a timer, for the case that one
   * could never reach: a session that dies or stalls while the app stays up.
   *
   * A run is otherwise closed only by its session's turn ending, and a SIGKILLed
   * container produces no turn end. Before this, the row read Running until the
   * next launch — with the Run button disabled behind it — so the only recovery
   * was to restart the app.
   */
  startWatchdog(deadlineMs = RUN_DEADLINE_MS, intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => this.sweepStaleRuns(deadlineMs), intervalMs)
    // Never hold the process open for a sweep: this is housekeeping, and Electron
    // should be free to quit between ticks.
    this.watchdog.unref?.()
  }

  stopWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  private watchdog: ReturnType<typeof setInterval> | null = null

  private sweepStaleRuns(deadlineMs: number): void {
    const deadline = new Date(Date.now() - deadlineMs).toISOString()
    const note =
      'This run went quiet for long enough that its session is presumed dead, so nothing it measured is known.'
    for (const projectId of this.repos.verifyRuns.reconcileStale(deadline, note)) {
      this.callbacks.onVerifyChanged(projectId)
    }
    for (const projectId of this.repos.apiRuns.reconcileStale(deadline, note)) {
      this.callbacks.onApiChanged(projectId)
    }
  }

  /**
   * The model routing a project's session should use RIGHT NOW: the INTELLIGENT
   * model (plans, questions, orchestrator loops, the advisor) and the WORKER
   * model (advisor-mode executor + orchestrator workers), each taking the
   * "This project" override when set, else the global Models tab.
   *
   * Read at session start AND again before every turn (see HostedSession's
   * resolveModels), so changing a model in Settings reaches a running session on
   * its next turn instead of only the next session.
   */
  private resolveModelRouting(projectId: string): {
    intelligentModel: string
    workerModel: string
    modelMode: ModelMode
    autoModelRouting: boolean
  } {
    const settings = this.repos.settings.get()
    const override = settings.projectModels?.[projectId]
    const workerOverride = settings.projectWorkerModels?.[projectId]
    return {
      intelligentModel:
        override && override !== 'global' ? override : settings.intelligentModel,
      workerModel:
        workerOverride && workerOverride !== 'global' ? workerOverride : settings.workerModel,
      modelMode: settings.modelMode ?? 'auto',
      autoModelRouting: settings.autoModelRouting,
    }
  }

  /**
   * A project may run as many sessions as the developer starts. The per-project
   * reservation that used to wrap this is gone with the limit it enforced: it
   * existed so a second concurrent start could not slip past the "already active"
   * check while the first was still awaiting, and two concurrent starts are now the
   * point rather than the race. Nothing else depended on it — the sessions table
   * has always been keyed by session id, not by project.
   *
   * Uncapped for a NATIVE session, which is just a CLI child process: a developer
   * who starts twenty will feel it, and where that becomes too many is a product
   * decision rather than a safety one.
   *
   * Containerised sessions are capped, because there the ceiling IS a safety one.
   * Every container shares one WSL virtual machine of fixed size, so two at the
   * default cap can ask for more than the VM has, and the kernel then kills a
   * container that never exceeded its own limit — reported as exit 137 with no
   * stderr, on whichever session was unlucky rather than the greedy one. That was
   * a live crash, not a hypothetical: this comment previously said inventing a
   * number would be guessing, and the number that got used instead was infinity.
   * See MAX_CONTAINERS.
   */
  async startSession(
    projectId: string,
    resume = false,
    /** Omitted means "use the project's own defaultSessionMode", the normal path. */
    requestedMode?: SessionMode,
    carryTranscriptFrom?: string,
    /** Run in a container while keeping the mode's own permission behaviour. The
     *  sections ask for this; nothing else does. `background` marks a session
     *  started FOR a section rather than by the developer. */
    opts?: { containerised?: boolean; background?: boolean },
  ): Promise<Session> {
    const project = this.repos.projects.byId(projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
    // The project owns the mode; a request may override it for one session (the
    // restart controls do). Resolved once, here, so everything below reads one
    // value rather than re-deciding.
    const mode = requestedMode ?? project.defaultSessionMode
    const bypassPermissions = mode === 'bypass'
    // Two axes now, not one. Bypass still implies a container; a section can ask
    // for a container without asking for bypass, which is the combination the
    // sections need: isolated from the developer's checkout, still gated.
    const containerised = opts?.containerised === true || bypassPermissions
    // No "already active" refusal (see startSession's doc). `resume` still means
    // "the last session that ended here", not "the only one".
    // A containerised session needs the image (docker-sandbox): fail here, before a
    // row exists, when Docker is down or not logged in. First call builds the
    // image for this project's stack, which can take minutes (tens of them for
    // the .NET one) — the renderer awaits with its busy state.
    // Before the image, because a queue behind a slow image build is a queue
    // whose wait nobody can account for.
    if (containerised) this.refuseWhenContainersFull()
    if (containerised) await ensureSandboxImage(project.path)
    // The app drives the user's own Claude Code CLI and no longer bundles a copy
    // (that binary is ~245 MB). Every Switchboard user has Claude Code, so this
    // is normally present; if not, fail with a clear message rather than letting
    // the SDK spawn the wrong runtime and crash under Electron.
    const claudeExecutablePath = resolveClaudeExecutable()
    if (!claudeExecutablePath) {
      throw { code: 'NOT_FOUND', message: 'Claude Code was not found. Install it from https://claude.com/claude-code, then start a session.' } satisfies IpcError
    }

    let resumeSdkSessionId: string | undefined
    // The ancestor's Switchboard id, not just its SDK id: a containerised resume
    // has to open the volume that ancestor's ~/.claude was written into, which is
    // keyed by session id (see homeVolumeFor). Resolving both from the same row is
    // what keeps the transcript the SDK is told to resume and the home volume it
    // is resumed in from pointing at two different sessions.
    let resumeFromSessionId: string | undefined
    if (resume) {
      const previous = this.repos.sessions.latestEndedForProject(projectId)
      resumeSdkSessionId = previous?.sdkSessionId ?? undefined
      resumeFromSessionId = previous?.id
    }

    const row: Session = {
      id: newId(),
      projectId,
      sdkSessionId: null,
      status: 'working',
      statusDetail: null,
      // Filled asynchronously by refreshBranch() just after start, so the git
      // read never blocks session creation on the main thread.
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: nowIso(),
      endedAt: null,
      endReason: null,
      // Persisted: it drives the "⚠ Bypass" header pill, and after the session
      // ends it is the only record of whether the transcript went to the host or
      // to this project's container volume — which resume has to match.
      bypassPermissions,
      // Both are projections of the one resolved mode now (see
      // resolvePermissionMode for why that replaced two separate booleans).
      // Still persisted because each answers a question the mode alone does
      // not — where the transcript lives, how the session began — and because
      // the header pill and the restart toggle read them.
      planMode: mode === 'plan',
      inPlanMode: mode === 'plan',
    }
    this.repos.sessions.insert(row)

    const entry: HostedEntry = {
      row,
      projectPath: project.path,
      seq: this.repos.events.maxSeq(row.id),
      live: new Map(),
      containerised,
      background: opts?.background === true,
      session: null as unknown as HostedSession,
    }

    const settings = this.repos.settings.get()
    const { intelligentModel, workerModel } = this.resolveModelRouting(projectId)
    // Any project that has previously run an MCP scan gets its schema map
    // injected as context on every session start (no-op when never scanned).
    // Scans are per-combination now: prefer the ACTIVE combination's doc and
    // fall back to the legacy single db-schema.md from before the split.
    const terseAppend = terseSystemPromptAppend({
      terseMode: settings.terseMode,
      terseLevel: settings.terseLevel,
    })
    // ADHD output style as the backbone — on when the global i-have-adhd
    // always-on flag is set, so app sessions match every other Claude session.
    const adhdAppend = adhdSystemPromptAppend()
    const activeCombo = settings.mcpActiveServers ?? []
    const schemaDoc = (
      (activeCombo.length > 0 ? readComboDoc(project.path, activeCombo) : null) ??
      readSchemaDoc(project.path)
    )?.trim()
    const schemaAppend = schemaDoc
      ? `## Database schema (from a previous MCP scan)\n\n${schemaDoc}`
      : null
    // Divide-and-conquer when the developer has asked for it (static text, so it
    // sits in the cached prefix like the other shaping appends). Recorded on the
    // row as well: the header pill is the only way to tell, from a session that is
    // already running, whether it started under this setting — the toggle applies
    // at spawn and cannot reach a live session's system prompt.
    const heavySubagents = settings.heavySubagents === true
    row.heavySubagents = heavySubagents
    const heavyAppend = heavySubagentSystemPromptAppend(heavySubagents)
    // Advisor/Orchestrator protocol (static text — prompt-cache friendly). Pinned
    // to Orchestrator under heavy subagents, or the two appends contradict:
    // Advisor's text says to implement scoped work yourself.
    const modesAppend = modesSystemPromptAppend(
      heavySubagentModelMode(heavySubagents, settings.modelMode ?? 'auto'),
    )
    // A carried-over transcript: the digest inline, the full file named. Expired
    // transcripts resolve to null, so a stale carry request is simply ignored
    // rather than starting a session that claims context it does not have.
    const carried = carryTranscriptFrom ? transcriptFor(carryTranscriptFrom) : null
    const transcriptAppend = carried ? transcriptContextAppend(carried) : null
    // A containerised CLI has to be told the layout, or it hunts for host paths
    // that cannot exist inside the container and calls mounted refs unreachable.
    // Keyed to the container rather than to bypass: a section's session is
    // containerised without being bypass, and needs this just as much.
    const sandboxAppend = containerised
      ? sandboxSystemPromptAppend(
          [{ container: '/workspace' }, ...refMounts(project.refs.map((r) => r.path))],
          // Only a .git DIRECTORY at the root survives the mount; anything else
          // reads as "history deleted" unless stated here (see gitNotice).
          gitNotice(project.path),
          hasNodeModulesVolume(project.path),
        )
      : null
    // Guarded: this constructor runs after the row is already inserted but before
    // `hosted.set` registers the entry. Left unguarded, a throw here would leave
    // the row persisted with endedAt null and never registered, so projectList's
    // fallback would present an orphaned "working" session forever — no ended
    // banner, so no Start button and no way to retry.
    try {
      entry.session = new HostedSession({
        sessionId: row.id,
        projectPath: project.path,
        // ponytail: refs added mid-session apply from the next session start.
        refDirs: project.refs.map((r) => r.path),
        // Read at session start, like the models: a Settings change applies to
        // the NEXT bypass session (the container's cap is fixed at docker run).
        sandboxMemory: settings.sandboxMemory,
        resumeSdkSessionId,
        resumeFromSessionId,
        systemPromptAppend:
          // The carried transcript goes last: it is the only part of this that is
          // about one specific run, so the static shaping text stays in the cached
          // prefix ahead of it.
          [
            sandboxAppend,
            adhdAppend,
            terseAppend,
            modesAppend,
            heavyAppend,
            schemaAppend,
            transcriptAppend,
          ]
            .filter((s): s is string => Boolean(s))
            .join('\n\n') || undefined,
        claudeExecutablePath,
        // The hosted session's plan/work slots both take the intelligent model;
        // the pairing modes decide when the worker runs the loop instead.
        // One main-loop model for the session (Advisor runs the cheap one), so no
        // turn ever switches it and throws away the prompt cache.
        mainModel: mainLoopModel(settings.modelMode, { intelligentModel, workerModel }),
        strongModel: intelligentModel,
        workerModel,
        autoModelRouting: settings.autoModelRouting,
        modelMode: settings.modelMode,
        // Re-read before each turn so a Settings change lands on a RUNNING session
        // (the note in Settings promises exactly that).
        resolveModels: () => this.resolveModelRouting(projectId),
        // Pairing mode per work turn — in-memory only, shown as a header chip.
        onTurnMode: (mode) => {
          if (entry.row.currentMode === mode) return
          entry.row.currentMode = mode
          this.pushStatus(entry)
        },
        mode,
        containerised,
        // What the CLI itself reports, not what was asked for: a CLI too old to
        // honour 'plan' would otherwise leave the header claiming a restriction
        // that is not in force.
        onPlanModeChange: (inPlanMode) => {
          if (entry.row.inPlanMode === inPlanMode) return
          entry.row.inPlanMode = inPlanMode
          this.pushStatus(entry)
        },
        summaries: settings.summaries,
        sink: this.makeSink(entry),
        gate: this.callbacks.gate,
        onStatusChange: (status, detail) => this.handleStatusChange(entry, status, detail),
        onSdkSessionId: (sdkSessionId) => {
          entry.row.sdkSessionId = sdkSessionId
          this.repos.sessions.update(row.id, { sdkSessionId })
        },
        onCommands: (commands) => {
          this.repos.projectCommands.set(projectId, commands)
          this.callbacks.onProjectCommands(projectId, commands)
        },
        onUsage: (usage) => {
          entry.row.usageUtilization = usage.utilization
          entry.row.usageResetsAt = usage.resetsAt
          entry.row.usageLimitType = usage.limitType
          this.repos.sessions.update(row.id, {
            usageUtilization: usage.utilization,
            usageResetsAt: usage.resetsAt,
            usageLimitType: usage.limitType,
          })
          this.pushStatus(entry)
        },
        // MCP servers from the init message — in-memory only, pushed to the sidebar.
        onMcpServers: (servers) => {
          entry.row.mcpServers = servers
          this.pushStatus(entry)
        },
        // Model reported per main-loop turn — in-memory only, shown in the header.
        onModel: (model) => {
          entry.row.currentModel = model
          this.pushStatus(entry)
        },
        // Models this subscription can select — account-global, cached for the
        // settings model list (which discovers new models from it automatically).
        onModels: (models) => {
          this.availableModels = models
        },
        // Live background tasks — in-memory only, shown as a card + header pill.
        onBackgroundTasks: (tasks) => {
          entry.row.backgroundTasks = tasks
          this.pushStatus(entry)
        },
        // Per-model usage — in-memory only, drives the header's session-total +
        // top-model chips. The SDK's per-turn modelUsage is session-CUMULATIVE, so
        // this replaces per model rather than adding (see foldModelTotals).
        onModelUsage: (modelUsage) => {
          entry.row.modelTotals = foldModelTotals(entry.row.modelTotals ?? {}, modelUsage)
          this.pushStatus(entry)
        },
        onTurnComplete: () => {
          this.observeBranch(entry)
          // A completed turn that left the session idle pulls the next planned task.
          this.maybeDrainQueue(entry.row.projectId)
        },
        onExit: (reason, detail) => this.handleExit(entry, reason, detail),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.failStart(row, detail)
      throw {
        code: 'INTERNAL',
        message: `Session failed to start: ${detail}`,
      } satisfies IpcError
    }

    this.hosted.set(row.id, entry)
    entry.session.start()
    // Read the git branch off the hot path and push it in when it resolves.
    void this.refreshBranch(entry)
    this.callbacks.onCountersChanged()
    // A freshly-started idle session runs any tasks already planned for it.
    this.maybeDrainQueue(projectId)
    return { ...entry.row }
  }

  // --- Planned task queue (FR-023) ---

  listQueue(projectId: string): QueuedTask[] {
    return this.repos.taskQueue.listForProject(projectId)
  }

  enqueueTask(projectId: string, text: string): void {
    if (text.trim().length === 0) return
    this.repos.taskQueue.add(projectId, text)
    this.callbacks.onQueueChanged(projectId)
    this.maybeDrainQueue(projectId)
  }

  /**
   * Reword a planned task. Deliberately does NOT drain the queue afterwards:
   * editing what is waiting must not be the act that sends it, or a half-typed
   * correction to the front task goes to the session the moment it is saved.
   */
  editTask(projectId: string, id: string, text: string): void {
    this.repos.taskQueue.update(id, text)
    this.callbacks.onQueueChanged(projectId)
  }

  removeTask(projectId: string, id: string): void {
    this.repos.taskQueue.remove(id)
    this.callbacks.onQueueChanged(projectId)
  }

  /** The project's hosted entry, or undefined when no session is live for it
   *  (the Diff tab, and anything else that must confirm liveness rather than
   *  trust the renderer's own belief, calls this). */
  liveEntryForProject(projectId: string): HostedEntry | undefined {
    return [...this.hosted.values()].find((e) => e.row.projectId === projectId)
  }

  /**
   * Delivers the front-of-queue task when the project's session is live and
   * idle (turn finished, nothing blocking on the developer). No-op otherwise,
   * so the queue simply waits for the current turn or a decision to clear.
   */
  private maybeDrainQueue(projectId: string): void {
    const entry = this.liveEntryForProject(projectId)
    if (!entry || entry.session.currentStatus !== 'done') return
    const next = this.repos.taskQueue.takeNext(projectId)
    if (!next) return
    this.callbacks.onQueueChanged(projectId)
    this.sendMessage(entry.row.id, next.text)
  }

  /**
   * Rewords a queued composer message, or withdraws it when `text` is empty.
   *
   * Refuses rather than no-ops when the message has already been delivered: the
   * turn finishing is a race the developer cannot see, and telling them it worked
   * when the session already has the old text would be the worse failure.
   */
  editQueuedSend(sessionId: string, eventId: string, text: string): void {
    const entry = this.requireLive(sessionId)
    if (!entry.session.editQueuedSend(eventId, text)) {
      throw {
        code: 'NOT_FOUND',
        message: 'That message has already been sent, so it can no longer be changed.',
      } satisfies IpcError
    }
  }

  sendMessage(sessionId: string, text: string, agentId?: string): { eventId: string; queued: boolean } {
    const entry = this.requireLive(sessionId)
    const send = entry.session.send(text)
    const sink = this.makeSink(entry)
    // agentId tags prompts addressed at a subagent so they show in its chat view.
    const event = sink.append('prompt', { text, pending: send.queued, agentId })
    // Record the command for terminal-style composer suggestions.
    this.repos.commandHistory.add(entry.row.projectId, text)
    send.deliver(event.id)
    return { eventId: event.id, queued: send.queued }
  }

  async interruptSession(sessionId: string): Promise<{ stillQueued: number }> {
    const entry = this.requireLive(sessionId)
    return entry.session.interrupt()
  }

  /**
   * Switch a live session into or out of plan mode, no restart.
   *
   * Refused for a bypass session: it never reaches the permission gate, so the
   * plan approval this mode exists to produce could never be raised, and the
   * developer would be waiting on a review that cannot arrive.
   */
  setPlanMode(sessionId: string, enabled: boolean): void {
    const entry = this.requireLive(sessionId)
    if (entry.row.bypassPermissions) {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'A bypass session approves everything, so it has nothing to plan against.',
      } satisfies IpcError
    }
    entry.session.setPlanMode(enabled)
    entry.row.inPlanMode = enabled
    this.pushStatus(entry)
  }

  /**
   * The plan was approved, so plan mode is over — that is what ExitPlanMode's
   * approval means by the tool's own contract, and the broker calls this when it
   * settles one. Acting on the approval rather than waiting for the CLI to report
   * the change: the header claiming "Planning" for a session that has resumed
   * work is the more visible of the two possible errors, and the reported mode
   * still corrects this if it disagrees.
   */
  planExited(sessionId: string): void {
    const entry = this.hosted.get(sessionId)
    if (!entry || !entry.row.inPlanMode) return
    entry.row.inPlanMode = false
    this.pushStatus(entry)
  }

  /**
   * The session a verification run should talk to: this project's own verify
   * session, started if it is not already alive.
   *
   * Dispatches used to resolve their target with `sessions.activeForProject` —
   * whichever session is open, ordinarily the one the developer is chatting in.
   * A verification pass is a long turn (runs suites, reads artefacts, writes a
   * report), and queuing it into the chat session blocked the conversation and
   * interleaved build output with the developer's own work.
   *
   * Reuse is keyed off the sessionId already persisted on the newest verify run,
   * API run, or diagram request — no new table, and no second registry that
   * could disagree with the work itself — so a verify run, an API set, and a
   * diagram in the same project share one session.
   *
   * Deliberately never falls back to `activeForProject`: that IS the removed
   * behaviour, and a fallback would restore the bug on the first run after a
   * tests session ends.
   */
  async backgroundSessionFor(projectId: string): Promise<Session> {
    const candidates = [
      this.repos.verifyRuns.listForProject(projectId)[0]?.sessionId,
      this.repos.apiRuns.listForProject(projectId)[0]?.sessionId,
      // Diagram generation joined this rather than taking a third session of its
      // own: it is the same kind of work, a long turn whose output the developer
      // wants to look at afterwards rather than watch arrive.
      this.repos.diagramRequests.latestSessionFor(projectId),
    ]
    for (const id of candidates) {
      if (!id) continue
      const existing = this.repos.sessions.byId(id)
      if (existing && !existing.endedAt) return existing
    }
    // Containerised, keeping the project's own permission mode. A section runs
    // builds, test suites and cleanup passes; those should not be able to touch
    // the developer's checkout, and they should still ask before doing something
    // that needs asking. Until now only bypass could give the first, and it gave
    // the second away to get it.
    return this.startSession(projectId, false, undefined, undefined, {
      containerised: true,
      background: true,
    })
  }

  /**
   * Stop a run the developer no longer wants.
   *
   * Interrupting the session is what actually stops the work; the row is then
   * closed here rather than left to the interrupt's own turn-end path, so the
   * note says the developer stopped it instead of "the session finished without
   * reporting", which is true of a very different situation. The interrupt is
   * best-effort: a session already gone still leaves a row that needs closing,
   * and cancelling a run that finished on its own in the meantime is a no-op
   * rather than an error — the intent is satisfied either way.
   */
  async cancelVerifyRun(runId: string): Promise<void> {
    const run = this.repos.verifyRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    if (run.status !== 'running') return
    if (run.sessionId) await this.interruptSession(run.sessionId).catch(() => {})
    this.verifyWatch.delete(run.sessionId ?? '')
    this.repos.verifyRuns.finish(runId, 'inconclusive', null, CANCEL_NOTE)
    this.callbacks.onVerifyChanged(run.projectId)
  }

  /** The API-set twin of cancelVerifyRun. Note the limit: this stops the session
   *  being asked for request data. Once the app itself is mid-loop making the
   *  real calls, there is nothing here to interrupt. */
  async cancelApiRun(runId: string): Promise<void> {
    const run = this.repos.apiRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    if (run.status !== 'running') return
    if (run.sessionId) await this.interruptSession(run.sessionId).catch(() => {})
    this.apiWatch.delete(run.sessionId ?? '')
    this.repos.apiRuns.finish(runId, 'error', run.calls, CANCEL_NOTE, run.launched)
    this.callbacks.onApiChanged(run.projectId)
  }

  async stopSession(sessionId: string): Promise<void> {
    const entry = this.requireLive(sessionId)
    // Same as app exit (FR-022): undelivered composer sends survive as drafts.
    for (const queued of entry.session.takeQueuedSends()) {
      this.repos.drafts.insert(entry.row.projectId, queued.text)
    }
    await entry.session.stop()
  }

  /** Graceful shutdown for application exit (FR-022): queued sends become drafts. */
  async endAllForAppExit(): Promise<void> {
    const entries = [...this.hosted.values()]
    for (const entry of entries) {
      for (const queued of entry.session.takeQueuedSends()) {
        this.repos.drafts.insert(entry.row.projectId, queued.text)
      }
    }
    await Promise.allSettled(entries.map((entry) => entry.session.stop()))
    for (const entry of entries) {
      this.finaliseRow(entry, 'app_exit') // no-op for any the run loop already ended
    }
    this.hosted.clear()
  }

  anySessionMidTask(): boolean {
    return [...this.hosted.values()].some((entry) => entry.session.isMidTask)
  }

  liveSessionRow(sessionId: string): Session | undefined {
    const entry = this.hosted.get(sessionId)
    return entry ? { ...entry.row } : undefined
  }

  liveSessionIds(): string[] {
    return [...this.hosted.keys()]
  }

  /**
   * Tell every live session to re-read its plugins, after one was installed.
   *
   * Every session, not just the project's: a plugin is installed at user scope
   * on the host, so it becomes available to all of them at once, and a developer
   * who installs from one project should not find the other projects still
   * offering to install it.
   *
   * Settles rather than races: one session that cannot answer must not stop the
   * rest from refreshing.
   */
  async reloadPlugins(): Promise<void> {
    await Promise.allSettled([...this.hosted.values()].map((entry) => entry.session.reloadPlugins()))
  }

  /**
   * The session's connected MCP servers, waiting briefly for them to arrive.
   *
   * `startSession` resolves as soon as the process is spawned; the server list
   * comes later, on the SDK's init message. A caller that reads the live row
   * immediately after starting a session therefore sees nothing at all — which
   * silently produced a verification prompt naming no database server even though
   * the developer had them configured and connecting.
   *
   * Waits only while it can still change something: until every name in `wanted`
   * has reported connected, or the deadline passes. Returns whatever is connected
   * by then, so a server that never comes up delays the run rather than blocking
   * it. With nothing wanted it returns at once and never waits.
   */
  async connectedMcpServers(sessionId: string, wanted: readonly string[], timeoutMs = 8000): Promise<string[]> {
    const connected = (): string[] =>
      (this.hosted.get(sessionId)?.row.mcpServers ?? [])
        .filter((s) => s.status.toLowerCase() === 'connected')
        .map((s) => s.name)

    if (wanted.length === 0) return []
    const deadline = Date.now() + timeoutMs
    let live = connected()
    while (Date.now() < deadline && !wanted.every((name) => live.includes(name))) {
      await delay(150)
      // A session that exited while we waited is never going to report.
      if (!this.hosted.has(sessionId)) break
      live = connected()
    }
    return wanted.filter((name) => live.includes(name))
  }

  // --- Verifier gate (spec 002 US7) ---
  // An acceptance line's check runs in the session, so its outcome has to be read
  // back OUT of the session. The dispatch prompt demands one machine-readable
  // line; this watch scans the session's own assistant output for it. No line
  // means no result — the row stays unverified rather than passing (FR-047).
  private evalWatch = new Map<string, { evalId: string; kind: 'check' | 'judge' }>()

  /** Watch a session's next output for one acceptance line's reported result. */
  watchEvalMarker(sessionId: string, evalId: string, kind: 'check' | 'judge'): void {
    this.evalWatch.set(sessionId, { evalId, kind })
  }

  // Only assistant-authored kinds: the dispatch prompt itself names the sentinels,
  // so scanning a 'prompt' event would read the instruction as the answer.
  private static readonly EVAL_SCAN_KINDS = new Set<EventKind>(['assistant_text', 'summary', 'result'])

  /**
   * The turn ended without the reported result line, so the watch is dropped.
   *
   * Nothing is written, because nothing is known: the dispatch already reset the
   * row to 'not_run' (check) or cleared the verdict (judge), and that unverified
   * state is the honest outcome of a run that never reported (FR-047).
   *
   * Dropping it matters for the same reason the verify watch is closed here. One
   * watch per session, keyed by session id: left in place it outlives its turn,
   * so the next marker to arrive — from a completely unrelated later turn — was
   * attributed to this row and stamped a result onto an acceptance line nobody
   * had re-run. Every ended session also leaked its entry.
   */
  private closeUnreportedEval(entry: HostedEntry): void {
    this.evalWatch.delete(entry.row.id)
  }

  private scanEvalMarker(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.evalWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const marker = parseEvalMarker(text)
    if (!marker || marker.kind !== watch.kind) return
    this.evalWatch.delete(entry.row.id)
    this.repos.evals.update(
      watch.evalId,
      marker.kind === 'check' ? { checkStatus: marker.status } : { judge: marker.verdict },
    )
    this.callbacks.onEvalsChanged(entry.row.projectId)
  }

  // --- Verification runs (spec 002 US1-US4) ---
  // Same shape as the gate above: the run's figures exist only in the session's
  // output, so they are read back out of it. A run whose session finishes the
  // turn without reporting is INCONCLUSIVE with the reason kept — never a pass,
  // and never left spinning (FR-047).
  private verifyWatch = new Map<
    string,
    { runId: string; kind: 'suites' | 'evidence'; sawBrokenMarker?: boolean }
  >()

  /**
   * Watch a session for one run's report line.
   *
   * One watch per session, so a second run started before the first has reported
   * MUST close the first out rather than replace it. Without that, the next marker
   * to arrive was attributed to whichever run happened to be in the map: an
   * evidence report could be read as a suites report, finish a run that was still
   * going as "inconclusive", and consume the watch — so the real report arrived to
   * find nothing listening and was dropped. A run left permanently claiming it
   * proved nothing, when it had.
   *
   * Both buttons that reach here are clickable the moment a run finishes (Run
   * verification and Capture evidence), so this is a sequence a developer can
   * produce with two ordinary clicks, not a race that needs bad luck.
   */
  watchVerifyReport(sessionId: string, runId: string, kind: 'suites' | 'evidence'): void {
    const existing = this.verifyWatch.get(sessionId)
    if (existing && existing.runId !== runId) {
      const entry = this.hosted.get(sessionId)
      if (existing.kind === 'suites') {
        this.repos.verifyRuns.finish(
          existing.runId,
          'inconclusive',
          null,
          'Another verification pass was started before this one reported, so its result line was never read.',
        )
        if (entry) this.callbacks.onVerifyChanged(entry.row.projectId)
      }
    }
    this.verifyWatch.set(sessionId, { runId, kind })
  }

  private scanMarkers(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    this.scanEvalMarker(entry, kind, payload)
    this.scanVerifyReport(entry, kind, payload)
    this.scanApiRequests(entry, kind, payload)
  }

  // --- API eval sets ---
  // The session is asked for request DATA only, so this watch hands that data
  // straight to the runner: the calls, the statuses and the verdict all happen in
  // the app (api-runner.ts). Nothing the session says here decides pass or fail.
  private apiWatch = new Map<string, { runId: string }>()

  watchApiRequests(sessionId: string, runId: string): void {
    this.apiWatch.set(sessionId, { runId })
  }

  private scanApiRequests(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.apiWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const requests = parseApiRequests(text)
    if (!requests) return
    this.apiWatch.delete(entry.row.id)
    this.callbacks.onApiRequests(entry.row.projectId, watch.runId, requests)
  }

  /**
   * The turn ended without request data, so the run is handed an empty set: the
   * runner then records why nothing was called rather than leaving a row running.
   */
  private closeUnreportedApi(entry: HostedEntry): void {
    const watch = this.apiWatch.get(entry.row.id)
    if (!watch) return
    this.apiWatch.delete(entry.row.id)
    this.callbacks.onApiRequests(entry.row.projectId, watch.runId, [])
  }

  private scanVerifyReport(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.verifyWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const report = parseVerifyReport(text)
    if (!report) {
      // A report line arrived and could not be read. The watch stays open — the
      // turn may still produce a clean one, and closing here would throw away a
      // real report that was only a moment behind — but the fact is remembered,
      // so if the turn ends the developer is told the line was unreadable rather
      // than that the session never reported at all.
      if (verifyMarkerBroken(text)) watch.sawBrokenMarker = true
      return
    }
    this.verifyWatch.delete(entry.row.id)
    if (watch.kind === 'evidence') {
      this.repos.verifyRuns.attachEvidence(watch.runId, report.evidence)
    } else {
      const settled = this.settleAgainstArtefacts(watch.runId, entry.row.projectId, report)
      this.repos.verifyRuns.finish(watch.runId, verifyVerdict(settled.report), settled.report, settled.note)
    }
    this.callbacks.onVerifyChanged(entry.row.projectId)
  }

  /**
   * Check the session's report against the artefact files the run left on disk.
   *
   * A schema-constrained report line guarantees its shape and says nothing about
   * whether its values are true, and an agent working inside the tree it just
   * edited is exactly the position from which a claim can be made to look true.
   * So where a TRX, Cobertura or Stryker report exists, the file settles it: the
   * figure is replaced, marked verified, and any disagreement is recorded on the
   * run as a note rather than quietly resolved.
   *
   * No artefact changes nothing — the session's figures stand, unverified. This
   * never invents a figure, which is the same rule the rest of the section follows.
   */
  private settleAgainstArtefacts(
    runId: string,
    projectId: string,
    report: VerifyReport,
  ): { report: VerifyReport; note: string | null } {
    const project = this.repos.projects.byId(projectId)
    const run = this.repos.verifyRuns.byId(runId)
    if (!project || !run) return { report, note: null }
    let settled: ReturnType<typeof reconcile>
    try {
      settled = reconcile(report, scanArtefacts(project.path, Date.parse(run.startedAt)))
    } catch {
      // An unreadable tree is not evidence about the code. Report what the session
      // said, unverified, rather than failing the run over a filesystem error.
      return { report, note: null }
    }
    if (settled.disagreements.length === 0) return { report: settled.report, note: null }
    return {
      report: settled.report,
      note:
        'The run reported figures its own artefacts contradict, and the artefacts were taken: ' +
        settled.disagreements
          .map((d) => `${d.about} — reported ${d.said}, measured ${d.measured}`)
          .join('; '),
    }
  }

  /**
   * The turn ended. A run still being watched never got its report line, so it is
   * closed as inconclusive rather than left running — the session's own output
   * stays as the record of what happened.
   */
  private closeUnreportedVerify(entry: HostedEntry): void {
    const watch = this.verifyWatch.get(entry.row.id)
    if (!watch) return
    this.verifyWatch.delete(entry.row.id)
    if (watch.kind === 'suites') {
      this.repos.verifyRuns.finish(
        watch.runId,
        'inconclusive',
        null,
        watch.sawBrokenMarker
          ? 'The session reported a result line this app could not read as JSON — open its output to see what it sent.'
          : 'The session finished the turn without reporting a result line — open its output to see what ran.',
      )
    }
    this.callbacks.onVerifyChanged(entry.row.projectId)
  }

  /** Sink for the permission broker: markers and questions enter the stream here. */
  sinkFor(sessionId: string): EventSink {
    const entry = this.hosted.get(sessionId)
    if (!entry) throw { code: 'SESSION_ENDED', message: 'Session is no longer active' } satisfies IpcError
    return this.makeSink(entry)
  }

  attentionRaised(sessionId: string): void {
    this.hosted.get(sessionId)?.session.attentionRaised()
  }

  attentionCleared(sessionId: string): void {
    this.hosted.get(sessionId)?.session.attentionCleared()
  }

  private requireLive(sessionId: string): HostedEntry {
    const entry = this.hosted.get(sessionId)
    if (!entry) {
      const row = this.repos.sessions.byId(sessionId)
      if (!row) throw { code: 'NOT_FOUND', message: 'Session not found' } satisfies IpcError
      throw { code: 'SESSION_ENDED', message: 'Session has ended' } satisfies IpcError
    }
    return entry
  }

  private makeSink(entry: HostedEntry): EventSink {
    return {
      append: <K extends EventKind>(
        kind: K,
        payload: EventPayloadMap[K],
        options?: { persist?: boolean },
      ): SessionEvent<K> => {
        entry.seq += 1
        const event: SessionEvent = {
          id: newId(),
          sessionId: entry.row.id,
          seq: entry.seq,
          kind,
          payload,
          noiseKind: null,
          createdAt: nowIso(),
        }
        if (SWALLOWABLE_KINDS.includes(kind) && this.classifier) {
          event.noiseKind = this.classifier(event)
        }
        const persist = options?.persist !== false
        if (persist) this.repos.events.insert(event)
        if (UPDATABLE_KINDS.has(kind)) {
          entry.live.set(event.id, { event, persisted: persist })
          evictStaleLive(entry)
        }
        this.scanMarkers(entry, kind, payload)
        // Keep the transcript current as the conversation lands, so a crash leaves
        // a usable file behind. Only the kinds the transcript body carries: tool
        // chatter would cost writes without changing what a following session reads.
        if (persist && TRANSCRIBED_KINDS.has(kind)) this.scheduleTranscript(entry.row.id)
        this.callbacks.onEvent({ ...event })
        return event as SessionEvent<K>
      },
      update: <K extends EventKind>(
        eventId: string,
        payload: EventPayloadMap[K],
        options?: { persist?: boolean; kind?: K },
      ): void => {
        const liveEntry = entry.live.get(eventId)
        if (!liveEntry) return
        liveEntry.event.payload = payload
        if (options?.kind) liveEntry.event.kind = options.kind
        // A kind change can move an event out of the swallowable set (e.g. an
        // assistant_text upgraded to a summary): recompute while it can still
        // be noise, otherwise clear any tag its earlier kind was given so a
        // now-non-swallowable event is never hidden by a stale noiseKind.
        liveEntry.event.noiseKind =
          SWALLOWABLE_KINDS.includes(liveEntry.event.kind) && this.classifier
            ? this.classifier(liveEntry.event)
            : null
        if (liveEntry.persisted) {
          this.repos.events.setNoiseKind(eventId, liveEntry.event.noiseKind)
        }
        if (options?.persist) {
          if (liveEntry.persisted) {
            if (options.kind) {
              this.repos.events.updatePayload(eventId, payload, liveEntry.event.kind)
            } else {
              this.repos.events.updatePayload(eventId, payload)
            }
          } else {
            this.repos.events.insert(liveEntry.event)
            liveEntry.persisted = true
          }
        }
        this.scanMarkers(entry, liveEntry.event.kind, payload)
        this.callbacks.onEvent({ ...liveEntry.event })
      },
    }
  }

  private handleStatusChange(entry: HostedEntry, status: SessionStatus, detail?: string | null): void {
    // Nothing to say about a session this manager has already let go of. On
    // app quit, stop() waits EXIT_GRACE_MS and then gives up on a loop that has
    // not drained — a container that is slow to die will do that — so the loop
    // can report a status change after the database has been closed underneath
    // it. Every write below would throw, and worse, onCountersChanged schedules
    // a bare timer that reads the closed handle with nothing to catch it, which
    // takes the whole main process down. See the note in HostedSession.stop.
    if (!this.hosted.has(entry.row.id)) return
    // The turn is over ('needs_you' is a pending permission, not an ending): a
    // verification run that never reported is closed here rather than spinning.
    if (status === 'done' || status === 'error') {
      this.closeUnreportedVerify(entry)
      this.closeUnreportedApi(entry)
      this.closeUnreportedEval(entry)
    }
    entry.row.status = status
    entry.row.statusDetail = detail ?? null
    this.repos.sessions.update(entry.row.id, { status, statusDetail: detail ?? null })
    this.pushStatus(entry)
    this.callbacks.onCountersChanged()
    // After the watches above have settled, so "nothing outstanding" is true
    // rather than merely not yet written down.
    if (status === 'done') void this.endIfIdleBackground(entry)
  }

  /**
   * End a section's session once its work is finished.
   *
   * A background session is nobody's conversation: it is started FOR a verify
   * pass, an API run or a diagram, and the developer never opens it. It used to
   * stay alive for the rest of the day, which mattered more than tidiness once
   * every one of them took a container — two is the whole allowance
   * (MAX_CONTAINERS), so a project that ran one verify pass in the morning held
   * half the machine's capacity until the app closed, and the session that then
   * failed to start was some other project's.
   *
   * Only on 'done'. An errored session is left alone deliberately: its output is
   * the evidence for what went wrong, and closing it the instant it fails is how
   * a developer loses the thing they were about to look at.
   *
   * A watch still held means a run is mid-flight, and a queued task means work
   * is waiting, so neither is idle.
   */
  private async endIfIdleBackground(entry: HostedEntry): Promise<void> {
    if (!entry.background) return
    const id = entry.row.id
    if (this.verifyWatch.has(id) || this.apiWatch.has(id) || this.evalWatch.has(id)) return
    if (this.repos.taskQueue.listForProject(entry.row.projectId).length > 0) return
    // Re-checked after the await inside stopSession's own path: a section can
    // dispatch again between the turn ending and this running.
    if (!this.hosted.has(id)) return
    await this.stopSession(id)
  }

  /** Read the git branch asynchronously; push only when it actually changed. */
  private async refreshBranch(entry: HostedEntry): Promise<void> {
    const branch = await readGitBranch(entry.projectPath)
    if (branch === entry.row.branch) return
    entry.row.branch = branch
    this.repos.sessions.update(entry.row.id, { branch })
    this.pushStatus(entry)
  }

  private observeBranch(entry: HostedEntry): void {
    // Both git reads are async so a completed turn never blocks the main loop.
    void this.refreshBranch(entry)
    void readNumstat(entry.projectPath).then(({ totals }) => {
      const adds = totals?.adds ?? null
      const dels = totals?.dels ?? null
      if (adds === entry.row.diffAdds && dels === entry.row.diffDels) return
      entry.row.diffAdds = adds
      entry.row.diffDels = dels
      this.repos.sessions.update(entry.row.id, { diffAdds: adds, diffDels: dels })
      this.pushStatus(entry)
    })
    this.callbacks.onCountersChanged()
  }

  private handleExit(entry: HostedEntry, reason: 'completed' | 'stopped' | 'crashed', detail?: string): void {
    // Same guard, same reason as handleStatusChange: a loop that outlived the
    // app-quit grace period must not write to a closed database. Safe on the
    // normal path because this method is what removes the entry, below.
    if (!this.hosted.has(entry.row.id)) return
    this.closeUnreportedVerify(entry)
    this.closeUnreportedApi(entry)
    this.closeUnreportedEval(entry)
    if (reason === 'crashed') {
      entry.row.status = 'error'
      entry.row.statusDetail = detail ?? 'Session process ended unexpectedly'
    }
    this.finaliseRow(entry, reason)
    this.hosted.delete(entry.row.id)
    this.callbacks.onSessionExit(entry.row.id)
    this.callbacks.onCountersChanged()
  }

  /**
   * Write one session's transcript to the temp directory now.
   *
   * Reads what is already persisted rather than keeping a second live log, so the
   * file can never disagree with the database. A session longer than the event cap
   * is transcribed from its most recent activity.
   */
  saveTranscript(sessionId: string): TranscriptSummary {
    const row = this.hosted.get(sessionId)?.row ?? this.repos.sessions.byId(sessionId)
    if (!row) throw { code: 'NOT_FOUND', message: 'Session not found' } satisfies IpcError
    const project = this.repos.projects.byId(row.projectId)
    const events = this.repos.events.page(sessionId, undefined, TRANSCRIPT_EVENT_CAP)
    return writeTranscript(row, project?.name ?? row.projectId, events)
  }

  listTranscripts(): TranscriptSummary[] {
    return listTranscripts()
  }

  /**
   * Rewrite the transcript a beat after activity settles.
   *
   * A crash cannot announce itself, so the only way to have a file when one
   * happens is to keep one current. Debounced because a single turn produces many
   * events and they would otherwise cost a write each; failures are swallowed
   * because a convenience copy must never take a session down with it.
   */
  private scheduleTranscript(sessionId: string): void {
    const pending = this.transcriptTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.transcriptTimers.delete(sessionId)
      try {
        this.saveTranscript(sessionId)
      } catch {
        // Disk full, temp directory gone, session already pruned: none of these
        // are worth interrupting the run for.
      }
    }, TRANSCRIPT_DEBOUNCE_MS)
    timer.unref?.()
    this.transcriptTimers.set(sessionId, timer)
  }

  private flushTranscript(sessionId: string): void {
    const pending = this.transcriptTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    this.transcriptTimers.delete(sessionId)
    try {
      this.saveTranscript(sessionId)
    } catch {
      // Same reasoning as the debounced path: never fail an ending session.
    }
  }

  private finaliseRow(entry: HostedEntry, reason: Session['endReason']): void {
    // A session ends once. Both callers can reach this for the same entry —
    // endAllForAppExit finalises what stop() left open, and the run loop's own
    // onExit lands afterwards — and on the app-exit path that second write would
    // hit a closed database. Guarding here rather than at each call site because
    // this is the only place the row is written.
    if (entry.row.endedAt) return
    entry.row.endedAt = nowIso()
    entry.row.endReason = reason
    this.repos.sessions.update(entry.row.id, {
      status: entry.row.status,
      statusDetail: entry.row.statusDetail,
      endedAt: entry.row.endedAt,
      endReason: reason,
    })
    // The last write of the transcript, with the row's end time in it, so the file
    // a following session reads says when this one finished.
    this.flushTranscript(entry.row.id)
    this.pushStatus(entry)
  }

  private pushStatus(entry: HostedEntry): void {
    this.callbacks.onSessionStatus({ ...entry.row })
  }

  /**
   * Refuse a container when the machine already holds its share of them.
   *
   * A refusal rather than a queue, deliberately. A queue would hold a background
   * verify dispatch open for however long the sessions ahead of it run, with
   * nothing on screen to say why and no point at which the developer could
   * decide it was not worth waiting for. Naming the limit and the two sessions
   * already holding it gives them the choice a silent wait takes away.
   */
  private refuseWhenContainersFull(): void {
    const running = [...this.hosted.values()].filter((e) => e.containerised && !e.row.endedAt)
    if (running.length < MAX_CONTAINERS) return
    throw {
      code: 'SANDBOX_FULL',
      message:
        `${running.length} sessions already run in a container, which is the limit: they share one ` +
        'virtual machine, and one more can exhaust it and kill a session that did nothing wrong. ' +
        'End one of them, then start this again.',
    } satisfies IpcError
  }

  /**
   * The row was inserted, but the HostedSession that would run it never came to
   * exist — there is no HostedEntry yet, so finaliseRow (which reads one) does
   * not apply. Mark it ended the same way a crash would, directly on the row,
   * so the row this call already persisted never sits with endedAt null and no
   * registered entry (see startSession's guard around `new HostedSession`).
   */
  private failStart(row: Session, detail: string): void {
    row.status = 'error'
    row.statusDetail = detail
    row.endedAt = nowIso()
    row.endReason = 'crashed'
    this.repos.sessions.update(row.id, {
      status: row.status,
      statusDetail: row.statusDetail,
      endedAt: row.endedAt,
      endReason: row.endReason,
    })
    this.callbacks.onSessionStatus({ ...row })
  }

}
