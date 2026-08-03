// Wrapper around one Agent SDK `query()` run: streaming input, composer
// queueing (FR-019), interrupt/stop (FR-019a), status derivation
// (contracts/session-events.md) and process-death detection (FR-004, FR-006).
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { modelLabel, type AvailableModel, type McpServer, type ModelMode, type ProjectCommand, type SessionStatus } from '@shared/domain'
import { sandboxSpawn, toContainerPaths, type SandboxPlan } from './docker-sandbox'
import { MessageMapper, type EventSink } from './message-mapper'
import { toAvailableModels } from './model-catalog'
import { classifyWorkload, effortForRole, mainLoopModel, nextStrongestModel } from './model-routing'
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
 * Re-exported so the rest of the main process never imports the SDK itself.
 *
 * `src/main/sessions/` is the SDK's only home (CLAUDE.md), and the permission
 * broker needs this one type because it IS what a gate resolves to. Surfacing it
 * here keeps the boundary real: an SDK upgrade that renames or reshapes this type
 * lands in this directory, not scattered across the inbox.
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
  /** Owning project; scopes the sandbox's persisted container home per project. */
  projectId: string
  projectPath: string
  /** Referenced folders (REFS chips) granted as additional directories. */
  refDirs?: string[]
  /** Settings → Sandbox memory: the bypass container's --memory cap. */
  sandboxMemory?: string
  /** SDK session id of a prior conversation to resume (R2). */
  resumeSdkSessionId?: string
  /** Terse-mode instruction appended to the Claude Code system prompt, if enabled. */
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
  /** Bypass all permission checks for this session (auto-approve every tool). */
  bypassPermissions?: boolean
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
export function explainExit(raw: string, bypass: boolean): string {
  const code = /exited with code (\d+)/.exec(raw)?.[1]
  if (code === '137') {
    return bypass
      ? 'The bypass sandbox container was killed from outside the process: exit 137 is ' +
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
    // Bypass sessions run the CLI in a disposable Linux container: no OS
    // sandbox exists on native Windows, so the container is the isolation
    // boundary (docker-sandbox.ts). Paths handed to the CLI must then be
    // container-side (/workspace, /refs/*), not host paths.
    const sandbox = this.options.bypassPermissions
      ? sandboxSpawn({
          sessionId: this.sessionId,
          projectId: this.options.projectId,
          projectPath: this.options.projectPath,
          refDirs: this.options.refDirs ?? [],
          sandboxMemory: this.options.sandboxMemory,
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
        // Bypass mode auto-approves every tool (no inbox prompts); requires the
        // dangerous-skip flag. The canUseTool gate simply is never invoked then.
        permissionMode: this.options.bypassPermissions ? 'bypassPermissions' : 'default',
        allowDangerouslySkipPermissions: this.options.bypassPermissions ? true : undefined,
        // Append-only: keeps Claude Code's own system prompt and adds the terse
        // output-style instruction on top when terse mode is enabled.
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
    this.setStatus('done')
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
      const detail = explainExit(raw, this.options.bypassPermissions === true)
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
   * Apply the session's main-loop model before a turn is delivered, and report
   * which pairing pattern this message falls into.
   *
   * The model comes from the MODE, not the message, and therefore does not
   * change from turn to turn: switching the main-loop model mid-session
   * invalidates the tools, system, AND message prompt-cache tiers, so the whole
   * conversation prefix is re-written at the cache-write rate on the next turn.
   * The cheap tier is reached through the `worker` subagent, which keeps its own
   * context. The pairing pattern still varies per message — that only changes
   * which protocol the loop follows and which subagent it reaches for.
   *
   * Fire-and-forget (best-effort) so the send path stays synchronous — no await
   * window for a stop/interrupt to race.
   */
  private applyModelForTurn(text: string): void {
    if (!this.options.autoModelRouting) return
    const auto = classifyWorkload(text)
    const workload =
      this.options.modelMode && this.options.modelMode !== 'auto' && auto !== 'plan'
        ? this.options.modelMode
        : auto
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

  private emitCommands(commands: ProjectCommand[]): void {
    const byName = new Map<string, ProjectCommand>()
    for (const c of commands) {
      if (!c.name || byName.has(c.name)) continue
      if (c.description) this.commandDescriptions.set(c.name, c.description)
      byName.set(c.name, {
        name: c.name,
        description: c.description ?? this.commandDescriptions.get(c.name),
      })
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
    // Mid-session change (skills discovered while working): REPLACE semantics.
    if (msg.subtype === 'commands_changed' && msg.commands) {
      this.emitCommands(msg.commands)
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
    await Promise.race([
      this.runLoop,
      new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS)),
    ])
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
