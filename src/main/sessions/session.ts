// Wrapper around one Agent SDK `query()` run: streaming input, composer
// queueing (FR-019), interrupt/stop (FR-019a), status derivation
// (contracts/session-events.md) and process-death detection (FR-004, FR-006).
import { setTimeout as delay } from 'node:timers/promises'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_SESSION_MODE, modelLabel, type AvailableModel, type McpServer, type ModelMode, type ProjectCommand, type SessionMode, type SessionStatus } from '@shared/domain'
import { sandboxSpawn, toContainerPaths, type SandboxPlan } from './wslc-sandbox'
import { MessageMapper, type EventSink } from './message-mapper'
import { toAvailableModels } from './model-catalog'
import {
  classifyWorkload,
  effortForRole,
  mainLoopModel,
  modelDeviation,
  nextStrongestModel,
} from './model-routing'
import { modeAgents } from './session-shaping'

/**
 * How long stop() waits for the SDK message loop to drain before giving up and
 * letting the app quit. Long enough for a normal turn teardown, short enough that
 * a wedged CLI cannot hold the window open.
 */
const EXIT_GRACE_MS = 5_000

/** Streaming input queue the SDK consumes; `end()` closes the session gracefully. */
class AsyncPushQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: ((result: IteratorResult<T>) => void)[] = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
    }
  }
}

type CanUseToolOptions = Parameters<CanUseTool>[2]

/**
 * Re-exported so the rest of the main process never imports the SDK directly.
 * `src/main/sessions/` is the SDK's only home (CLAUDE.md), and the permission
 * broker needs this type because it IS what a gate resolves to — an SDK upgrade
 * that reshapes it then lands here, not scattered across the inbox.
 */
export type { PermissionResult }

/** The permission broker's entry point, bound per session by the manager (R3). */
export type PermissionGate = (context: {
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  options: CanUseToolOptions
}) => Promise<PermissionResult>

interface HostedSessionOptions {
  /** Switchboard session id (not the SDK session id). */
  sessionId: string
  projectPath: string
  /** Referenced folders (REFS chips) granted as additional directories. */
  refDirs?: string[]
  /** Settings → Sandbox memory: the bypass container's --memory cap. */
  sandboxMemory?: string
  /** SDK session id of a prior conversation to resume (R2). */
  resumeSdkSessionId?: string
  /** Switchboard id of the session that conversation belongs to. A containerised
   *  resume needs it to open the ancestor's home volume, where the transcript the
   *  SDK is being asked to resume actually lives (see homeVolumeFor). */
  resumeFromSessionId?: string
  /** Isolated-verify suites only: key the node_modules volume to the verify
   *  RUN rather than this session, so every suite in that run shares one
   *  `npm ci` instead of each container paying its own. Forwarded verbatim to
   *  sandboxSpawn — see that parameter's own comment for why this is safe only
   *  because runSuitesIsolated runs its sessions strictly one at a time.
   *  Every other caller omits it and gets sandboxSpawn's per-session default. */
  nodeModulesVolumeKey?: string
  systemPromptAppend?: string
  /** Path to the bundled standalone Claude executable (avoids the Electron spawn crash). */
  claudeExecutablePath?: string
  /** The model the MAIN LOOP runs for this whole session — the intelligent
   *  model, or the worker model in Advisor mode. Fixed for the session because
   *  changing it mid-flight invalidates every prompt-cache tier (mainLoopModel).
   *  Omitted/'default' uses the account default. */
  mainModel?: string
  /** Cheaper model id for the `worker` subagent; falls back to the main model. */
  workerModel?: string
  /** The intelligent model, for the `advisor` subagent. In Advisor mode this is
   *  the tier the main loop is NOT running; elsewhere it matches mainModel. */
  strongModel?: string
  /** Report the pairing pattern per message (and apply the pinned main model).
   *  Off leaves the session on whatever model it started with. */
  autoModelRouting?: boolean
  /** Advisor/Orchestrator pairing mode; 'auto' picks per message by workload. */
  modelMode?: ModelMode
  /** The current model routing from Settings, re-read before every turn so a
   *  change in Settings reaches this running session (see refreshModelRouting). */
  resolveModels?: () => {
    intelligentModel: string
    workerModel: string
    modelMode: ModelMode
    autoModelRouting: boolean
  }
  /** Pairing mode chosen for the latest work turn (header chip); null = plan turn. */
  onTurnMode?: (mode: 'advisor' | 'orchestrator' | null) => void
  /**
   * The mode this session spawns in, already resolved by the manager from the
   * request and the project's own default. One value, not two separate booleans
   * (see resolvePermissionMode for why).
   */
  mode: SessionMode
  /**
   * Run the CLI in a disposable container, WITHOUT touching what it may do.
   *
   * These were one value until now: `bypass` meant both "runs in a container"
   * and "approves everything", read from the same predicate in two places, so a
   * containerised session could not keep normal permission gating. The sections
   * need exactly that combination — their work should not be able to disturb the
   * developer's own checkout, and it should still ask before it does something
   * that would need asking.
   *
   * Bypass still implies this, so nothing about a bypass session changes.
   */
  containerised?: boolean
  /** The live plan-mode state, whenever the CLI reports it or a toggle changes it. */
  onPlanModeChange?: (inPlanMode: boolean) => void
  /** Relabel a turn's closing message as ✦ SUMMARY (off = raw response). */
  summaries?: boolean
  sink: EventSink
  gate: PermissionGate
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  onSdkSessionId: (sdkSessionId: string) => void
  /** Available slash commands / skills reported in the session init message. */
  onCommands?: (commands: ProjectCommand[]) => void
  /** Subscription rate-limit usage from rate_limit_event (session usage meter). */
  onUsage?: (usage: { utilization: number | null; resetsAt: number | null; limitType: string | null }) => void
  /** Per-model usage for each finished turn (session totals, top-model chips). */
  onModelUsage?: (modelUsage: Record<string, import('./message-mapper').ModelTurnUsage>) => void
  /** Live background tasks (deep-research workflows, backgrounded subagents/bash)
   *  from the SDK's background_tasks_changed signal — REPLACE semantics. */
  onBackgroundTasks?: (tasks: { taskId: string; description: string }[]) => void
  /** MCP servers reported in the init message (sidebar MCP section). */
  onMcpServers?: (servers: McpServer[]) => void
  /** Model the SDK reports for each main-loop turn (header display). */
  onModel?: (model: string) => void
  /** Models this subscription can actually select (from the SDK's supportedModels),
   *  with SDK label/description — lets settings discover new models automatically. */
  onModels?: (models: AvailableModel[]) => void
  /** Fired after every completed turn (branch observation, counters). */
  onTurnComplete: () => void
  onExit: (reason: 'completed' | 'stopped' | 'crashed', detail?: string) => void
}

