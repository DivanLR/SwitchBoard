// Single source of truth for the renderer <-> main IPC contract
// (specs/001-terminal-switchboard/contracts/ipc-contract.md).
// The preload bridge exposes this surface as `window.switchboard`.

import type {
  AvailableModel,
  CustomSkill,
  DecisionRecord,
  DiagramEntry,
  DiffListResult,
  Draft,
  EvalCheckStatus,
  EvalRun,
  EvalVerdict,
  FileDiffContent,
  McpScan,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  Project,
  ProjectCommand,
  ProjectRef,
  QueuedTask,
  RiskLevel,
  RuleKind,
  SectionKind,
  Session,
  SessionEvent,
  SessionMode,
  Settings,
  SkillImportResult,
  SpecDetail,
  SpecKitState,
  TranscriptSummary,
  VerifyRun,
} from './domain'
import type { AvailableSuites } from './test-catalog'
import type { ApiEvalRun, ApiTarget, DiscoveredEndpoint } from './api-endpoints'
import type { ArchifyOptions } from './diagram'

// --- Rules editor ---

/**
 * One risk rule as the editor shows it.
 *
 * Flattened from RiskClassificationRule on purpose: the editor needs the input
 * pattern as a string to display and to accept, and `inputMatcher.field` is always
 * the tool's own argument, so nesting it would be a shape the UI has to unwrap for
 * no decision it can make.
 *
 * Disabled rules ARE included, unlike the list the classifier runs on. The editor
 * has to be able to switch one back on, so it must be able to see it.
 */
export interface RiskRuleView {
  id: string
  /** False for a rule the developer wrote; those can be deleted, shipped ones reset. */
  builtin: boolean
  /** Shipped rules carry a written label; a custom rule shows its own matcher. */
  label: string
  toolMatcher: string
  pattern: string | null
  risk: RiskLevel
  /** The developer changed this shipped rule's level. */
  overridden: boolean
  disabled: boolean
}

/** One noise rule as the editor shows it. Disabled rules included, as above. */
export interface SwallowRuleView {
  id: string
  builtin: boolean
  eventKindMatcher: string
  pattern: string
  noiseKind: string
  disabled: boolean
}

export interface RulesView {
  risk: RiskRuleView[]
  swallow: SwallowRuleView[]
}

// --- Error model ---

export type IpcErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_ACTIVE'
  | 'SESSION_ENDED'
  | 'CONFIRM_REQUIRED'
  | 'RULE_NOT_ALLOWED'
  | 'INVALID_PATH'
  | 'DUPLICATE'
  | 'NOT_LIVE'
  /** Too many sessions already hold a container; they share one virtual machine. */
  | 'SANDBOX_FULL'
  | 'INTERNAL'

export interface IpcError {
  code: IpcErrorCode
  message: string
}

export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IpcError).code === 'string' &&
    typeof (value as IpcError).message === 'string'
  )
}

/**
 * Every code, as data, so an unrecognised one can be caught at runtime.
 *
 * `isIpcError` only checks that `code` is a string, which is all it can do across
 * a wire — so a typo, or a throw from a module that never imported IpcError, used
 * to be cast straight through to the renderer. The renderer switches on these, so
 * an unknown code falls through every branch and the developer sees nothing.
 *
 * An exhaustive `Record` rather than an array: adding a code to IpcErrorCode
 * without adding it here is a compile error, the same guard PUSH_CHANNELS uses.
 */
const IPC_ERROR_CODE_KEYS: Record<IpcErrorCode, true> = {
  NOT_FOUND: true,
  ALREADY_ACTIVE: true,
  SESSION_ENDED: true,
  CONFIRM_REQUIRED: true,
  RULE_NOT_ALLOWED: true,
  INVALID_PATH: true,
  DUPLICATE: true,
  NOT_LIVE: true,
  SANDBOX_FULL: true,
  INTERNAL: true,
}

export function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return typeof value === 'string' && Object.hasOwn(IPC_ERROR_CODE_KEYS, value)
}

