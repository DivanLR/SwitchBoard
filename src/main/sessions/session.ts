import { setTimeout as delay } from 'node:timers/promises'
import {
  query,
  type CanUseTool,
  type HookJSONOutput,
  type McpServerConfig,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  DEFAULT_SESSION_MODE,
  DEFAULT_SETTINGS,
  modelLabel,
  subagentsAllowed,
  type AvailableModel,
  type EffortLevel,
  type McpServer,
  type ModelMode,
  type ProjectCommand,
  type SessionMode,
  type SessionStatus,
} from '@shared/domain'
import { MessageMapper, type EventSink } from './message-mapper'
import { toAvailableModels } from './model-catalog'
import {
  classifyWorkload,
  mainLoopModel,
  modelDeviation,
  nextStrongestModel,
} from './model-routing'
import { modeAgents } from './session-shaping'

const EXIT_GRACE_MS = 5_000

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

export type { PermissionResult }

export type PermissionGate = (context: {
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  options: CanUseToolOptions
}) => Promise<PermissionResult>

interface HostedSessionOptions {
  sessionId: string
  projectPath: string
  refDirs?: string[]
  resumeSdkSessionId?: string
  systemPromptAppend?: string
  claudeExecutablePath?: string
  mainModel?: string
  workerMainLoop?: boolean
  workerModel?: string
  strongModel?: string
  autoModelRouting?: boolean
  modelMode?: ModelMode
  effort?: EffortLevel
  subagents?: boolean
  subagentEffort?: EffortLevel
  resolveModels?: () => {
    intelligentModel: string
    workerModel: string
    modelMode: ModelMode
    autoModelRouting: boolean
    effort: EffortLevel
  }
  onTurnMode?: (mode: 'advisor' | 'orchestrator' | null) => void
  mode: SessionMode
  onPlanModeChange?: (inPlanMode: boolean) => void
  summaries?: boolean
  sink: EventSink
  gate: PermissionGate
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  onSdkSessionId: (sdkSessionId: string) => void
  onCommands?: (commands: ProjectCommand[]) => void
  onUsage?: (usage: { utilization: number | null; resetsAt: number | null; limitType: string | null }) => void
  onModelUsage?: (modelUsage: Record<string, import('./message-mapper').ModelTurnUsage>) => void
  onBackgroundTasks?: (tasks: { taskId: string; description: string }[]) => void
  onMcpServers?: (servers: McpServer[]) => void
  mcpServers?: Record<string, McpServerConfig>
  onModel?: (model: string) => void
  onModels?: (models: AvailableModel[]) => void
  onTurnComplete: () => void
  onExit: (reason: 'completed' | 'stopped' | 'crashed', detail?: string) => void
}

export interface QueuedSend {
  eventId: string
  text: string
}

export interface SessionHost {
  start(): void
  send(text: string): { queued: boolean; deliver: (eventId: string) => void }
  editQueuedSend(eventId: string, text: string): boolean
  interrupt(): Promise<{ stillQueued: number }>
  stop(): Promise<void>
  takeQueuedSends(): QueuedSend[]
  readonly isMidTask: boolean
  readonly currentStatus: SessionStatus
  attentionRaised(): void
  attentionCleared(): void
  clearBackgroundTasks(): void
  setPlanMode(enabled: boolean): void
  reloadPlugins(): Promise<void>
}

export function explainExit(raw: string): string {
  const code = /exited with code (\d+)/.exec(raw)?.[1]
  if (code === '137') {
    return 'The Claude Code process was killed from outside: exit 137 is SIGKILL, so it got ' +
      'no chance to report a reason. The host most likely ran out of memory.'
  }
  if (code === '13') {
    return 'The Claude Code process exited with code 13, which is Node reporting an ' +
      'unfinished top-level await: it waited on something that never arrived. Usually a ' +
      'broken or interrupted install of the CLI.'
  }
  return `Session process ended unexpectedly: ${raw}`
}

export function resolvePermissionMode(mode: SessionMode): PermissionMode {
  return mode
}