interface QueuedSend {
  eventId: string
  text: string
}

/**
 * Turn a bare process exit into something the developer can act on.
 *
 * The SDK reports only "Claude Code process exited with code N". For a bypass
 * session that N comes from a container, and 137 is the one that matters: it is
 * 128 + 9, a SIGKILL, which a process cannot explain itself because it was never
 * asked to exit. It leaves no stderr either, so the honest reading is that
 * something outside the process killed it, and inside a memory-limited WSL virtual
 * machine that is nearly always the kernel reclaiming memory.
 *
 * Named rather than relayed, because reporting an environment limit as the
 * developer's code crashing is the one thing this product forbids itself.
 */
export function explainExit(raw: string, containerised: boolean): string {
  const code = /exited with code (\d+)/.exec(raw)?.[1]
  if (code === '137') {
    return containerised
      ? 'The sandbox container was killed from outside the process: exit 137 is ' +
          'SIGKILL, so nothing inside it got to report why. It ran out of memory, and there ' +
          'are two ceilings it could have hit. The container runs with a limit of its own ' +
          '(6 GiB by default), so a build that genuinely needs more stops here rather than ' +
          'taking every other session down with it: raise it in Settings → Terminals → ' +
          'Sandbox memory (e.g. 12g; the SWITCHBOARD_SANDBOX_MEMORY environment variable ' +
          'still overrides it). If that is not it, the shared WSL virtual machine itself is ' +
          'too small — add a memory= line to %USERPROFILE%\\.wslconfig and restart Docker ' +
          'Desktop. The conversation is kept and resumes on the next start.'
      : 'The Claude Code process was killed from outside: exit 137 is SIGKILL, so it got ' +
          'no chance to report a reason. The host most likely ran out of memory.'
  }
  if (code === '13') {
    return 'The Claude Code process exited with code 13, which is Node reporting an ' +
      'unfinished top-level await: it waited on something that never arrived. Usually a ' +
      'broken or interrupted install of the CLI.'
  }
  return `Session process ended unexpectedly: ${raw}`
}

/**
 * The one permission mode a session spawns with. A straight map now that the app
 * carries a single SessionMode per project rather than two booleans that could
 * describe a state the SDK cannot spawn in; the only name that differs is
 * `bypass`, which the SDK spells `bypassPermissions`.
 *
 *  - `default` sends every tool call to the canUseTool gate, and so to the
 *    inbox. This is the SDK's own default and the one mode where the app's risk
 *    rules and decision history see every call.
 *  - `auto` hands the decision to the CLI's own model classifier. Note what that
 *    costs, because it is not the same as the app's autoApproveLow/Medium
 *    settings — those decide by the developer's risk rules and record every
 *    outcome in history, whereas this decides inside the CLI. The SDK groups it
 *    with bypassPermissions and acceptEdits as an "escalating" mode.
 *  - `acceptEdits` lets file edits through and still gates commands.
 *  - `plan` blocks execution until the model calls ExitPlanMode, which the broker
 *    routes to the inbox as a plan approval.
 *  - `bypass` approves everything and needs the dangerous-skip flag; the
 *    canUseTool gate is never invoked, and the session runs containerised.
 */