/**
 * What went wrong, in words a developer can act on.
 *
 * A rejected invoke does NOT arrive as an Error. The main process throws a plain
 * `IpcError` and it crosses the bridge as a plain object, so the obvious
 * `error instanceof Error ? error.message : String(error)` fell through to
 * `String({...})` and put the literal text "[object Object]" on screen. Every
 * reason a call could fail — the stack was unknown, no suite was chosen, Claude
 * Code was not installed — reached the user as that same useless string.
 *
 * Lives here rather than in the renderer because the shape it unwraps is defined
 * here, and both sides of the bridge describe failures with it.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (isIpcError(error)) return error.message
  if (error instanceof Error) return error.message
  // A thrown string is still worth showing. Anything else has no message to give,
  // and the caller's own wording beats printing a stringified object.
  if (typeof error === 'string' && error.trim() !== '') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() !== '' ? message : fallback
}

/**
 * Wire envelope for invoke responses. Electron serialises thrown errors down
 * to their message string, so structured errors travel inside the envelope
 * and the preload bridge re-throws them as `IpcError`.
 */
export type WireResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

// --- Invoke surface (renderer -> main) ---

export interface ProjectSuggestion {
  path: string
  name: string
}

/** Project decorated with its live session for the sidebar (FR-003/004/005). */
export interface ProjectListItem extends Project {
  /**
   * The FOCUSED session: the one the centre pane, the composer and the header are
   * showing. It is `sessions[0]` as the main process builds it, and the renderer
   * repoints it when the developer picks a different subsession — which is why it
   * stays a single field rather than an index. Null only for a project that has
   * never had a session.
   */
  session: Session | null
  /**
   * Every session this project currently has running, in the order they were
   * started, oldest first — the same order the inbox uses within a group. A project
   * with none running carries its most recent ended session instead, so the sidebar
   * still shows what last happened there.
   *
   * A project used to be limited to one session at a time. That limit is gone at the
   * owner's direction; see PRODUCT.md's Operating Context.
   */
  sessions: Session[]
  /** Why git will not work in this project's bypass container (no .git directory
   *  at the root), or null when it will — the header's "No git" pill. */
  gitNotice: string | null
  /** Pending composer drafts preserved from a previous run, if any. */
  drafts: Draft[]
  /** True only for the single reserved, project-less row backing the global
   *  Database MCP session; excluded from the sidebar's project list and never
   *  independently selectable as `selectedProjectId`. */
  reserved: boolean
}

export interface Counters {
  running: number
  needsYou: number
  costTodayUsd: number
  tokensToday: number
}

/** projects.list returns projects with live status plus the aggregate counters (FR-005). */
export interface ProjectsSnapshot {
  projects: ProjectListItem[]
  counters: Counters
}

