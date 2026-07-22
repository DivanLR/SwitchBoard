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
import type { McpServer, ProjectCommand, SessionStatus } from '@shared/domain'
import { MessageMapper, type EventSink } from './message-mapper'
import { classifyIntent } from './model-routing'

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

export type CanUseToolOptions = Parameters<CanUseTool>[2]

/** The permission broker's entry point, bound per session by the manager (R3). */
export type PermissionGate = (context: {
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  options: CanUseToolOptions
}) => Promise<PermissionResult>

export interface HostedSessionOptions {
  /** Switchboard session id (not the SDK session id). */
  sessionId: string
  projectPath: string
  /** Referenced folders (REFS chips) granted as additional directories. */
  refDirs?: string[]
  /** SDK session id of a prior conversation to resume (R2). */
  resumeSdkSessionId?: string
  /** Terse-mode instruction appended to the Claude Code system prompt, if enabled. */
  systemPromptAppend?: string
  /** Path to the bundled standalone Claude executable (avoids the Electron spawn crash). */
  claudeExecutablePath?: string
  /** Model id for work turns; omitted/'default' uses the account default. */
  workModel?: string
  /** Cheaper model id for work-classified turns under auto routing; falls back
   *  to workModel when unset. */
  workerModel?: string
  /** Model id for plan-mode turns; applied via setModel when entering plan mode. */
  planModel?: string
  /** Route each message by intent (question→planModel, code→workModel) instead
   *  of by the plan-mode toggle. */
  autoModelRouting?: boolean
  /** Bypass all permission checks for this session (auto-approve every tool). */
  bypassPermissions?: boolean
  sink: EventSink
  gate: PermissionGate
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  onSdkSessionId: (sdkSessionId: string) => void
  /** Available slash commands / skills reported in the session init message. */
  onCommands?: (commands: ProjectCommand[]) => void
  /** Subscription rate-limit usage from rate_limit_event (session usage meter). */
  onUsage?: (usage: { utilization: number | null; resetsAt: number | null; limitType: string | null }) => void
  /** MCP servers reported in the init message (sidebar MCP section). */
  onMcpServers?: (servers: McpServer[]) => void
  /** Model the SDK reports for each main-loop turn (header display). */
  onModel?: (model: string) => void
  /** Fired after every completed turn (branch observation, counters). */
  onTurnComplete: () => void
  onExit: (reason: 'completed' | 'stopped' | 'crashed', detail?: string) => void
}

interface QueuedSend {
  eventId: string
  text: string
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

  constructor(options: HostedSessionOptions) {
    this.sessionId = options.sessionId
    this.options = options
    this.mapper = new MessageMapper({
      sink: options.sink,
      onSdkSessionId: options.onSdkSessionId,
    })
  }

  start(): void {
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.options.projectPath,
        includePartialMessages: true,
        resume: this.options.resumeSdkSessionId,
        pathToClaudeCodeExecutable: this.options.claudeExecutablePath,
        // Load user (~/.claude), project, and local settings — without this the
        // SDK loads NO filesystem settings, so global skills and commands
        // never appear in the CLI's command list.
        settingSources: ['user', 'project', 'local'],
        // Grant read/write within the project's own folder without prompting,
        // plus read access to any referenced folders (REFS chips).
        additionalDirectories: [this.options.projectPath, ...(this.options.refDirs ?? [])],
        // Work model for normal turns; 'default'/undefined uses the account default.
        model:
          this.options.workModel && this.options.workModel !== 'default'
            ? this.options.workModel
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
        canUseTool: (toolName, input, canUseToolOptions) =>
          this.options.gate({
            sessionId: this.sessionId,
            toolName,
            input,
            options: canUseToolOptions,
          }),
      },
    })
    void this.run()
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
      const detail = error instanceof Error ? error.message : String(error)
      this.fatal = true
      this.mapper.fatalError(`Session process ended unexpectedly: ${detail}`)
      this.setStatus('error', detail)
      this.options.onExit('crashed', detail)
    }
  }

  private handleMessage(message: SDKMessage): void {
    this.captureInitCommands(message)
    this.captureInitMcp(message)
    this.captureBackgroundTasks(message)
    // Intent routing owns the model per message (see deliverNow); the mode-based
    // switch would otherwise fight it, so run only one of the two.
    if (!this.options.autoModelRouting) this.applyModelForMode(message)
    this.captureModel(message)
    this.captureUsage(message)
    this.mapper.handle(message)
    if (message.type === 'result') {
      this.turnInFlight = false
      this.flushQueuedSends()
      this.recomputeStatus()
      this.options.onTurnComplete()
    }
  }

  /** Switch to the plan model while a session is in plan mode, else the work model. */
  private appliedModel: string | null = null
  private applyModelForMode(message: SDKMessage): void {
    const mode = (message as { permissionMode?: string }).permissionMode
    if (!mode) return
    const norm = (m?: string): string | undefined => (m && m !== 'default' ? m : undefined)
    const wanted =
      mode === 'plan' ? norm(this.options.planModel) : norm(this.options.workModel)
    const target = wanted ?? '__default__'
    if (this.appliedModel === target) return
    this.appliedModel = target
    void this.q?.setModel(wanted).catch(() => {
      // Best-effort: an older CLI may not support runtime model switching.
    })
  }

  /** Pick the model for the turn about to start from the message's intent.
   *  Fire-and-forget (best-effort), exactly like applyModelForMode, so the send
   *  path stays synchronous — no await window for a stop/interrupt to race. */
  private applyModelForIntent(text: string): void {
    if (!this.options.autoModelRouting) return
    const norm = (m?: string): string | undefined => (m && m !== 'default' ? m : undefined)
    const intent = classifyIntent(text)
    // Work-classified turns prefer the cheaper per-project worker model when set.
    const wanted =
      intent === 'plan'
        ? norm(this.options.planModel)
        : (norm(this.options.workerModel) ?? norm(this.options.workModel))
    const target = wanted ?? '__default__'
    if (this.appliedModel === target) return
    this.appliedModel = target
    void this.q?.setModel(wanted).catch(() => {
      // Best-effort: an older CLI may not support runtime model switching.
    })
  }

  /** Report the model the SDK actually used for the latest MAIN-LOOP turn
   *  (subagent turns carry parent_tool_use_id and must not overwrite it). */
  private lastModel: string | null = null
  private captureModel(message: SDKMessage): void {
    if (!this.options.onModel) return
    const msg = message as {
      type?: string
      parent_tool_use_id?: string | null
      message?: { model?: string }
    }
    if (msg.type !== 'assistant' || msg.parent_tool_use_id) return
    const model = msg.message?.model
    if (!model || model === this.lastModel) return
    this.lastModel = model
    this.options.onModel(model)
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
    // Route the model for this turn's intent before the message enters the
    // stream (best-effort setModel, not awaited — keeps this synchronous).
    this.applyModelForIntent(text)
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