export function resolvePermissionMode(mode: SessionMode): PermissionMode {
  return mode === 'bypass' ? 'bypassPermissions' : mode
}

export class HostedSession {
  readonly sessionId: string
  private readonly options: HostedSessionOptions
  private readonly input = new AsyncPushQueue<SDKUserMessage>()
  private readonly mapper: MessageMapper
  private q: Query | null = null
  private turnInFlight = false
  /** Items blocking on the developer: permissions, plan approvals, questions. */
  private attentionCount = 0
  private queuedSends: QueuedSend[] = []
  private status: SessionStatus = 'working'
  private statusDetail: string | null = null
  /** Live background tasks (deep-research workflows, backgrounded subagents/bash)
   * from the SDK's background_tasks_changed level signal — REPLACE semantics. */
  private backgroundTasks: { taskId: string; description: string }[] = []
  private stopping = false
  private fatal = false
  /** The message loop, so stop() can await its real end (see stop()). */
  private runLoop: Promise<void> | undefined
  /** Set for a bypass session: its host→container mounts (see deliverNow). */
  private sandbox: SandboxPlan | null = null

  /** What this session may DO: bypass approves every tool call. */
  private get bypassing(): boolean {
    return this.options.mode === 'bypass'
  }

  /**
   * WHERE this session runs. No OS sandbox exists on native Windows, so a
   * container is the isolation boundary and its transcript lives in a container
   * volume.
   *
   * Separate from `bypassing` since 2026-08-12 (see the `containerised` option
   * above for why): bypass still implies this, but the reverse no longer holds.
   */
  private get containerised(): boolean {
    return this.options.containerised === true || this.bypassing
  }

  constructor(options: HostedSessionOptions) {
    this.sessionId = options.sessionId
    this.options = options
    this.mapper = new MessageMapper({
      sink: options.sink,
      onSdkSessionId: options.onSdkSessionId,
      summaries: options.summaries,
      onModelUsage: options.onModelUsage,
    })
  }