export interface InvokeMap {
  'projects.list': { req: void; res: ProjectsSnapshot }
  /** Native folder picker. `path` is null when the dialogue was cancelled, which
   *  is an ordinary outcome and not an error, so it carries no IpcErrorCode. */
  'dialog.pickFolder': { req: void; res: { path: string | null } }
  /** Native file picker for a diagram command's file argument. `command` selects
   *  the title and filters from DIAGRAM_FILE_PICKS; an unknown one is rejected
   *  rather than opening an unfiltered dialogue. `path` is null when the
   *  dialogue was cancelled, which is an ordinary outcome, not an error. */
  'dialog.pickFile': { req: { command: string }; res: { path: string | null } }
  'projects.register': {
    req: { path: string; name?: string; defaultSessionMode?: SessionMode }
    res: Project
  }
  /** Change an existing project's session mode. Takes effect on its next start,
   *  never on a session already running: the SDK mode is fixed at spawn. */
  'projects.setSessionMode': { req: { projectId: string; mode: SessionMode }; res: void }
  /** Turn containers on or off for this project's section work (and for what the
   *  start controls offer a chat session). Read at spawn, so it applies from
   *  the next session and never to one already running. */
  'projects.setUseContainers': { req: { projectId: string; on: boolean }; res: void }
  'projects.rename': { req: { projectId: string; name: string }; res: void }
  /** Point a project at a different folder; keeps id, sessions, and history. */
  'projects.repoint': { req: { projectId: string; path: string }; res: Project }
  'projects.move': { req: { projectId: string; toIndex: number }; res: void }
  'projects.refs.add': {
    // `target` is a folder path or the name of another registered project.
    req: { projectId: string; target: string }
    res: ProjectRef[]
  }
  'projects.refs.remove': { req: { projectId: string; path: string }; res: ProjectRef[] }
  'projects.archive': { req: { projectId: string }; res: void }
  'sessions.start': {
    req: {
      projectId: string
      resume?: boolean
      /**
       * Override the project's own `defaultSessionMode` for this one session.
       * Omit it and the project's choice applies, which is the normal path: the
       * mode is a per-project setting, and only the restart controls send this.
       *
       * One value, not the two booleans it replaces, because the SDK takes a
       * single permissionMode — `bypass` plus `plan` was a state no session
       * could actually spawn in, and the manager had to silently drop one.
       */
      mode?: SessionMode
      /**
       * WHERE this session runs, chosen at start: true for a WSL container,
       * false for the developer's own machine.
       *
       * Separate from `mode`, which decides what the session may DO. Bypass
       * still forces a container regardless, because on Windows there is no
       * other isolation boundary; this only adds the container to a mode that
       * would not otherwise have had one. Omitted means native, the behaviour
       * before the choice existed.
       */
      containerised?: boolean
      /**
       * Seed the new session with a previous session's transcript: its digest
       * goes into the system prompt and the full file is named there for the
       * model to read on demand. Ignored when that transcript has expired.
       */
      carryTranscriptFrom?: string
    }
    res: Session
  }
  /** Switch a live session into or out of plan mode without restarting it.
   *  Refused for a bypass session (RULE_NOT_ALLOWED). */
  'sessions.setPlanMode': { req: { sessionId: string; enabled: boolean }; res: void }
  'sessions.stop': { req: { sessionId: string }; res: void }
  /**
   * One session's fate, by id. Null when no such session exists.
   *
   * Needed because `projects.list` is a view for the SIDEBAR, not a register of
   * sessions: it reports the live rows and falls back to the newest ended one
   * only when there are none, so a background session that dies while the chat
   * session is still running vanishes from it entirely. Anything waiting on that
   * background session — a diagram being drawn, say — then cannot tell "still
   * working" from "died four minutes ago" and waits out its whole budget.
   */
  'sessions.fate': {
    req: { sessionId: string }
    res: { endedAt: string | null; endReason: string | null; statusDetail: string | null } | null
  }
  'sessions.interrupt': { req: { sessionId: string }; res: { stillQueued: number } }
  'sessions.send': {
    req: { sessionId: string; text: string; agentId?: string }
    res: { eventId: string; queued: boolean }
  }
  'sessions.answerQuestion': { req: { sessionId: string; eventId: string; choice: string }; res: void }
  'sessions.events': {
    req: { sessionId: string; beforeSeq?: number; limit?: number }
    res: SessionEvent[]
  }
  /** Recent distinct commands (past composer messages) for terminal-style suggestions. */
  'sessions.promptHistory': { req: { projectId: string; limit?: number }; res: string[] }
  /**
   * Write this session's transcript now. Sessions also write continuously as
   * events land, so this is for the moment a developer wants the file on disk
   * before doing something risky, not the only way one gets written.
   */
  /** Name a session in the developer's own words. An empty string clears the
   *  name and the derived one (Session.name) takes over again. */
  'sessions.rename': { req: { sessionId: string; label: string }; res: void }
  /**
   * Put text on the system clipboard, through the MAIN process.
   *
   * Not `navigator.clipboard` in the renderer, and the reason is a bug this
   * feature hit twice. That API is gated by Electron's permission handlers, and
   * this app denies renderer permissions by default; it also requires a focused
   * document, and rejects without one. Both failures look identical to the
   * developer: a click that reports it could not copy. The main process has
   * unconditional clipboard access, so this path cannot be denied, cannot depend
   * on focus, and cannot break again when a security handler is tightened.
   */
  'clipboard.write': { req: { text: string }; res: void }
  'transcripts.save': { req: { sessionId: string }; res: TranscriptSummary }
  /** Unexpired transcripts, newest first. Expired files are swept on every read. */
  'transcripts.list': { req: Record<string, never>; res: TranscriptSummary[] }
  /** Available slash commands / skills (plugins) for the project, for composer suggestions. */
  'projects.commands': { req: { projectId: string }; res: ProjectCommand[] }
  /**
   * Custom skills: the ones the developer imported from a Git host themselves,
   * as opposed to the curated plugin commands the Cleanup section offers.
   *
   * User-level, not per-project, and the contract says so by taking no projectId:
   * the CLI reads ONE user skills directory for every project, so a per-project
   * switch here would be this app inventing a granularity the runtime does not
   * have. `skills.run` is the exception, because running one has to happen
   * somewhere.
   */
  'skills.list': { req: void; res: CustomSkill[] }
  /** Import every skill under a github.com URL. Fetches over HTTPS and writes
   *  files; it never runs anything from the repository. */
  'skills.import': { req: { url: string }; res: SkillImportResult }
  /** Switch one on or off, which physically adds or removes its directory from
   *  ~/.claude/skills. Applies to sessions started afterwards. */
  'skills.setEnabled': { req: { name: string; enabled: boolean }; res: CustomSkill[] }
  /** Forget a skill and delete both copies of its files. */
  'skills.remove': { req: { name: string }; res: CustomSkill[] }
  /** Dispatch `/<name>` into this project's own Skills session. */
  'skills.run': { req: { projectId: string; name: string; argument?: string }; res: { sessionId: string } }
  /** Spec Kit state for a project: installed? plus the spec summaries. */
  'specs.state': { req: { projectId: string }; res: SpecKitState }
  /** Full detail for one spec. */
  'specs.detail': { req: { projectId: string; specId: string }; res: SpecDetail | null }
  /** Install Spec Kit into the project (ephemeral uvx; never global). */
  'specs.install': { req: { projectId: string }; res: SpecKitState }
  /** Changed files in the project's working tree (tracked and untracked
   *  together). Throws NOT_LIVE when the project has no live session — this
   *  tab is live-session-only. */
  'diff.list': { req: { projectId: string }; res: DiffListResult }
  /** One file's diff content, fetched only on selection. Null when the file
   *  no longer matches a current changed-file entry. */
  'diff.file': { req: { projectId: string; path: string }; res: FileDiffContent | null }
  /**
   * Apply an instruction to one region of a changed file, the way a reviewer
   * leaves a comment on a pull request — except the comment is carried out.
   *
   * Runs in the section's containerised background session, not the conversation:
   * /workspace is bind-mounted read-write, so the edit lands in the developer's
   * own working tree and shows up in this same diff, while the session it runs in
   * cannot be derailed by whatever the developer is talking about in the chat.
   *
   * `lines` is the selected diff text verbatim rather than line numbers. Numbers
   * drift the moment anything above them changes, and the region is being handed
   * to a model that can find text far more reliably than it can count.
   */
  'diff.apply': {
    req: {
      projectId: string
      path: string
      /** The selected diff lines, in order, with their +/-/space markers intact. */
      lines: string[]
      /** What to do to that region, in the developer's words. */
      instruction: string
    }
    res: { sessionId: string }
  }
  /** Every diagram in the project's docs/diagrams folder, newest first. Reads the
   *  folder itself, so a file deleted from the repo leaves the list even though
   *  the app still holds the request that made it. */
  'diagrams.list': { req: { projectId: string }; res: DiagramEntry[] }
  /**
   * Ask the project's session for a diagram, starting a session if none is live.
   * The app chooses the file name and records the request BEFORE dispatching, so
   * the finished file can be attributed to the session and the sentence that
   * asked for it. Returns the name it chose, which nothing else can predict.
   */
  'diagrams.generate': {
    /**
     * `archify` picks the second engine and carries what its interactive bar
     * collected. Optional, and its absence means the diagram-design plugin:
     * the two engines are asked for a drawing in genuinely different words
     * (see archifyPrompt), so which one is wanted has to travel with the
     * request rather than be inferred here.
     */
    req: { projectId: string; description: string; archify?: ArchifyOptions }
    res: { sessionId: string; file: string }
  }
  /**
   * Install a Claude Code plugin ON THE HOST, with the CLI's own non-interactive
   * `plugin marketplace add` and `plugin install` subcommands.
   *
   * Not a session message. Plugins used to be "installed" by sending `/plugin …`
   * to a session, which an Agent SDK session cannot run, and which went to a
   * throwaway container that no other session shares. Resolves only when the
   * plugin is genuinely installed, so the caller can report success honestly.
   */
  'plugins.install': { req: { marketplace: string; pkg: string }; res: void }
  /** Open one diagram in the developer's default browser. `file` is a bare file
   *  name inside the project's diagrams folder; anything else is refused. */
  'diagrams.open': { req: { projectId: string; file: string }; res: void }
  /**
   * One diagram's HTML, for rendering inside the app.
   *
   * The renderer puts this in a sandboxed iframe's srcdoc, where it cannot run
   * script: the frame carries no allow-scripts, and the app's own CSP
   * (`script-src 'self'`) applies to srcdoc content, so two independent layers
   * refuse it. Same file-name rule as `diagrams.open`.
   */
  'diagrams.read': { req: { projectId: string; file: string }; res: { html: string } }
  /** The cached MCP schema map, or null if unscanned. With `servers`, reads the
   *  combination's own scan doc (.switchboard/scans/<combo>.md); without, the
   *  legacy single db-schema.md. */
  'mcp.readSchema': { req: { projectId: string; servers?: string[] }; res: { content: string | null } }
  /** Scanned-combination history, newest first ("have I scanned this set before?"). */
  'mcp.scanHistory': { req: { projectId: string }; res: McpScan[] }
  /** Record a completed scan for a combination (verifies the doc exists first). */
  'mcp.recordScan': { req: { projectId: string; servers: string[] }; res: McpScan | null }
  /**
   * Run text in the project's session (a spec-kit command or a start-phase
   * prompt), starting a session first if none is live.
   *
   * `background: true` sends the text to the project's BACKGROUND session (the
   * one the Tests section and diagram generation already share) rather than the
   * conversation. Every section dispatch sets it: a spec-kit phase, a cleanup
   * command or a plugin install is long work whose output the developer reads
   * afterwards, and queued into the chat it blocks whatever they were doing.
   *
   * The composer's own spec-edit flow deliberately does NOT set it. A developer
   * who typed into the chat expects the answer in the chat.
   */
  'specs.runInSession': {
    req: {
      projectId: string
      text: string
      background?: boolean
      /**
       * Which section this dispatch belongs to, and so which of the project's
       * background sessions it lands in. Only read when `background` is set.
       * Defaults to 'spec', which is what this endpoint was built for.
       */
      kind?: SectionKind
      /**
       * This dispatch may write a diagram, so tell the Diagrams section when the
       * turn ends rather than leaving it to find out. Set by the Diagrams tab's
       * Commands row: a plugin command draws through the skill's own machinery,
       * so the app never learns the file name and cannot poll for it the way the
       * Generate button does.
       */
      watchDiagrams?: boolean
    }
    res: { sessionId: string }
  }
  /** Eval loop (spec 002 US7): acceptance lines with their verdicts + ratings.
   *  Every mutation answers with the project's full list, newest first, so the
   *  view never has to merge a partial response. The check itself runs through
   *  `specs.runInSession` like any other session work (FR-041/FR-087). */
  'evals.list': { req: { projectId: string }; res: EvalRun[] }
  'evals.add': { req: { projectId: string; acceptance: string; checkCmd?: string }; res: EvalRun[] }
  'evals.record': {
    req: {
      projectId: string
      id: string
      checkStatus?: EvalCheckStatus
      verdict?: EvalVerdict
      /** 1-5, the developer's own score; null clears it. */
      rating?: number | null
      note?: string | null
      /** Parallel attempts to ask for next time this line is implemented (1-5). */
      attempts?: number
    }
    res: EvalRun[]
  }
  'evals.remove': { req: { projectId: string; id: string }; res: EvalRun[] }
  /** Suites the project's detected stacks support — the API/FE/UI checks
   *  available without writing a runner (FR-033/FR-035/FR-037). */
  'evals.suites': { req: { projectId: string }; res: AvailableSuites[] }
  /**
   * Send an acceptance line's work to the session (FR-041) and, for a check or a
   * judge pass, watch that session's output for the reported result:
   *   check    — run the check and report PASS / FAIL / INCONCLUSIVE
   *   attempts — N worktree-isolated attempts, then a report naming the winner
   *   judge    — a second opinion on the diff against the acceptance line
   */
  'evals.dispatch': {
    req: { projectId: string; id: string; kind: 'check' | 'attempts' | 'judge' }
    res: { sessionId: string; runs: EvalRun[] }
  }
  /** Verification runs (spec 002 US1-US4): the suites a run executed and what it
   *  measured — results, coverage, quality and evidence. Newest first. */
  'verify.list': { req: { projectId: string }; res: VerifyRun[] }
  /**
   * Start a run: send the chosen suites to the project's session (FR-041/FR-045)
   * and watch its output for the report. Suites the environment cannot run are
   * reported as skipped with the reason rather than attempted (FR-057).
   */
  'verify.start': {
    req: {
      projectId: string
      stackId: string
      suiteIds: string[]
      /**
       * Opt in to running each chosen suite in its OWN fresh container,
       * sequentially, rather than sending the whole set to one combined
       * background session. Absent or false is EXACTLY today's behaviour in
       * every respect: one session, one prompt naming every suite, one report.
       *
       * The reason to opt in is memory isolation, not speed — it is strictly
       * slower, since a container starts fresh per suite instead of once for
       * the lot. Suites sharing one container share its memory ceiling, and a
       * heavy suite has been killing that container out from under the others
       * (exit 137, SIGKILL, no stderr — nothing left behind to explain why the
       * whole run went quiet). Closing each suite's container before the next
       * one starts means a suite that blows its own budget takes down only
       * itself.
       */
      isolated?: boolean
    }
    /**
     * `sessionId` is the background session this call opened to plan the run.
     * NULL on the isolated path, and that is the honest answer rather than a
     * gap: an isolated run opens no shared session, because each suite opens
     * and closes its own in turn. Opening one anyway, purely so this field
     * could be a string, would strand a container that nothing ever reclaims —
     * a background session that never runs a turn is one endIfIdleBackground
     * will not close, and there are only two container slots on the machine.
     */
    res: { sessionId: string | null; runs: VerifyRun[] }
  }
  /** Capture evidence for a finished run without re-running its tests (FR-059).
   *  Attaches to `runId`, or to the newest run when omitted. */
  'verify.evidence': {
    req: { projectId: string; runId?: string }
    res: { sessionId: string; runs: VerifyRun[] }
  }
  /**
   * Stop a run in progress: interrupts the session's current turn and closes the
   * row as inconclusive, saying the developer stopped it. A run that already
   * finished is left exactly as it is.
   */
  'verify.cancel': { req: { projectId: string; runId: string }; res: VerifyRun[] }
  /**
   * The endpoints this project declares, scanned from its own source, plus the
   * ones most recently tested and where a run would call them. Nothing here needs
   * a session or a running API: the list is browsable and searchable cold.
   */
  'api.endpoints': {
    req: { projectId: string }
    res: {
      endpoints: DiscoveredEndpoint[]
      /** The last few endpoints actually tested, newest first. */
      recent: { method: string; template: string }[]
      /** Files the scan read, and whether it stopped at its own limit. */
      filesRead: number
      truncated: boolean
      /** Where a run would call, or why it cannot yet. */
      host: { baseUrl: string | null; startCmd: string | null; from: string | null; error: string | null }
      /**
       * The deployed environment the same set can be run against: the URL as
       * stored, the header lines as stored (references, never resolved values),
       * and the reason a QA run would fail right now if there is one.
       */
      qa: { baseUrl: string | null; headers: string | null; error: string | null }
    }
  }
  /** API eval sets for a project, newest first. */
  'api.runs': { req: { projectId: string }; res: ApiEvalRun[] }
  /**
   * Run an automated eval set over the chosen endpoints. The session is asked for
   * the request data only; the app then starts the API if needed, sends every
   * request itself, and judges each response in code.
   *
   * `target` picks the environment: absent means the local API, 'qa' the deployed
   * one, which is never started and never stopped by the app.
   */
  'api.start': {
    req: {
      projectId: string
      endpoints: { method: string; template: string }[]
      target?: ApiTarget
    }
    res: { sessionId: string; runs: ApiEvalRun[] }
  }
  /**
   * Stop an eval set in progress. This reaches the session being asked for
   * request data; once the app itself is mid-loop sending the real calls there
   * is nothing to interrupt, so the run finishes on its own.
   */
  'api.cancel': { req: { projectId: string; runId: string }; res: ApiEvalRun[] }
  /** Set where a project's API lives. An empty string clears the override. */
  'api.setHost': {
    req: {
      projectId: string
      baseUrl?: string
      startCmd?: string
      /** The deployed environment's URL, and its `Name: value` header lines. */
      qaBaseUrl?: string
      qaHeaders?: string
    }
    res: Settings
  }
  /**
   * Write the test report for a finished run and answer with the file it wrote.
   *
   * On demand rather than on every run: the report is a document the developer
   * keeps, so it appears when they ask for one instead of accumulating a file per
   * run in their working tree. Everything in it is derived from the recorded run,
   * so an old run can still produce its report.
   */
  'api.report': {
    req: { projectId: string; runId?: string }
    res: { path: string }
  }
  /** Planned task queue: prompts/goals that auto-run in sequence (FR-023). */
  'queue.list': { req: { projectId: string }; res: QueuedTask[] }
  'queue.add': { req: { projectId: string; text: string }; res: QueuedTask[] }
  /** Reword a task that has not run yet. Empty text removes it. */
  'queue.edit': { req: { projectId: string; id: string; text: string }; res: QueuedTask[] }
  'queue.remove': { req: { projectId: string; id: string }; res: QueuedTask[] }
  'inbox.pending': { req: void; res: PermissionRequest[] }
  'inbox.decide': {
    req: { requestId: string; decision: 'approve' | 'deny'; confirmHighRisk?: boolean }
    res: { delivered: boolean }
  }
  'inbox.alwaysAllow': {
    // From a DECIDED history entry (design: right-click a command in history).
    // The main process derives the command-prefix matcher from the recorded
    // command; the caller only names the request.
    req: { requestId: string }
    res: { rule: PermissionRule }
  }
  'inbox.approveAlways': {
    // From a PENDING inbox item ("Always allow …"): inserts the standing rule
    // server-side, then approves this request. Bash → command-prefix rule
    // (refused for high-risk/destructive). MCP tools → tool_only rule
    // allow-listing the whole tool; high only by fail-safe, so confirmHighRisk
    // must be true to proceed. Refused for plans and other tools.
    req: { requestId: string; confirmHighRisk?: boolean }
    res: { delivered: boolean; rule: PermissionRule }
  }
  'inbox.approveAllForProject': {
    // includeHighRisk approves high-risk items too; the UI sets it only after an
    // explicit confirmation.
    req: { projectId: string; includeHighRisk?: boolean }
    res: { approved: number; skippedHighRisk: number }
  }
  'inbox.history': { req: { projectId?: string; limit?: number }; res: DecisionRecord[] }
  'inbox.deleteHistory': { req: { requestId: string }; res: void }
  'inbox.clearHistory': { req: void; res: void }
  'rules.standing.list': {
    req: { projectId: string; includeRevoked?: boolean }
    res: PermissionRule[]
  }
  'rules.standing.revoke': { req: { ruleId: string }; res: void }
  'rules.standing.restore': { req: { ruleId: string }; res: void }
  // User-authored allowed command (Allowed list tab): a Bash command-prefix rule.
  'rules.standing.add': { req: { projectId: string; pattern: string }; res: PermissionRule }
  /**
   * Reword a composer message still queued behind the running turn, or withdraw it
   * by sending empty text — the same convention `queue.edit` uses.
   *
   * Fails with NOT_FOUND once the turn has finished and the message has gone,
   * which is a race the developer cannot see coming.
   */
  'sessions.editQueued': { req: { sessionId: string; eventId: string; text: string }; res: void }
  /**
   * Risk classification and noise rules (PRODUCT.md Principle 3: the developer
   * owns the rules).
   *
   * Every mutation answers with the whole list, as the queue methods do, so the
   * editor never has to re-ask and cannot render a half-applied change.
   *
   * The shipped defaults live in code; only what the developer changed is stored.
   * `remove` therefore means "delete" for a rule they wrote and "back to the
   * shipped default" for one they overrode — the same operation either way.
   */
  'rules.list': { req: void; res: RulesView }
  'rules.setDisabled': { req: { id: string; kind: RuleKind; disabled: boolean }; res: RulesView }
  /** null restores the shipped level. */
  'rules.setRisk': { req: { id: string; risk: RiskLevel | null }; res: RulesView }
  'rules.addRisk': {
    req: { toolMatcher: string; pattern: string | null; risk: RiskLevel }
    res: RulesView
  }
  'rules.addSwallow': {
    req: { eventKindMatcher: string; pattern: string; noiseKind: string }
    res: RulesView
  }
  'rules.remove': { req: { id: string; kind: RuleKind }; res: RulesView }
  'settings.get': { req: void; res: Settings }
  'settings.set': { req: Partial<Settings>; res: Settings }
  /** Models this subscription can select, read from the CLI (probed on first ask
   *  when no session has reported yet), so the picker follows the account across
   *  model releases. Empty only when the CLI cannot answer → default only. */
  'models.available': { req: void; res: AvailableModel[] }
  /** App auto-update (GitHub releases). */
  'updates.check': { req: void; res: { status: UpdateStatus['state'] } }
  'updates.install': { req: void; res: void }
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  percent?: number
  message?: string
}

