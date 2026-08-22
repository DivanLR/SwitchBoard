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
  Project,
  ProjectCommand,
  QueuedTask,
  SectionKind,
  Session,
  SessionEvent,
  SessionMode,
  SessionStatus,
  SuiteResult,
  TranscriptSummary,
  VerifyReport,
} from '@shared/domain'
import { SWALLOWABLE_KINDS, emptyVerifyReport, verifyVerdict } from '@shared/domain'
import type { IpcError, SessionStatusPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import { readComboDoc, readSchemaDoc } from '@main/mcp/schema-doc'
import { HostedSession, type PermissionGate } from './session'
import { probeAvailableModels } from './model-catalog'
import { foldModelTotals, type EventSink } from './message-mapper'
import {
  heavySubagentSystemPromptAppend,
  heavySubagentModelMode,
  modesSystemPromptAppend,
  sandboxSystemPromptAppend,
} from './session-shaping'
import {
  TRANSCRIPT_EVENT_CAP,
  listTranscripts,
  transcriptContextAppend,
  transcriptFor,
  writeTranscript,
} from './transcript'
import { parseEvalMarker } from '@main/evals/eval-dispatch'
import {
  parseSuiteProgress,
  parseVerifyReport,
  verifyMarkerBroken,
  verifyPrompt,
  type PlannedSuite,
} from '@main/evals/verify-dispatch'
import { parseDiagramPlan } from '@shared/diagram'
import { reconcile } from '@main/evals/artefacts'
import { scanArtefacts } from '@main/evals/artefact-scan'
import { parseApiRequests } from '@main/evals/api-dispatch'
import type { ApiRequestPlan } from '@shared/api-endpoints'
import type { SandboxEnv, TestSuite } from '@shared/test-catalog'
import { mainLoopModel } from './model-routing'
import { resolveClaudeExecutable } from './claude-executable'
import {
  ensureSandboxImage,
  ensureSandboxVolumes,
  gitNotice,
  gitRoot,
  hasNodeModulesVolume,
  refMounts,
  removeNodeModulesVolume,
  sandboxVolumeNames,
  sweepOrphanedContainers,
  sweepStaleVolumes,
} from './wslc-sandbox'

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
   * Fired when the session drawing a diagram finishes a turn, so the section
   * shows the file the moment it exists rather than on the next poll.
   *
   * A turn that ended is a file that exists: the app does not write the diagram,
   * the session does, but the app knows exactly when that session stopped
   * working. Only the diagram session's turns fire this — a verify pass
   * completing says nothing about a drawing.
   */
  onDiagramsChanged: (projectId: string) => void
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
  /** Which section opened it, when a section did. The reuse key for
   *  backgroundSessionFor, and what names the row in the sidebar. */
  sectionKind?: SectionKind
  /** Whether a turn has ever completed here. A new session reads as idle before
   *  the section that asked for it has sent anything. */
  ranATurn: boolean
  /**
   * Set only on an isolated-verify suite session, to the RUN's id rather than
   * this session's own — see sandboxSpawn's `nodeModulesVolumeKey`. Its
   * presence is also what tells finaliseRow NOT to remove the node_modules
   * volume when this one session ends: that volume is shared with the run's
   * other suites, still to come, and runSuitesIsolated removes it itself once
   * the whole run is over. Undefined for every ordinary session, which is what
   * keeps their own end-of-life cleanup exactly as it was.
   */
  nodeModulesVolumeKey?: string
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

/**
 * Section kinds where every dispatch takes a session of its own, with no reuse.
 *
 * A drawing was the first: two diagrams sharing one session means the second
 * queues behind the first, which is the blocking the per-kind split exists to
 * remove, moved one place along.
 *
 * Spec Kit joined it on the developer's direction on 2026-08-22, for the same
 * reason and a sharper case. Its commands are the longest-running work in the
 * app — /speckit-specify writes a spec folder over several minutes, and
 * /speckit-implement can run for an hour — and they are dispatched from a panel
 * that offers all of them at once. Sharing one `spec` session meant a plan sent
 * while a specify was still writing waited for it with nothing on screen saying
 * so. Each command now answers in its own session and closes itself when its
 * turn ends (endIfIdleBackground), so the cost is a row per command rather than
 * a queue behind one.
 *
 * The other kinds keep reuse deliberately: a diff comment, a cleanup command
 * and a test run are each short or already serialised by their own section.
 */
const NEVER_REUSED: ReadonlySet<SectionKind> = new Set(['diagram', 'spec'])

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

/**
 * A thrown value's message, tolerant of the two shapes this file's own errors
 * take: a real `Error` (`.message`) and the plain `{ code, message } satisfies
 * IpcError` objects thrown all over this class (startSession's "Project not
 * found", "Sandbox full", …). `String(error)` on the latter gives the useless
 * "[object Object]" — exactly the kind of unhelpful, non-null-but-meaningless
 * detail this file's own HONESTY rule (verify-dispatch.ts) exists to forbid a
 * SESSION from writing; runOneIsolatedSuite would otherwise commit the same
 * sin on the app's own behalf when a suite's session fails to start.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export class SessionManager {
  private hosted = new Map<string, HostedEntry>()
  /* The starting-reservation guard is gone; a project is no longer capped at
     one session (see startSession's doc). */
  /**
   * A DIFFERENT reservation from the one the comment above retired: this one
   * guards MAX_CONTAINERS, not "one session per project", and is very much
   * still needed. Session ids that have passed refuseWhenContainersFull's
   * synchronous check but have not yet reached `hosted.set` — closing the gap
   * between that check and ensureSandboxImage's image build, which can take
   * MINUTES on a first run. Without this, two containerised starts landing in
   * that window both pass the same synchronous count and together
   * oversubscribe MAX_CONTAINERS, which is the exact crash the cap exists to
   * prevent. Counted alongside `hosted` in refuseWhenContainersFull; always
   * released in startSession's `finally`, on every exit path, because a leaked
   * entry here ratchets the count up forever and refuses starts that should
   * succeed.
   */
  private reservedContainerIds = new Set<string>()
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
    // Read BEFORE reconcileAllEnded, which is what makes this list non-empty:
    // these are the sessions the previous run left open, and therefore exactly
    // the containers that may have outlived it. sweepOrphanedContainers needs
    // them because wslc is not asked to discover containers by name any more
    // (see that function).
    const leftOpen = this.repos.sessions.listUnended().map((s) => s.id)
    // The note matters more here than anywhere else: every row this closes was a
    // session that was still ALIVE when the last run of the application ended
    // without closing it, and there are more of those than of any other kind.
    this.repos.sessions.reconcileAllEnded(
      'app_exit',
      'Switchboard stopped without closing this session, so it was closed on the next launch. The conversation can be resumed.',
    )
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
    // Sessions are not only DB rows now: a containerised session owns a container
    // that outlives a hard kill, so reconciling the rows without reaping those
    // would leave an autonomous agent running against the project folder.
    sweepOrphanedContainers(leftOpen)
    // The container-per-session volumes accumulate credentials and disk (see
    // HOME_VOLUME_PREFIX in wslc-sandbox.ts). This bounds both, ageing a volume
    // out 7 days after ITS session ended (never a live one). Age comes from this
    // table, which is why the sweep lives here and not in wslc-sandbox.ts alone:
    // the runtime's own volume metadata has no timestamp that answers "when did
    // the session that owns this end".
    sweepStaleVolumes((id) => this.repos.sessions.byId(id))
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
   * The model routing a session should use RIGHT NOW: the INTELLIGENT model
   * (plans, questions, orchestrator loops, the advisor) and the WORKER model
   * (advisor-mode executor + orchestrator workers), both from the global Models
   * tab.
   *
   * Takes no project, and that is the whole point: each of these used to accept a
   * "This project" override, and the owner removed that scope on 2026-08-21. The
   * signature says so, so a future caller cannot pass a project id and quietly
   * expect it to matter.
   *
   * Read at session start AND again before every turn (see HostedSession's
   * resolveModels), so changing a model in Settings reaches a running session on
   * its next turn instead of only the next session.
   */
  private resolveModelRouting(): {
    intelligentModel: string
    workerModel: string
    modelMode: ModelMode
    autoModelRouting: boolean
  } {
    // ONE answer for every project. There used to be a per-project override for
    // each of these two, and the owner asked for the scope to be global only on
    // 2026-08-21: a model choice that differed per project meant the Models tab
    // could say one thing while a session ran on another, and the only way to
    // find out which was to open a second tab and check.
    const settings = this.repos.settings.get()
    return {
      intelligentModel: settings.intelligentModel,
      workerModel: settings.workerModel,
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
   *
   * The count alone is not enough, though: it is read here synchronously and
   * ensureSandboxImage (awaited by startSessionBody, below) can take MINUTES on
   * a first build, and two containerised starts landing in that gap both saw
   * the same pre-build count and both passed. reservedContainerIds (see its own
   * comment) closes that window; the try/finally here is what makes releasing
   * it on every exit — including the two throws startSessionBody can raise
   * before a row is even hosted — structural rather than a rule to remember.
   */
  async startSession(
    projectId: string,
    resume = false,
    /** Omitted means "use the project's own defaultSessionMode", the normal path. */
    requestedMode?: SessionMode,
    carryTranscriptFrom?: string,
    /** Run in a container while keeping the mode's own permission behaviour. The
     *  sections ask for this; nothing else does. `background` marks a session
     *  started FOR a section rather than by the developer. `nodeModulesVolumeKey`
     *  is the isolated-verify path's own override — see sandboxSpawn and
     *  HostedEntry's field of the same name; every other caller omits it and
     *  gets today's per-session volume, unchanged. */
    opts?: { containerised?: boolean; background?: boolean; nodeModulesVolumeKey?: string },
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
    if (containerised) this.refuseWhenContainersFull()
    // Reserved the INSTANT the check above passes — before startSessionBody ever
    // reaches ensureSandboxImage's image build, the slow step whose gap this
    // closes (see reservedContainerIds and this method's own doc). Generated
    // here rather than inside startSessionBody so the reservation and the row
    // that session eventually gets share the one id.
    const sessionId = newId()
    if (containerised) this.reservedContainerIds.add(sessionId)
    try {
      return await this.startSessionBody(
        sessionId,
        project,
        mode,
        bypassPermissions,
        containerised,
        resume,
        carryTranscriptFrom,
        opts,
      )
    } finally {
      // Runs on every exit from startSessionBody — its own throws (Docker down,
      // Claude Code missing, the guarded HostedSession construction failing
      // below) and its successful return alike — which is what makes "always
      // released" a property of the code rather than a rule someone has to
      // remember to uphold at each new exit path.
      if (containerised) this.reservedContainerIds.delete(sessionId)
    }
  }

  /**
   * Everything startSession does once the reservation above is in place. Split
   * out only so that reservation's try/finally does not have to wrap this
   * entire body at one extra indent level — the cut is not a meaningful
   * boundary on its own, and nothing here is safe to call outside that guard.
   */
  private async startSessionBody(
    sessionId: string,
    project: Project,
    mode: SessionMode,
    bypassPermissions: boolean,
    containerised: boolean,
    resume: boolean,
    carryTranscriptFrom: string | undefined,
    opts: { containerised?: boolean; background?: boolean; nodeModulesVolumeKey?: string } | undefined,
  ): Promise<Session> {
    const projectId = project.id
    // No "already active" refusal (see startSession's doc). `resume` still means
    // "the last session that ended here", not "the only one".
    // A containerised session needs the image (wslc-sandbox): fail here, before a
    // row exists, when wslc is missing or the host is not logged in. First call
    // builds the image for this project's stack, which can take minutes (tens of
    // them for the .NET one), and the renderer awaits with its busy state.
    // The readiness failure gets the half of the answer only this caller knows:
    // WHY a container was wanted. `ensureSandboxImage` reports that wslc is
    // missing and how to install it, which is one of two ways out and not always
    // the one the developer wants. A container asked for by the project's own
    // switch can simply be turned off; a container forced by bypass cannot,
    // because bypass approves every tool call and the container is the only
    // boundary left. Saying which case this is turns a dead end into a choice.
    if (containerised) {
      try {
        await ensureSandboxImage(project.path)
      } catch (error) {
        const escape = bypassPermissions
          ? 'Bypass always runs in a container, so this cannot be turned off for a bypass session; start it in another mode to run on this machine.'
          : `This is on because ${project.name} has its WSL box ticked in the project header. Untick it to run on this machine instead.`
        throw new Error(`${(error as Error).message} ${escape}`, { cause: error })
      }
    }
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

    // The named volumes this session is about to mount, created before anything
    // tries to mount them. Docker created a named volume implicitly on first use;
    // wslc is not documented to, and a spawn that finds out otherwise fails with
    // a mount error nobody can act on. HERE rather than beside ensureSandboxImage
    // above, because the home volume's name depends on `resumeFromSessionId`,
    // which is only resolved on the lines directly above this.
    if (containerised) {
      await ensureSandboxVolumes(
        sandboxVolumeNames({
          projectPath: project.path,
          sessionId,
          resumeFromSessionId,
          nodeModulesVolumeKey: opts?.nodeModulesVolumeKey,
        }),
      )
    }

    const row: Session = {
      // Reused from the reservation in startSession, not a fresh id: the
      // reservedContainerIds entry and this row's id must be the SAME value or
      // the reservation would be tracking a session this row never becomes.
      id: sessionId,
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
      ranATurn: false,
      session: null as unknown as HostedSession,
      nodeModulesVolumeKey: opts?.nodeModulesVolumeKey,
    }

    const settings = this.repos.settings.get()
    const { intelligentModel, workerModel } = this.resolveModelRouting()
    // Any project that has previously run an MCP scan gets its schema map
    // injected as context on every session start (no-op when never scanned).
    // Scans are per-combination now: prefer the ACTIVE combination's doc and
    // fall back to the legacy single db-schema.md from before the split.
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
        resolveModels: () => this.resolveModelRouting(),
        // Pairing mode per work turn — in-memory only, shown as a header chip.
        onTurnMode: (mode) => {
          if (entry.row.currentMode === mode) return
          entry.row.currentMode = mode
          this.pushStatus(entry)
        },
        mode,
        containerised,
        // Isolated-verify suites only (see HostedEntry's field of the same
        // name); every other caller leaves this undefined and sandboxSpawn
        // defaults it to the session id, exactly as before.
        nodeModulesVolumeKey: opts?.nodeModulesVolumeKey,
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
          // A container has its OWN empty ~/.claude, so it reports a list with
          // none of the developer's plugins in it. Letting that list win erased
          // the real one: installing diagram-design put the card away, and the
          // first diagram — drawn in a container — brought it straight back.
          if (containerised) return
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
          entry.ranATurn = true
          this.observeBranch(entry)
          // A completed turn that left the session idle pulls the next planned task.
          this.maybeDrainQueue(entry.row.projectId)
          // The turn that ends a drawing is the turn that wrote it — or the turn
          // that failed to, which the section equally needs to stop waiting on.
          // Either way the watch is spent, and releasing it here is what lets
          // endIfIdleBackground close the session afterwards.
          if (this.diagramWatch.delete(row.id)) {
            this.callbacks.onDiagramsChanged(projectId)
          }
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
   * The session a section's work should talk to: that project's session for THAT
   * KIND of work, started if it is not already alive.
   *
   * Dispatches used to resolve their target with `sessions.activeForProject` -
   * whichever session is open, ordinarily the one the developer is chatting in.
   * A verification pass is a long turn (runs suites, reads artefacts, writes a
   * report), and queuing it into the chat session blocked the conversation and
   * interleaved build output with the developer's own work.
   *
   * Then every section shared ONE background session instead, which moved the
   * blocking rather than removing it: a cleanup command queued behind a spec's
   * implement phase, and a diff comment landed in the middle of a test report.
   * Diagrams were split out first, one section at a time; `kind` is that split
   * generalised, at the developer's direction on 2026-08-19 - specs, tests, diff
   * comments, cleanup and diagrams each get their own and none waits on another.
   *
   * Reuse is keyed off the live entries this manager already holds, not off a
   * run row: the kinds that leave no run row behind (a spec action, a diff
   * comment, a cleanup command) had nothing to key on, and a second registry
   * that outlived the sessions it named could only disagree with them.
   *
   * Deliberately never falls back to `activeForProject`: that IS the removed
   * behaviour, and a fallback would restore the bug on the first run after a
   * section's session ends.
   */
  async backgroundSessionFor(projectId: string, kind: SectionKind): Promise<Session> {
    // Two kinds never reuse, and the rule lives here rather than in each caller
    // because every route to them comes through this method; split across two
    // places it would drift and one route would quietly queue.
    if (!NEVER_REUSED.has(kind)) {
      for (const entry of this.hosted.values()) {
        if (entry.row.projectId !== projectId) continue
        if (entry.sectionKind !== kind || entry.row.endedAt) continue
        return { ...entry.row }
      }
    }
    return this.startBackground(projectId, kind)
  }

  /**
   * A drawing gets a session of its own. Every time, with no reuse.
   *
   * Separate from the other sections so a drawing never waits behind a
   * verification pass, and - the developer's explicit direction on 2026-08-17 -
   * separate from the PREVIOUS drawing too. Reusing a live drawing session was
   * the obvious economy and it is not what was asked for: two diagrams sharing
   * one session means the second queues behind the first, which is the same
   * blocking this separation exists to remove, just moved one place along.
   *
   * The costs are real and neither is hidden. A CONTAINERISED drawing holds one
   * of MAX_CONTAINERS, which is 2 for the whole machine because they share one
   * virtual machine, so two drawings at once consume it entirely and the next
   * containerised dispatch anywhere is refused with SANDBOX_FULL until one ends.
   * That ceiling is why the project's own Docker switch (Project.useContainers)
   * defaults off: five section kinds cannot all hold one of two slots. What makes
   * a containerised drawing affordable at all is diagramWatch - the session
   * closes itself on the turn that finishes the drawing, so a slot is held for
   * the length of one drawing rather than for the rest of the day.
   */
  async diagramSessionFor(projectId: string): Promise<Session> {
    return this.backgroundSessionFor(projectId, 'diagram')
  }

  /**
   * Start a section's own session.
   *
   * Containerised only when the project asks for it. It used to be unconditional,
   * on the reasoning that a section runs builds, test suites and cleanup passes
   * and those should not be able to touch the developer's checkout - still true,
   * and still what ticking the box gives. What made it a choice is the ceiling
   * above it: MAX_CONTAINERS is 2 and there are five section kinds, so forcing a
   * container turned "each kind gets its own session" into SANDBOX_FULL on the
   * third dispatch. The developer decides which of the two they want, per project.
   * A bypass project still gets a container regardless - startSession forces it.
   */
  private async startBackground(projectId: string, kind: SectionKind): Promise<Session> {
    const containerised = this.repos.projects.byId(projectId)?.useContainers === true
    const session = await this.startSession(projectId, false, undefined, undefined, {
      containerised,
      background: true,
    })
    const entry = this.hosted.get(session.id)
    if (entry) entry.sectionKind = kind
    return session
  }

  /** What each live section session was opened for, for the sidebar's row names.
   *  Live entries only: an ended session's kind is not a fact anyone can act on. */
  sectionKinds(projectId: string): Record<string, SectionKind> {
    const kinds: Record<string, SectionKind> = {}
    for (const entry of this.hosted.values()) {
      if (entry.row.projectId === projectId && entry.sectionKind) {
        kinds[entry.row.id] = entry.sectionKind
      }
    }
    return kinds
  }

  /**
   * Name a session, in the developer's own words.
   *
   * Written to the row AND to the live entry: the project list reads live
   * sessions from `hosted` and only an ended one from the database, so a rename
   * that touched only the column would not show until the session ended.
   * Trimmed to nothing clears it, which is how a developer undoes a name without
   * needing a second control for it.
   */
  renameSession(sessionId: string, label: string): void {
    const trimmed = label.trim()
    const value = trimmed === '' ? null : trimmed.slice(0, 60)
    if (!this.repos.sessions.byId(sessionId)) {
      throw { code: 'NOT_FOUND', message: 'Session not found' } satisfies IpcError
    }
    this.repos.sessions.update(sessionId, { label: value })
    const entry = this.hosted.get(sessionId)
    if (entry) {
      entry.row.label = value
      this.pushStatus(entry)
    }
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
    // The isolated path (runSuitesIsolated) never puts a session on the row
    // itself — a fresh one starts per suite — so the ordinary run.sessionId
    // branch below has nothing to interrupt for it. isolatedRuns is the only
    // record of which session is currently live, and `cancelled` is what stops
    // the QUEUE: runSuitesIsolated's loop checks it before every suite, so a
    // cancel here reaches suites that have not even started yet, not only the
    // one in flight.
    const isolated = this.isolatedRuns.get(runId)
    if (isolated) {
      isolated.cancelled = true
      if (isolated.sessionId) await this.interruptSession(isolated.sessionId).catch(() => {})
    } else {
      if (run.sessionId) await this.interruptSession(run.sessionId).catch(() => {})
      this.verifyWatch.delete(run.sessionId ?? '')
    }
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

  /**
   * End a session, recording WHY it ended.
   *
   * `note` is the whole point of this signature. Every deliberate end used to
   * write `endReason: 'stopped'` and leave `statusDetail` at whatever the row
   * happened to hold, which for a settled session is null. The row then simply
   * stopped existing, and the developer's own report of the symptom was that
   * "sessions just close with no message" — which was exactly true, for three
   * different reasons that were indistinguishable afterwards: an End they
   * pressed, a stray click on a row's own close control, and a section session
   * closing itself the moment its work finished (endIfIdleBackground).
   *
   * Written BEFORE `stop()`, because finaliseRow persists `entry.row.statusDetail`
   * as it finds it, and stop() is what leads there. Optional rather than
   * required only so an existing caller cannot be silently wrong; every caller
   * in this repository passes one.
   */
  async stopSession(sessionId: string, note?: string): Promise<void> {
    const entry = this.requireLive(sessionId)
    if (note) entry.row.statusDetail = note
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
      // Says so on the row, for the same reason stopSession takes a note: on the
      // next launch these are simply gone, and "gone" and "gone because you quit"
      // look identical without this. Only when nothing better is already there —
      // a session that crashed on the way out keeps its own diagnosis.
      entry.row.statusDetail ??= 'Switchboard closed, so this session ended. Its conversation can be resumed.'
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
    this.scanIsolatedSuiteReport(entry, kind, payload)
    this.scanApiRequests(entry, kind, payload)
    this.scanDiagramPlan(entry, kind, payload)
  }

  /**
   * The plan a drawing session states before it draws: type, pattern, size, and
   * whatever the complexity budget forced out.
   *
   * Attached to the project's NEWEST diagram request rather than to a watch,
   * because unlike a verify run there is no id to carry: the request row is written
   * immediately before the session is asked, and a project draws one diagram at a
   * time in the session they share. A plan arriving with no request behind it
   * updates nothing, which is the right answer for a session that echoed the
   * sentinel without having been asked for a diagram.
   */
  private scanDiagramPlan(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    if (!SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const plan = parseDiagramPlan(text)
    if (!plan) return
    const file = this.repos.diagramRequests.latestFileFor(entry.row.projectId)
    if (!file) return
    this.repos.diagramRequests.notePlan(entry.row.projectId, file, plan)
  }

  // --- API eval sets ---
  // The session is asked for request DATA only, so this watch hands that data
  // straight to the runner: the calls, the statuses and the verdict all happen in
  // the app (api-runner.ts). Nothing the session says here decides pass or fail.
  private apiWatch = new Map<string, { runId: string }>()

  watchApiRequests(sessionId: string, runId: string): void {
    this.apiWatch.set(sessionId, { runId })
  }

  // --- Diagrams ---
  /**
   * A drawing in flight, so nothing closes the session out from under it.
   *
   * This exists because three real diagram requests died four to six seconds
   * after being asked for, with the session still reading 'working'. The cause
   * was not the model: endIfIdleBackground closes a background session the moment
   * it looks idle, and "idle" was defined as no verify watch, no API watch, no
   * eval watch and an empty task queue. A diagram registered none of those, so a
   * 'done' still in flight from the session's PREVIOUS turn was enough to have it
   * stopped while it was drawing. The drawing was the one kind of section work
   * with nothing standing up for it.
   *
   * Keyed by session like the three watches above, and cleared on the turn that
   * finishes the drawing — which is also exactly when the file exists and the
   * section should be told (see onTurnComplete).
   */
  private diagramWatch = new Map<string, { file: string | null }>()

  /**
   * `file` is optional because the two callers know different amounts. The
   * Generate button names the file it already chose; a plugin command typed in
   * the Commands row (/diagram-design:export-diagram) does not, since the skill
   * decides that itself. Neither needs it to work — the watch's whole job is to
   * mark that a drawing is in flight in this session — so the name is recorded
   * for legibility rather than read.
   */
  watchDiagram(sessionId: string, file?: string): void {
    this.diagramWatch.set(sessionId, { file: file ?? null })
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
    // Progress first, and it never closes the watch: a suite announcing itself is
    // not the run reporting. Checked before the report parse so a turn that emits
    // both in one chunk still records the suite.
    const progress = parseSuiteProgress(text)
    if (progress && watch.kind !== 'evidence') {
      this.repos.verifyRuns.noteSuite(watch.runId, progress)
      this.callbacks.onVerifyChanged(entry.row.projectId)
    }
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

  // --- Isolated verify suites (opt-in: one fresh container per suite, run
  // sequentially — see runSuitesIsolated) ---
  //
  // This is deliberately its own tiny map rather than a third `kind` on
  // verifyWatch above. verifyWatch's report handler FINISHES THE WHOLE RUN the
  // moment a report lands (see scanVerifyReport / watchVerifyReport's own
  // comment on why one watch per session is the rule) — exactly wrong for an
  // isolated suite, where a report is one suite of several still to come, and
  // the run closes once, at the very end, in runSuitesIsolated itself.
  // Reusing parseVerifyReport (not a second parser) because the prompt each
  // isolated session gets IS an ordinary verifyPrompt over a one-entry plan, so
  // its answer is an ordinary VerifyReport whose `suites` array happens to
  // have one element.
  private isolatedSuiteWatch = new Map<string, { suite: TestSuite; settle: (result: SuiteResult) => void }>()

  private scanIsolatedSuiteReport(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.isolatedSuiteWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const report = parseVerifyReport(text)
    // A single-entry plan means at most one suite can legitimately appear.
    // Nothing here (a broken marker, or none yet) is left to the turn-end /
    // deadline path in waitForIsolatedSuite to settle instead — the same
    // "never left waiting forever" guarantee verifyWatch gives the shared path.
    const result = report?.suites[0]
    if (!result) return
    watch.settle(result)
  }

  /**
   * The turn ended (or the session died) with no report for the suite this
   * session was asked to run. Mirrors closeUnreportedVerify's job for the
   * isolated path: `not_run` names what proved nothing, never a pass and never
   * silently dropped from the run's report.
   */
  private closeUnreportedIsolatedSuite(entry: HostedEntry): void {
    const watch = this.isolatedSuiteWatch.get(entry.row.id)
    if (!watch) return
    watch.settle({
      id: watch.suite.id,
      label: watch.suite.label,
      status: 'not_run',
      detail: 'The session ended before this suite reported a result — open its output to see what ran.',
    })
  }

  /**
   * Wait for one isolated suite's outcome: its report arriving (settled by
   * scanIsolatedSuiteReport), its turn ending or its session dying without one
   * (closeUnreportedIsolatedSuite, called from handleStatusChange/handleExit),
   * or this deadline — RUN_DEADLINE_MS, the same ceiling the shared-container
   * watchdog uses, because a suite that never finishes needs the same "give up
   * eventually" rule a whole run does, not a fresh guess.
   *
   * `settle` is idempotent and always clears the watch entry, so whichever of
   * the three paths gets there first wins and the other two become no-ops —
   * there is exactly one outcome per suite, however it arrives.
   */
  private waitForIsolatedSuite(sessionId: string, suite: TestSuite): Promise<SuiteResult> {
    return new Promise<SuiteResult>((resolve) => {
      let settled = false
      const settle = (result: SuiteResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.isolatedSuiteWatch.delete(sessionId)
        resolve(result)
      }
      const timer = setTimeout(() => {
        settle({
          id: suite.id,
          label: suite.label,
          status: 'not_run',
          detail:
            'This suite went quiet for long enough that its session is presumed dead, so nothing it measured is known.',
        })
      }, RUN_DEADLINE_MS)
      timer.unref?.()
      this.isolatedSuiteWatch.set(sessionId, { suite, settle })
    })
  }

  /**
   * In-flight isolated verify runs, keyed by run id, so cancelVerifyRun can
   * reach one. Unlike the shared-container path, an isolated run's row never
   * names one session (VerifyRun.sessionId) — a fresh session starts per
   * suite — so this is the only record of which session is currently live.
   * `cancelled` is checked before every suite in runSuitesIsolated's loop, so
   * a cancel stops the QUEUE, not just whatever is running right now.
   */
  private isolatedRuns = new Map<string, { cancelled: boolean; sessionId: string | null }>()

  /**
   * The opt-in alternative to the shared-container verify run (see this
   * feature's contract in the task that added it): each RUNNABLE suite in
   * `plan` gets its OWN fresh containerised session, run one at a time, its
   * container gone before the next suite's begins. The reason is memory
   * isolation — suites sharing one container and one memory ceiling had a
   * heavy suite killing that container out from under the others (exit 137,
   * no stderr) — and sequential-with-a-fresh-container-each is the fix.
   *
   * Suites carrying `.unavailable` are skipped outright: they were never going
   * to run, and whatever built this plan (planSuites) already reports them as
   * skipped through the normal channel — recording them again here would be a
   * second, redundant report of the same fact.
   *
   * Resolves once every suite has settled and the run has been closed with ONE
   * `finish()` call — never per suite — matching the existing shared-container
   * contract that a run closes once (repos.verifyRuns.finish) no matter how
   * many suites it covered.
   */
  async runSuitesIsolated(input: {
    runId: string
    projectId: string
    plan: PlannedSuite[]
    stackLabel: string
    sandboxed: SandboxEnv
    dbServers: readonly string[]
  }): Promise<void> {
    const { runId, projectId, plan, stackLabel, sandboxed, dbServers } = input
    const control: { cancelled: boolean; sessionId: string | null } = { cancelled: false, sessionId: null }
    this.isolatedRuns.set(runId, control)
    const provedNothing: string[] = []
    try {
      for (const planned of plan) {
        // Checked before every suite, not just once: this is what makes a
        // cancel stop the QUEUE rather than only the suite already running.
        if (control.cancelled) break
        if (planned.unavailable) continue
        const result = await this.runOneIsolatedSuite(
          runId,
          projectId,
          planned,
          stackLabel,
          sandboxed,
          dbServers,
          control,
        )
        // noteSuite is itself guarded on the run still being 'running' (see its
        // own comment), so a report arriving after a cancel already finished
        // this run is a harmless no-op rather than reopening a settled verdict.
        this.repos.verifyRuns.noteSuite(runId, result)
        this.callbacks.onVerifyChanged(projectId)
        if (result.status === 'not_run') provedNothing.push(result.id)
      }
    } finally {
      this.isolatedRuns.delete(runId)
      // The run's own node_modules volume (see nodeModulesVolumeKey on
      // HostedEntry and in wslc-sandbox.ts) — nothing after this run reads it
      // again, unlike a session's OWN volume which finaliseRow already leaves
      // alone mid-run for exactly the opposite reason (a sibling suite still
      // needs it). A no-op docker call when the run never touched a Node
      // project.
      removeNodeModulesVolume(runId)
    }
    const run = this.repos.verifyRuns.byId(runId)
    // A cancel finishes the row immediately (see cancelVerifyRun) rather than
    // waiting for the in-flight suite to unwind, so by the time this loop ends
    // the row may already be settled. Finishing it again here would overwrite
    // that verdict with one built from a report the developer already told the
    // app to discard.
    if (!run || run.status !== 'running') return
    const report = run.report ?? emptyVerifyReport()
    const note =
      provedNothing.length > 0
        ? `${provedNothing.length === 1 ? 'This suite' : 'These suites'} proved nothing: ${provedNothing.join(', ')}.`
        : null
    this.repos.verifyRuns.finish(runId, verifyVerdict(report), report, note)
    this.callbacks.onVerifyChanged(projectId)
  }

  /**
   * One suite, start to finish: a fresh containerised background session, the
   * ordinary verifyPrompt over a plan of just this suite, a wait for it to
   * settle, then the session stopped and its container gone — awaited, so the
   * caller's next iteration never starts a second container while this one is
   * still tearing down (the entire point of the isolated path).
   *
   * Never throws: a suite whose session could not even start (Docker down, the
   * two-container ceiling already spent by something else) is recorded the
   * same way a suite that started and then reported nothing is — `not_run`,
   * not dropped and not a pass — so one bad suite never takes the rest of the
   * queue down with it.
   */
  private async runOneIsolatedSuite(
    runId: string,
    projectId: string,
    planned: PlannedSuite,
    stackLabel: string,
    sandboxed: SandboxEnv,
    dbServers: readonly string[],
    control: { cancelled: boolean; sessionId: string | null },
  ): Promise<SuiteResult> {
    let session: Session
    try {
      session = await this.startSession(projectId, false, undefined, undefined, {
        containerised: true,
        background: true,
        // Sequential by construction — see this key's own comment in
        // wslc-sandbox.ts for why sharing one node_modules volume across the
        // whole run is safe here and nowhere else.
        nodeModulesVolumeKey: runId,
      })
    } catch (error) {
      return {
        id: planned.suite.id,
        label: planned.suite.label,
        status: 'not_run',
        detail: errorMessage(error),
      }
    }
    control.sessionId = session.id
    try {
      // A cancel landing while this suite's container was still starting: stop
      // it unused rather than sending a suite the developer already told the
      // app to abandon.
      if (control.cancelled) {
        return { id: planned.suite.id, label: planned.suite.label, status: 'not_run', detail: CANCEL_NOTE }
      }
      const settle = this.waitForIsolatedSuite(session.id, planned.suite)
      // The SAME prompt builder a shared-container run uses, over a one-entry
      // plan, so wording, schema flags and sandbox notes never drift from what
      // a normal run produces (see verifyPrompt's own contract).
      this.sendMessage(session.id, verifyPrompt([planned], stackLabel, sandboxed, dbServers))
      return await settle
    } finally {
      control.sessionId = null
      // Awaited: the caller's loop must never start the next suite's container
      // while this one is still shutting down.
      await this.stopSession(session.id, 'This suite ran in its own container, which closed when the suite finished.').catch(() => {
        // Already gone (its own turn-end path — endIfIdleBackground — may have
        // raced this and won; both are safe, stop() is idempotent and a second
        // requireLive miss here is exactly "already stopped").
      })
    }
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
      this.closeUnreportedIsolatedSuite(entry)
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
    if (!entry.ranATurn) return
    const id = entry.row.id
    // A drawing counts as outstanding work exactly like a run does. Leaving it
    // out is what let three diagram sessions be stopped mid-draw — see
    // diagramWatch for the incident this guard is written against.
    if (
      this.verifyWatch.has(id) ||
      this.apiWatch.has(id) ||
      this.evalWatch.has(id) ||
      this.diagramWatch.has(id)
    ) {
      return
    }
    if (this.repos.taskQueue.listForProject(entry.row.projectId).length > 0) return
    // Re-checked after the await inside stopSession's own path: a section can
    // dispatch again between the turn ending and this running.
    if (!this.hosted.has(id)) return
    // Named, because this is the close nobody asked for and therefore the one
    // most likely to be read as a fault. A section session exists for one piece
    // of work and goes away when that work is done, which is the design; a row
    // vanishing with nothing said is not.
    await this.stopSession(
      id,
      'This session was opened for one piece of section work, and closed itself when that work finished.',
    )
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
    this.closeUnreportedIsolatedSuite(entry)
    // A session that died mid-drawing releases its watch too, and tells the
    // section — which then reads the file that is not there and says the session
    // ended before it wrote anything, rather than waiting out twenty minutes for
    // a drawing that stopped existing five seconds in.
    if (this.diagramWatch.delete(entry.row.id)) {
      this.callbacks.onDiagramsChanged(entry.row.projectId)
    }
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
    // This session's OWN node_modules volume (see NODE_MODULES_VOLUME_PREFIX):
    // nothing ever reads it again once this container is gone, unlike the home
    // volume a RESUMING session may still need (homeVolumeFor) — so it is safe
    // to remove right here rather than waiting for the 7-day sweep that catches
    // the home volume. Native sessions never had one; the guard just skips the
    // no-op docker call for the common case.
    //
    // NOT here, though, when nodeModulesVolumeKey names a RUN rather than this
    // session: that volume is shared with the isolated run's other suites,
    // still to come, and removing it the moment this one suite's container ends
    // would hand the next suite an empty tree — exactly the cold-install cost
    // the shared key exists to avoid. runSuitesIsolated removes it itself, once,
    // after the whole run is over.
    if (entry.containerised && !entry.nodeModulesVolumeKey) removeNodeModulesVolume(entry.row.id)
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
   *
   * Counts reservedContainerIds alongside `hosted`, not `hosted` alone: a start
   * that has passed this very check but is still awaiting ensureSandboxImage's
   * image build has not reached `hosted.set` yet, so counting only `hosted`
   * let a second concurrent start see the same under-the-limit count and pass
   * too — the two together then oversubscribed MAX_CONTAINERS, which is the
   * exact crash this method exists to prevent. See reservedContainerIds.
   */
  private refuseWhenContainersFull(): void {
    const hostedCount = [...this.hosted.values()].filter((e) => e.containerised && !e.row.endedAt).length
    const total = hostedCount + this.reservedContainerIds.size
    if (total < MAX_CONTAINERS) return
    throw {
      code: 'SANDBOX_FULL',
      message:
        `${total} sessions already run in a container, which is the limit: they share one ` +
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