  start(): void {
    // A containerised session runs the CLI in a disposable Linux container: no
    // OS sandbox exists on native Windows, so the container is the isolation
    // boundary (wslc-sandbox.ts). Paths handed to the CLI must then be
    // container-side (/workspace, /refs/*), not host paths.
    const sandbox = this.containerised
      ? sandboxSpawn({
          sessionId: this.sessionId,
          projectPath: this.options.projectPath,
          refDirs: this.options.refDirs ?? [],
          sandboxMemory: this.options.sandboxMemory,
          resumeFromSessionId: this.options.resumeFromSessionId,
          nodeModulesVolumeKey: this.options.nodeModulesVolumeKey,
        })
      : null
    this.sandbox = sandbox
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.options.projectPath,
        includePartialMessages: true,
        resume: this.options.resumeSdkSessionId,
        pathToClaudeCodeExecutable: this.options.claudeExecutablePath,
        spawnClaudeCodeProcess: sandbox?.spawn,
        // Load user (~/.claude), project, and local settings — without this the
        // SDK loads NO filesystem settings, so global skills and commands
        // never appear in the CLI's command list.
        settingSources: ['user', 'project', 'local'],
        // Grant read/write within the project's own folder without prompting,
        // plus read access to any referenced folders (REFS chips).
        additionalDirectories: sandbox
          ? sandbox.additionalDirectories
          : [this.options.projectPath, ...(this.options.refDirs ?? [])],
        // The session's one main-loop model; 'default'/undefined uses the
        // account default. Spawning on it means the very first turn is already
        // right, with no switch (and no cache write) on the way in.
        model:
          this.options.mainModel && this.options.mainModel !== 'default'
            ? this.options.mainModel
            : undefined,
        permissionMode: resolvePermissionMode(this.options.mode),
        allowDangerouslySkipPermissions: this.bypassing ? true : undefined,
        // Append-only: keeps Claude Code's own system prompt and adds this app's
        // own session shaping on top.
        systemPrompt: this.options.systemPromptAppend
          ? { type: 'preset', preset: 'claude_code', append: this.options.systemPromptAppend }
          : undefined,
        // Advisor/Orchestrator pairing agents: `advisor` on the strong model,
        // `worker` on the cheap one. These carry the tier the main loop is NOT
        // running, which is how the pairing stays cache-safe. Static per session;
        // the mode protocol in the system-prompt append says when to use each.
        agents: modeAgents({
          strongModel: this.options.strongModel ?? this.options.mainModel,
          cheapModel: this.options.workerModel,
          // basic registers none of them, so the loop cannot reach a second
          // model even if something in the prompt asked it to.
          mode: this.options.modelMode,
        }),
        canUseTool: (toolName, input, canUseToolOptions) =>
          this.options.gate({
            sessionId: this.sessionId,
            toolName,
            input,
            options: canUseToolOptions,
          }),
      },
    })
    // Kept rather than fire-and-forgotten: stop() has to await this, or app exit
    // races the loop's onExit (see stop()).
    this.runLoop = this.run()
    // Slash commands are available the moment the CLI boots — don't wait for
    // the init message (which only arrives with the first turn), so typing "/"
    // in a fresh session already lists every command and plugin skill.
    void this.q
      .supportedCommands()
      .then((commands) => {
        this.emitCommands(
          commands.map((c) => ({
            name: c.name,
            description: (c as { description?: string }).description || undefined,
          })),
        )
      })
      .catch(() => {
        // Older CLI without the control request — the init message still covers it.
      })
    // The models this subscription can select, so the settings picker follows the
    // account rather than a hardcoded list. A live session reports them for free;
    // model-catalog probes separately when Settings asks before any session ran.
    if (this.options.onModels) {
      void this.q
        .supportedModels()
        .then((models) => this.options.onModels?.(toAvailableModels(models)))
        .catch(() => {
          // Older CLI without supportedModels — the manager keeps what it had.
        })
    }
    this.recomputeStatus()
  }

  private async run(): Promise<void> {
    try {
      for await (const message of this.q as Query) {
        this.handleMessage(message)
      }
      if (this.fatal) return
      this.options.onExit(this.stopping ? 'stopped' : 'completed')
    } catch (error) {
      if (this.stopping) {
        this.options.onExit('stopped')
        return
      }
      const raw = error instanceof Error ? error.message : String(error)
      let detail = explainExit(raw, this.containerised)
      // A hard `docker run` failure (a bad mount, a name conflict, an invalid
      // --memory value) dies before anything inside the container starts, so
      // the SDK never gets a message shaped for explainExit's exit-137/exit-13
      // wording to read — that wording stays exactly as it was above, since it
      // is still the right diagnosis when there IS an SDK-shaped message.
      // `lastStderr()` (only set for a containerised session — see `sandbox`)
      // is the one other trace of what went wrong, previously only ever
      // console.error'd inside wslc-sandbox.ts and never seen by the
      // developer. Appended as further evidence, not a replacement, and
      // truncated: this is a supporting detail, not the headline.
      const sandboxTail = this.sandbox?.lastStderr().trim()
      if (sandboxTail) detail += `\n\nSandbox stderr: ${sandboxTail.slice(-500)}`
      this.fatal = true
      this.mapper.fatalError(detail)
      this.setStatus('error', detail)
      this.options.onExit('crashed', detail)
    }
  }

  private handleMessage(message: SDKMessage): void {
    this.captureInitCommands(message)
    this.captureInitMcp(message)
    this.captureBackgroundTasks(message)
    this.capturePermissionMode(message)
    this.captureModel(message)
    this.captureUsage(message)
    this.maybeDowngradeOnLimit(message)
    this.mapper.handle(message)
    if (message.type === 'result') {
      this.turnInFlight = false
      this.flushQueuedSends()
      this.recomputeStatus()
      this.options.onTurnComplete()
    }
  }

  private appliedModel: string | null = null

  /**
   * Re-read the model routing from Settings before a turn is delivered, so
   * changing a model, the pairing mode, or the routing toggle applies to THIS
   * running session and not only to the next one.
   *
   * Skipped once a usage limit has downgraded this session: that opt is
   * session-scoped and must survive, or the next turn would climb straight back
   * onto the limited model.
   *
   * ponytail: the `advisor`/`worker` SUBAGENT models are a query() option fixed
   * at spawn, so a change to them still applies from the next session start.
   */
  private downgraded = false
  private refreshModelRouting(): void {
    if (this.downgraded) return
    const next = this.options.resolveModels?.()
    if (!next) return
    this.options.mainModel = mainLoopModel(next.modelMode, next)
    this.options.workerModel = next.workerModel
    this.options.modelMode = next.modelMode
    this.options.autoModelRouting = next.autoModelRouting
  }

  /**
   * Apply the session's main-loop model before a turn, and report which pairing
   * pattern this message falls into.
   *
   * The model comes from the MODE, not the message, so it never changes turn to
   * turn (see mainLoopModel: switching it mid-session invalidates every
   * prompt-cache tier). The pairing pattern still varies per message — that only
   * changes which protocol the loop follows and which subagent it reaches for.
   *
   * Fire-and-forget (best-effort) so the send path stays synchronous — no await
   * window for a stop/interrupt to race.
   */
  private applyModelForTurn(text: string): void {
    if (!this.options.autoModelRouting) return
    const auto = classifyWorkload(text)
    // `basic` is excluded rather than assumed unreachable. It forces
    // autoModelRouting off, so this method already returned above — but the chip
    // it would otherwise set names a pairing protocol that basic does not run,
    // and a future change to that guard must not quietly start claiming one.
    const forced = this.options.modelMode
    const pinned = forced === 'advisor' || forced === 'orchestrator' ? forced : null
    const workload = pinned && auto !== 'plan' ? pinned : auto
    this.options.onTurnMode?.(workload === 'plan' ? null : workload)

    const model = this.options.mainModel
    const wanted = model && model !== 'default' ? model : undefined
    const target = wanted ?? '__default__'
    if (this.appliedModel === target) return // already on it — no cache to break
    this.appliedModel = target
    void this.q?.setModel(wanted).catch(() => {
      // Best-effort: an older CLI may not support runtime model switching.
    })
    this.applyEffortForModel(wanted)
  }

  /**
   * Reasoning effort for the main-loop model — 'xhigh', the level current
   * guidance names for coding and agentic work; Fable keeps its own default.
   * (Subagents are set separately: the worker runs 'low'. See effortForRole.)
   * Applied whenever the model changes: proactively from the routing path for an
   * explicit model, and from the SDK-reported model below for the
   * account-default case. Best-effort; an unsupported level silently downgrades.
   */
  private appliedEffort: 'xhigh' | 'low' | null | undefined = undefined
  private applyEffortForModel(modelId: string | undefined): void {
    const wanted = effortForRole('main', modelId)
    if (this.appliedEffort === wanted) return
    const nothingYet = this.appliedEffort === undefined
    this.appliedEffort = wanted
    // Nothing set yet and no override wanted → nothing to clear.
    if (nothingYet && wanted === null) return
    void this.q?.applyFlagSettings({ effortLevel: wanted }).catch(() => {
      // Older CLI without applyFlagSettings, or a model without effort support.
    })
  }

  /**
   * Switch this session into or out of plan mode without restarting it.
   *
   * Best-effort, like setModel: a CLI too old to switch modes at runtime keeps
   * the one it started in, and the next system message it reports corrects what
   * the app claims — which is why the reported mode, not the requested one, is
   * what the header reads.
   */
  /**
   * Re-read plugins from disk and report the commands that came back.
   *
   * A plugin is installed on the HOST, by the CLI, in a process that has nothing
   * to do with any running session (see plugin-install.ts). Nothing told the
   * sessions, and a session's command list is the only thing the app has: so a
   * successful install left every "Download to project" card exactly where it
   * was, still offering to install the plugin that had just been installed. The
   * only way out was starting a new session, which is not an obvious thing to
   * think of when a button appears to have done nothing.
   *
   * Failure is not reported: an older CLI without the control request leaves the
   * list as it was, which is where it would have been anyway.
   */
  async reloadPlugins(): Promise<void> {
    try {
      const result = await this.q?.reloadPlugins()
      if (!result) return
      this.emitCommands(
        result.commands.map((c) => ({
          name: c.name,
          description: (c as { description?: string }).description || undefined,
        })),
      )
    } catch {
      // Older CLI, or a session already shutting down.
    }
  }

  setPlanMode(enabled: boolean): void {
    // Leaving plan mode returns to the mode this session was started in, so a
    // visit to planning cannot silently change what the rest of the session may
    // do. A session whose own mode IS plan has nothing to return to, so it falls
    // back to the app default — which is what this did for every session before
    // the mode became a per-project choice.
    const own = this.options.mode
    const mode = enabled
      ? 'plan'
      : resolvePermissionMode(own === 'plan' ? DEFAULT_SESSION_MODE : own)
    void this.q?.setPermissionMode(mode).catch(() => {
      // Older CLI without runtime mode switching.
    })
  }

  /**
   * The permission mode the CLI itself reports.
   *
   * `init` always carries it, which is what catches a CLI that silently declined
   * the 'plan' this session asked to start in; `status` messages carry it later,
   * so a mode that changed underneath the app is corrected rather than assumed.
   */
  private lastPermissionMode: string | null = null
  private capturePermissionMode(message: SDKMessage): void {
    const msg = message as { type?: string; subtype?: string; permissionMode?: string }
    if (msg.type !== 'system') return
    if (msg.subtype !== 'init' && msg.subtype !== 'status') return
    if (!msg.permissionMode || msg.permissionMode === this.lastPermissionMode) return
    this.lastPermissionMode = msg.permissionMode
    this.options.onPlanModeChange?.(msg.permissionMode === 'plan')
  }

  /** Report the model the SDK actually used for the latest MAIN-LOOP turn
   *  (subagent turns carry parent_tool_use_id and must not overwrite it). */
  private lastModel: string | null = null
  private captureModel(message: SDKMessage): void {
    const msg = message as {
      type?: string
      parent_tool_use_id?: string | null
      message?: { model?: string }
    }
    if (msg.type !== 'assistant' || msg.parent_tool_use_id) return
    const model = msg.message?.model
    if (!model || model === this.lastModel) return
    this.lastModel = model
    // Effort follows the ACTUAL resolved model — reconciles the account-default
    // case the routing paths cannot classify (they only see 'default').
    this.applyEffortForModel(model)
    this.options.onModel?.(model)
    this.reconcileModel(model)
  }

  /**
   * The turn ran on a different model from the configured one. Say so, and put
   * the next turn back.
   *
   * Claude Code honours a skill's own `model:` frontmatter, and one of the
   * commands this app dispatches carries it: /speckit-implement-scaffold asks
   * for Fable 5. So a session configured for Opus genuinely runs a turn on
   * Fable, which is the skill working as written — and then stayed there,
   * because appliedModel still recorded what the APP last asked for, so the
   * next turn matched the cache and no setModel was sent. Settings said one
   * thing and every later turn ran on another, with nothing on screen
   * connecting the two.
   *
   * Clearing appliedModel re-asserts the configured model on the next turn,
   * which is what makes Settings authoritative without fighting the skill for
   * the turn it asked for.
   */
  private reconcileModel(reported: string): void {
    const wanted = this.options.mainModel
    if (!modelDeviation(reported, wanted)) return
    this.appliedModel = null
    this.options.sink.append('assistant_text', {
      text:
        `⚙ This turn ran on ${modelLabel(reported)}, not the ${modelLabel(wanted ?? 'default')} ` +
        'in Settings. A skill can name its own model and this one did; the next turn goes back ' +
        `to ${modelLabel(wanted ?? 'default')}.`,
      partial: false,
    })
  }

  private captureUsage(message: SDKMessage): void {
    if (!this.options.onUsage) return
    const evt = message as {
      type?: string
      rate_limit_info?: { utilization?: number; resetsAt?: number; rateLimitType?: string }
    }
    if (evt.type !== 'rate_limit_event' || !evt.rate_limit_info) return
    const info = evt.rate_limit_info
    this.options.onUsage({
      utilization: typeof info.utilization === 'number' ? info.utilization : null,
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
      limitType: info.rateLimitType ?? null,
    })
  }

  /**
   * When a turn fails because the current model's usage limit is reached, opt to
   * the next strongest model so the next message goes through, and tell the user.
   * Turn-level only (the SDK cannot switch models mid-turn); does NOT auto-resend
   * the failed prompt — that avoids any retry loop, the user just sends again on
   * the downgraded model. Walks one rung down per limit hit and stops at Haiku.
   *
   * ponytail: the trigger is a text heuristic (the SDK has no dedicated
   * limit-reached signal — a limit surfaces as a non-success result). Tune LIMIT
   * if the wording changes; a real signal would replace the regex.
   */
  private static readonly LIMIT =
    /\b(usage limit|rate[ -]?limit|too many requests|quota|limit reached|reset[s]? at|429)\b/i
  private maybeDowngradeOnLimit(message: SDKMessage): void {
    if (this.stopping || this.fatal) return
    const msg = message as { type?: string; subtype?: string; errors?: string[]; result?: string }
    if (msg.type !== 'result' || msg.subtype === 'success') return
    const text = [msg.result ?? '', ...(msg.errors ?? [])].join('\n')
    if (!HostedSession.LIMIT.test(text)) return

    const current = this.options.mainModel
    const next = nextStrongestModel(current)
    if (!next) {
      this.options.sink.append('assistant_text', {
        text: `⚙ Usage limit reached on ${modelLabel(current ?? 'default')} — no lower model to fall back to. Try again after the limit resets.`,
        partial: false,
      })
      return
    }
    this.options.mainModel = next
    this.downgraded = true // hold this rung: a settings re-read must not undo it
    this.appliedModel = null // force the next turn to apply the new model
    void this.q?.setModel(next).catch(() => {})
    this.applyEffortForModel(next)
    this.options.onModel?.(next)
    this.options.sink.append('assistant_text', {
      text: `⚙ Usage limit reached — switched this session to ${modelLabel(next)} to keep going. Send your message again.`,
      partial: false,
    })
  }

  /**
   * Track live background work (a /deep-research workflow, a backgrounded
   * subagent or bash) so a finished foreground turn does not read as an idle
   * session while that work is still running. Level signal, REPLACE semantics.
   */
  private captureBackgroundTasks(message: SDKMessage): void {
    const msg = message as {
      type?: string
      subtype?: string
      tasks?: { task_id?: string; description?: string }[]
    }
    if (msg.type !== 'system' || msg.subtype !== 'background_tasks_changed' || !Array.isArray(msg.tasks)) {
      return
    }
    this.backgroundTasks = msg.tasks.map((t) => ({
      taskId: t.task_id ?? '',
      description: t.description ?? '',
    }))
    this.options.onBackgroundTasks?.(this.backgroundTasks)
    this.recomputeStatus()
  }

  /** Descriptions seen so far, by command name — an init message only carries
   * names, and must not wipe the hints supportedCommands() already gave us. */
  private commandDescriptions = new Map<string, string>()

  /**
   * Report the session's commands and skills, merging with what has already been
   * seen unless the CLI has explicitly replaced the set.
   *
   * The merge is the fix for a real bug. Two independent sources report at boot:
   * the supportedCommands() control request, and the 'init' system message's
   * slash_commands plus skills. Each used to rebuild the list from its own batch
   * alone, and every call writes through to a repository that overwrites the
   * whole row, so whichever resolved LAST silently erased the other. A plugin
   * whose six skills arrived in one source and one command in the other showed
   * exactly one of the seven, which read as "the plugin only ships one command"
   * and sent five Cleanup rows to "Not available" that were installed all along.
   *
   * `replace` is true only for a genuine 'commands_changed' frame, whose own
   * contract is that the client replaces its cached list — otherwise a command a
   * plugin really did remove could never disappear.
   */
  private emitCommands(commands: ProjectCommand[], replace = false): void {
    if (replace) this.commandDescriptions.clear()
    const byName = new Map<string, ProjectCommand>()
    for (const raw of commands) {
      // Trimmed on the way in. These names come from the CLI's own init message
      // and are inserted verbatim into the composer when one is chosen, so any
      // padding it reports for its own column layout would arrive as trailing
      // whitespace in a message about to be sent.
      const name = raw.name?.trim()
      const c = { ...raw, name }
      if (!name || byName.has(name)) continue
      if (c.description) this.commandDescriptions.set(name, c.description)
      byName.set(name, {
        name,
        description: c.description ?? this.commandDescriptions.get(name),
      })
    }
    // Everything seen earlier that this batch did not mention. commandDescriptions
    // already accumulates every name ever reported, so it is the record of what
    // the other source said and no second structure is needed.
    if (!replace) {
      for (const [name, description] of this.commandDescriptions) {
        if (!byName.has(name)) byName.set(name, { name, description: description || undefined })
      }
    }
    // A name with no description still has to be remembered, or a source that
    // reports bare names (the init message does) contributes nothing to the
    // merge above and the erasure comes straight back.
    for (const name of byName.keys()) {
      if (!this.commandDescriptions.has(name)) this.commandDescriptions.set(name, '')
    }
    const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    if (list.length > 0) this.options.onCommands?.(list)
  }

  /** MCP servers arrive in the same 'system'/'init' frame as slash commands. */
  private captureInitMcp(message: SDKMessage): void {
    if (!this.options.onMcpServers) return
    const msg = message as {
      type?: string
      subtype?: string
      mcp_servers?: { name?: string; status?: string }[]
    }
    if (msg.type !== 'system' || msg.subtype !== 'init' || !Array.isArray(msg.mcp_servers)) return
    const servers: McpServer[] = msg.mcp_servers
      .filter((s): s is { name: string; status?: string } => typeof s?.name === 'string')
      .map((s) => ({ name: s.name, status: s.status ?? 'unknown' }))
    this.options.onMcpServers(servers)
  }

  private captureInitCommands(message: SDKMessage): void {
    if (!this.options.onCommands) return
    const msg = message as {
      type?: string
      subtype?: string
      slash_commands?: string[]
      skills?: string[]
      commands?: { name: string; description?: string }[]
    }
    if (msg.type !== 'system') return
    // Mid-session change (skills discovered while working): REPLACE semantics,
    // which is the ONE case that may drop a name the other source reported.
    if (msg.subtype === 'commands_changed' && msg.commands) {
      this.emitCommands(msg.commands, true)
      return
    }
    if (msg.subtype !== 'init') return
    this.emitCommands(
      [...(msg.slash_commands ?? []), ...(msg.skills ?? [])].map((name) => ({ name })),
    )
  }

  /** Composer input (FR-019). Returns queued=true when the send awaits turn completion. */
  send(text: string): { queued: boolean; deliver: (eventId: string) => void } {
    const queued = this.turnInFlight
    return {
      queued,
      deliver: (eventId: string) => {
        if (queued) {
          this.queuedSends.push({ eventId, text })
        } else {
          this.deliverNow(eventId, text)
        }
      },
    }
  }

  private deliverNow(eventId: string, text: string): void {
    // A container session sees /workspace and /refs/*, never a Windows path. The
    // composer appends `@<host path>` per REFS chip and developers paste host
    // paths freely, so translate here — the one point every send passes through.
    if (this.sandbox) text = toContainerPaths(text, this.sandbox.mounts)
    // Route the model for this turn's intent before the message enters the
    // stream (best-effort setModel, not awaited — keeps this synchronous).
    this.refreshModelRouting()
    this.applyModelForTurn(text)
    this.options.sink.update(eventId, { text, pending: false }, { persist: true })
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)
    this.turnInFlight = true
    this.recomputeStatus()
  }

  private flushQueuedSends(): void {
    const next = this.queuedSends.shift()
    if (next) this.deliverNow(next.eventId, next.text)
  }

  /**
   * Rewords a message still waiting for the turn to finish, or withdraws it when
   * `text` is empty. Returns false when it has already gone.
   *
   * A queued send is written before the work in front of it has finished, so by
   * the time its turn comes the developer often knows something they did not. The
   * same reasoning that put in-place editing on the planned-task queue applies
   * here, and empty-means-remove is the convention that queue already set.
   *
   * The false return is the important part rather than an afterthought. This races
   * the turn ending: `flushQueuedSends` can deliver the message between the
   * developer opening the editor and saving it, and at that point the session has
   * already been told. Reporting that plainly lets the caller say so, where
   * silently succeeding would leave them believing they had changed what ran.
   */
  editQueuedSend(eventId: string, text: string): boolean {
    const at = this.queuedSends.findIndex((q) => q.eventId === eventId)
    if (at === -1) return false
    const trimmed = text.trim()
    if (!trimmed) {
      const [withdrawn] = this.queuedSends.splice(at, 1)
      this.options.sink.update(
        eventId,
        { text: withdrawn.text, pending: false, withdrawn: true },
        { persist: true },
      )
    } else {
      this.queuedSends[at] = { eventId, text: trimmed }
      this.options.sink.update(eventId, { text: trimmed, pending: true }, { persist: true })
    }
    return true
  }

  /** SDK interrupt (FR-019a); reports composer messages still queued locally. */
  async interrupt(): Promise<{ stillQueued: number }> {
    try {
      await this.q?.interrupt()
    } catch {
      // The turn may already be over; interrupt is best-effort.
    }
    this.turnInFlight = false
    this.recomputeStatus()
    return { stillQueued: this.queuedSends.length }
  }

  /** Graceful end (FR-019a): close the input stream and let the run loop finish. */
  async stop(): Promise<void> {
    this.stopping = true
    this.input.end()
    if (this.turnInFlight) {
      try {
        await this.q?.interrupt()
      } catch {
        // Ending anyway.
      }
    }
    // Wait for the for-await loop to actually drain, not just for the interrupt
    // to be acknowledged. Without this, stop() resolved while the loop was still
    // running, so endAllForAppExit() finalised the row and let db.close() and
    // app.quit() proceed — and the loop's onExit then wrote to a closed handle.
    //
    // Bounded, because a hung CLI must not hold the app open: past the grace
    // period we stop waiting and quit anyway. A late onExit after that is
    // harmless, since finaliseRow ignores an already-finalised row.
    //
    // The grace timer gets its own AbortController, aborted the instant the
    // race settles: an ordinary FAST stop (the loop drains well inside 5s,
    // the common case) used to leave this timer running uncancelled in the
    // background for the rest of the grace period, for no reason once its side
    // of the race had already lost. The `.catch` sits on the delay itself, not
    // on the race: aborting AFTER runLoop has already won makes the delay
    // promise reject, and by then Promise.race is no longer awaiting either of
    // its inputs — an unhandled rejection unless something already had a
    // handler attached.
    const abort = new AbortController()
    const grace = delay(EXIT_GRACE_MS, undefined, { signal: abort.signal }).catch(() => {
      // Rejects on abort (runLoop won the race) or resolves on timeout (it
      // didn't) — either way there is nothing left to act on here.
    })
    try {
      await Promise.race([this.runLoop, grace])
    } finally {
      abort.abort()
    }
  }

  /** Composer messages never delivered; preserved as drafts on app exit. */
  takeQueuedSends(): QueuedSend[] {
    return this.queuedSends.splice(0)
  }

  get isMidTask(): boolean {
    return this.turnInFlight || this.attentionCount > 0
  }

  get currentStatus(): SessionStatus {
    return this.status
  }

  /** Called by the permission broker when an item starts/stops blocking on the developer. */
  attentionRaised(): void {
    this.attentionCount += 1
    this.recomputeStatus()
  }

  attentionCleared(): void {
    this.attentionCount = Math.max(0, this.attentionCount - 1)
    this.recomputeStatus()
  }

  private recomputeStatus(): void {
    if (this.fatal) return
    if (this.attentionCount > 0) return this.setStatus('needs_you')
    if (this.turnInFlight) return this.setStatus('working')
    // The foreground turn is idle, but background work keeps the session busy:
    // stay 'working' (with an honest detail) rather than reporting 'done'.
    if (this.backgroundTasks.length > 0) return this.setStatus('working', this.backgroundDetail())
    this.setStatus('done')
  }

  private backgroundDetail(): string {
    const count = this.backgroundTasks.length
    if (count === 1) {
      const description = this.backgroundTasks[0].description.trim()
      return description ? `Running in background: ${description}` : 'Running a background task…'
    }
    return `${count} background tasks running…`
  }

  private setStatus(status: SessionStatus, detail: string | null = null): void {
    if (this.status === status && this.statusDetail === detail) return
    this.status = status
    this.statusDetail = detail
    this.options.onStatusChange(status, detail)
  }
}