export type InvokeMethod = keyof InvokeMap

// --- Push surface (main -> renderer) ---

/** The full live session row; the renderer replaces its copy wholesale. */
export type SessionStatusPush = Session

export interface InboxChangedPush {
  added?: PermissionRequest
  resolved?: { requestId: string; status: PermissionRequestStatus; deliveryFailed?: boolean }
}

export interface QueueChangedPush {
  projectId: string
  items: QueuedTask[]
}

/** Available slash commands / skills for a project, captured from a session's
 * init message, pushed so the composer picks them up without a project switch. */
export interface ProjectCommandsPush {
  projectId: string
  commands: ProjectCommand[]
}

export type FocusRequestPush =
  | { target: 'inbox'; requestId: string }
  | { target: 'session'; sessionId: string; eventId?: string }

/** An acceptance line's result read off the session (the verifier gate), pushed
 *  so the Tests tab updates while the developer watches the check run. */
export interface EvalsChangedPush {
  projectId: string
  runs: EvalRun[]
}

/** A verification run's report read off the session, pushed so the gates and
 *  panels fill in as the run finishes rather than on a manual refresh. */
export interface VerifyChangedPush {
  projectId: string
  runs: VerifyRun[]
}

/**
 * A project's diagram folder, pushed the moment the session drawing one finishes
 * its turn.
 *
 * The section used to learn about a finished diagram only by asking: the store
 * polled `diagrams.list` on a timer, so a drawing that landed a moment after a
 * tick sat there unseen until the next one. The app is not what writes the file —
 * the session is — but the app knows exactly when that session's turn ended, and
 * a turn that ended is a file that exists. That is a push, not a question worth
 * repeating for twenty minutes.
 *
 * Carries the whole folder listing rather than just the project id, like every
 * other channel here, so the section redraws from the push instead of answering
 * it with another round trip.
 */