export class HostedSession implements SessionHost {
  readonly sessionId: string
  private readonly options: HostedSessionOptions
  private readonly input = new AsyncPushQueue<SDKUserMessage>()
  private readonly mapper: MessageMapper
  private q: Query | null = null
  private turnInFlight = false
  private attentionCount = 0
  private queuedSends: QueuedSend[] = []
  private status: SessionStatus = 'working'
  private statusDetail: string | null = null
  private backgroundTasks: { taskId: string; description: string }[] = []
  private stopping = false
  private fatal = false
  private runLoop: Promise<void> | undefined

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
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.options.projectPath,
        includePartialMessages: true,
        resume: this.options.resumeSdkSessionId,
        pathToClaudeCodeExecutable: this.options.claudeExecutablePath,
        settingSources: ['user', 'project', 'local'],
        additionalDirectories: [this.options.projectPath, ...(this.options.refDirs ?? [])],
        model:
          this.options.mainModel && this.options.mainModel !== 'default'
            ? this.options.mainModel
            : undefined,
        mcpServers: this.options.mcpServers,
        permissionMode: resolvePermissionMode(this.options.mode),
        systemPrompt: this.options.systemPromptAppend
          ? { type: 'preset', preset: 'claude_code', append: this.options.systemPromptAppend }
          : undefined,
        agents: modeAgents({
          strongModel: this.options.strongModel ?? this.options.mainModel,
          cheapModel: this.options.workerModel,
          mode: this.options.subagents === false ? 'basic' : this.options.modelMode,
          effort: this.options.subagentEffort,
        }),
        canUseTool: (toolName, input, canUseToolOptions) =>
          this.options.gate({
            sessionId: this.sessionId,
            toolName,
            input,
            options: canUseToolOptions,
          }),
        hooks: {
          PreToolUse: [{ matcher: 'Agent|Task', hooks: [() => this.gateSubagents()] }],
        },
      },
    })
    this.runLoop = this.run()
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
      })
    if (this.options.onModels) {
      void this.q
        .supportedModels()
        .then((models) => this.options.onModels?.(toAvailableModels(models)))
        .catch(() => {
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
      const detail = explainExit(raw)
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

  private downgraded = false
  private refreshModelRouting(): void {
    const next = this.options.resolveModels?.()
    if (!next) return
    this.options.effort = next.effort
    if (this.downgraded) return
    this.options.mainModel = this.options.workerMainLoop
      ? next.workerModel
      : mainLoopModel(next.modelMode, next)
    this.options.workerModel = next.workerModel
    this.options.modelMode = next.modelMode
    this.options.autoModelRouting = next.autoModelRouting
  }

  private applyModelForTurn(text: string): void {
    if (!this.options.autoModelRouting) return
    const auto = classifyWorkload(text)
    const forced = this.options.modelMode
    const pinned = forced === 'advisor' || forced === 'orchestrator' ? forced : null
    const workload = pinned && auto !== 'plan' ? pinned : auto
    this.options.onTurnMode?.(workload === 'plan' ? null : workload)

    const model = this.options.mainModel
    const wanted = model && model !== 'default' ? model : undefined
    const target = wanted ?? '__default__'
    if (this.appliedModel === target) return 
    this.appliedModel = target
    void this.q?.setModel(wanted).catch(() => {
    })
  }

  private currentEffort(): EffortLevel {
    return this.options.resolveModels?.().effort ?? this.options.effort ?? DEFAULT_SETTINGS.effort
  }

  private appliedEffort: EffortLevel | undefined = undefined
  private applyEffort(wanted: EffortLevel): void {
    if (this.appliedEffort === wanted) return
    this.appliedEffort = wanted
    void this.q?.applyFlagSettings({ effortLevel: wanted }).catch(() => {
    })
  }

  private gateSubagents(): Promise<HookJSONOutput> {
    if (subagentsAllowed(this.currentEffort())) return Promise.resolve({})
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Subagents are only used at max effort in this app, and the Effort bar is below ' +
          'max. Do this work yourself, in this thread, without spawning agents.',
      },
    })
  }

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
    }
  }

  setPlanMode(enabled: boolean): void {
    const own = this.options.mode
    const mode = enabled
      ? 'plan'
      : resolvePermissionMode(own === 'plan' ? DEFAULT_SESSION_MODE : own)
    void this.q?.setPermissionMode(mode).catch(() => {
    })
  }

  private lastPermissionMode: string | null = null
  private capturePermissionMode(message: SDKMessage): void {
    const msg = message as { type?: string; subtype?: string; permissionMode?: string }
    if (msg.type !== 'system') return
    if (msg.subtype !== 'init' && msg.subtype !== 'status') return
    if (!msg.permissionMode || msg.permissionMode === this.lastPermissionMode) return
    this.lastPermissionMode = msg.permissionMode
    this.options.onPlanModeChange?.(msg.permissionMode === 'plan')
  }

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
    this.options.onModel?.(model)
    this.reconcileModel(model)
  }

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
    this.downgraded = true 
    this.appliedModel = null 
    void this.q?.setModel(next).catch(() => {})
    this.options.onModel?.(next)
    this.options.sink.append('assistant_text', {
      text: `⚙ Usage limit reached — switched this session to ${modelLabel(next)} to keep going. Send your message again.`,
      partial: false,
    })
  }

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

  private commandDescriptions = new Map<string, string>()

  private emitCommands(commands: ProjectCommand[], replace = false): void {
    if (replace) this.commandDescriptions.clear()
    const byName = new Map<string, ProjectCommand>()
    for (const raw of commands) {
      const name = raw.name?.trim()
      const c = { ...raw, name }
      if (!name || byName.has(name)) continue
      if (c.description) this.commandDescriptions.set(name, c.description)
      byName.set(name, {
        name,
        description: c.description ?? this.commandDescriptions.get(name),
      })
    }
    if (!replace) {
      for (const [name, description] of this.commandDescriptions) {
        if (!byName.has(name)) byName.set(name, { name, description: description || undefined })
      }
    }
    for (const name of byName.keys()) {
      if (!this.commandDescriptions.has(name)) this.commandDescriptions.set(name, '')
    }
    const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    if (list.length > 0) this.options.onCommands?.(list)
  }

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
    if (msg.subtype === 'commands_changed' && msg.commands) {
      this.emitCommands(msg.commands, true)
      return
    }
    if (msg.subtype !== 'init') return
    this.emitCommands(
      [...(msg.slash_commands ?? []), ...(msg.skills ?? [])].map((name) => ({ name })),
    )
  }

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
    this.refreshModelRouting()
    this.applyEffort(this.options.effort ?? DEFAULT_SETTINGS.effort)
    this.applyModelForTurn(text)
    this.options.sink.update(eventId, { text, pending: false }, { persist: true })
    this.mapper.noteDelivered(text)
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

  async interrupt(): Promise<{ stillQueued: number }> {
    try {
      await this.q?.interrupt()
    } catch {
    }
    this.turnInFlight = false
    this.recomputeStatus()
    return { stillQueued: this.queuedSends.length }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.input.end()
    if (this.turnInFlight) {
      try {
        await this.q?.interrupt()
      } catch {
      }
    }
    const abort = new AbortController()
    const grace = delay(EXIT_GRACE_MS, undefined, { signal: abort.signal }).catch(() => {
    })
    try {
      await Promise.race([this.runLoop, grace])
    } finally {
      abort.abort()
    }
  }

  takeQueuedSends(): QueuedSend[] {
    return this.queuedSends.splice(0)
  }

  get isMidTask(): boolean {
    return this.turnInFlight || this.attentionCount > 0
  }

  get currentStatus(): SessionStatus {
    return this.status
  }

  attentionRaised(): void {
    this.attentionCount += 1
    this.recomputeStatus()
  }

  attentionCleared(): void {
    this.attentionCount = Math.max(0, this.attentionCount - 1)
    this.recomputeStatus()
  }

  clearBackgroundTasks(): void {
    if (this.backgroundTasks.length === 0) return
    this.backgroundTasks = []
    this.options.onBackgroundTasks?.(this.backgroundTasks)
    this.recomputeStatus()
  }

  private recomputeStatus(): void {
    if (this.fatal) return
    if (this.attentionCount > 0) return this.setStatus('needs_you')
    if (this.turnInFlight) return this.setStatus('working')
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