export interface DiagramsChangedPush {
  projectId: string
  entries: DiagramEntry[]
}

/** An API eval set's calls, pushed as the run finishes: the requests the app sent
 *  and the statuses it received, so the panel fills in without a refresh. */
export interface ApiChangedPush {
  projectId: string
  runs: ApiEvalRun[]
}

export interface PushMap {
  /** Individual events; the transport batches them (>= 30 Hz flushes) and the bridge fans out per event. */
  'push.event': SessionEvent
  'push.sessionStatus': SessionStatusPush
  'push.counters': Counters
  'push.inboxChanged': InboxChangedPush
  'push.queueChanged': QueueChangedPush
  'push.evalsChanged': EvalsChangedPush
  'push.verifyChanged': VerifyChangedPush
  'push.diagramsChanged': DiagramsChangedPush
  'push.apiChanged': ApiChangedPush
  'push.projectCommands': ProjectCommandsPush
  'push.focusRequest': FocusRequestPush
  'push.updateStatus': UpdateStatus
}

export type PushChannel = keyof PushMap

/**
 * The preload validates every subscription against this list, so a channel in
 * `PushMap` that is missing here is rejected at runtime — the push simply never
 * arrives, with nothing to read in either process.
 *
 * Written as an exhaustive `Record` rather than an array so that is a COMPILE
 * error instead: `Record<PushChannel, true>` rejects a missing key and an unknown
 * one alike, which a `readonly PushChannel[]` literal cannot do.
 */
const PUSH_CHANNEL_KEYS: Record<PushChannel, true> = {
  'push.event': true,
  'push.sessionStatus': true,
  'push.counters': true,
  'push.inboxChanged': true,
  'push.queueChanged': true,
  'push.evalsChanged': true,
  'push.verifyChanged': true,
  'push.diagramsChanged': true,
  'push.apiChanged': true,
  'push.projectCommands': true,
  'push.focusRequest': true,
  'push.updateStatus': true,
}

export const PUSH_CHANNELS: readonly PushChannel[] = Object.keys(
  PUSH_CHANNEL_KEYS,
) as PushChannel[]

/**
 * The single `ipcRenderer.invoke` channel every request rides on. Shared because
 * the preload and the main handler must agree on it exactly, and a typo in either
 * copy is a silent dead bridge rather than a build failure.
 */
export const INVOKE_CHANNEL = 'switchboard:invoke'

// --- The bridge exposed as `window.switchboard` ---

export interface SwitchboardApi {
  invoke<M extends InvokeMethod>(method: M, req: InvokeMap[M]['req']): Promise<InvokeMap[M]['res']>
  on<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void
  /**
   * Absolute path of a dragged-in OS file (Electron webUtils; File.path is
   * gone in modern Electron). Absent under the browser-based e2e mock.
   */
  pathForFile?(file: unknown): string
  /**
   * Subscribe to the number of in-flight `invoke` calls (drives the global
   * loading spinner). Fires immediately with the current count. Returns an
   * unsubscribe. Absent under the browser-based e2e mock.
   */
  onLoading?(listener: (pending: number) => void): () => void
}

declare global {
  interface Window {
    switchboard: SwitchboardApi
  }
}
