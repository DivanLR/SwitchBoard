import { setTimeout as delay } from 'node:timers/promises'
import {
  query,
  type AgentDefinition,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type HookInput,
  type HookJSONOutput,
  type McpServerConfig,
  type McpServerStatus,
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
import { sandboxSpawn, toContainerPaths, type SandboxPlan } from './wslc-sandbox'
import { MessageMapper, type EventSink } from './message-mapper'
import { toAvailableModels } from './model-catalog'
import { modelDeviation, nextStrongestModel } from './model-fallback'
import { classifyWorkload, mainLoopModel } from './model-routing'
import { jevRoute, type JevAnswer, type JevRoute } from './jev-router'

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

export type { ElicitationRequest, ElicitationResult, PermissionResult }

export type PermissionGate = (context: {
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  options: CanUseToolOptions
}) => Promise<PermissionResult>

export interface ToolCall {
  toolUseId: string
  tool: string
  input: Record<string, unknown>
}

export interface ElicitationGate {
  request(context: {
    sessionId: string
    request: ElicitationRequest
    signal: AbortSignal
    calls: ToolCall[]
  }): Promise<ElicitationResult>
  completed(sessionId: string, serverName: string, elicitationId: string): void
  toolFinished(sessionId: string, toolUseId: string): void
}

export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}__`
}

interface HostedSessionOptions {
  sessionId: string
  projectPath: string
  extraDirs?: string[]
  refDirs?: string[]
  sandboxMemory?: string
  resumeSdkSessionId?: string
  resumeFromSessionId?: string
  nodeModulesVolumeKey?: string
  systemPromptAppend?: string
  claudeExecutablePath?: string
  mainModel?: string
  downgraded?: boolean
  workerMainLoop?: boolean
  autoModelRouting?: boolean
  modelMode?: ModelMode
  effort?: EffortLevel
  resolveModels?: () => {
    intelligentModel: string
    workerModel: string
    modelMode: ModelMode
    autoModelRouting: boolean
    effort: EffortLevel
    jevSwitchLimit?: number
  }
  onTurnMode?: (mode: 'advisor' | 'orchestrator' | null) => void
  askJev?: (text: string) => Promise<JevAnswer>
  onRoute?: (route: JevRoute | null) => void
  mode: SessionMode
  containerised?: boolean
  denyTool?: (toolName: string, input: unknown) => string | null
  env?: Readonly<Record<string, string>>
  onPlanModeChange?: (inPlanMode: boolean) => void
  summaries?: boolean
  sink: EventSink
  gate: PermissionGate
  elicit?: ElicitationGate
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  onSdkSessionId: (sdkSessionId: string) => void
  onCommands?: (commands: ProjectCommand[]) => void
  onUsage?: (usage: { utilization: number | null; resetsAt: number | null; limitType: string | null }) => void
  onModelUsage?: (modelUsage: Record<string, import('./message-mapper').ModelTurnUsage>) => void
  onBackgroundTasks?: (tasks: { taskId: string; description: string }[]) => void
  onMcpServers?: (servers: McpServer[]) => void
  mcpServers?: Record<string, McpServerConfig>
  agents?: Record<string, AgentDefinition>
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
  readonly lastTurnError: string | null
  readonly limitModel?: string
  attentionRaised(): void
  attentionCleared(): void
  clearBackgroundTasks(): void
  setPlanMode(enabled: boolean): void
  reloadPlugins(): Promise<void>
  mcpServerStatus(): Promise<McpServerStatus[]>
  reconnectMcpServer(name: string): Promise<void>
  slashCommands?(): Promise<string[]>
}

export function explainExit(raw: string, containerised: boolean): string {
  const code = /exited with code (\d+)/.exec(raw)?.[1]
  if (code === '137') {
    return containerised
      ? 'The sandbox container was killed from outside the process: exit 137 is ' +
          'SIGKILL, so nothing inside it got to report why. It ran out of memory, and there ' +
          'are two ceilings it could have hit. The container runs with a limit of its own ' +
          '(6 GiB by default), so a build that genuinely needs more stops here rather than ' +
          'taking every other session down with it: raise it in Settings → Projects → ' +
          'Sandbox memory (e.g. 12g; the SWITCHBOARD_SANDBOX_MEMORY environment variable ' +
          'still overrides it). If that is not it, the shared WSL virtual machine itself is ' +
          'too small — add a memory= line to %USERPROFILE%\\.wslconfig and restart WSL. ' +
          'The conversation is kept and resumes on the next start.'
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

export function resolvePermissionMode(mode: SessionMode): PermissionMode {
  return mode === 'bypass' ? 'bypassPermissions' : mode
}

function isFailedResult(message: SDKMessage): boolean {
  const msg = message as { type?: string; subtype?: string; is_error?: boolean }
  return msg.type === 'result' && (msg.subtype !== 'success' || msg.is_error === true)
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
  private turnError: string | null = null
  private runLoop: Promise<void> | undefined
  private sandbox: SandboxPlan | null = null

  private get bypassing(): boolean {
    return this.options.mode === 'bypass'
  }

  private get containerised(): boolean {
    return this.options.containerised === true || this.bypassing
  }

  constructor(options: HostedSessionOptions) {
    this.sessionId = options.sessionId
    this.options = options
    this.downgraded = options.downgraded === true
    this.startedPaired = options.modelMode !== 'basic'
    this.mapper = new MessageMapper({
      sink: options.sink,
      onSdkSessionId: options.onSdkSessionId,
      summaries: options.summaries,
      onModelUsage: options.onModelUsage,
    })
  }

  start(): void {
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
    const elicit = this.options.elicit
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.options.projectPath,
        includePartialMessages: true,
        resume: this.options.resumeSdkSessionId,
        pathToClaudeCodeExecutable: this.options.claudeExecutablePath,
        env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
        spawnClaudeCodeProcess: sandbox?.spawn,
        settingSources: ['user', 'project', 'local'],
        additionalDirectories: sandbox
          ? sandbox.additionalDirectories
          : [this.options.projectPath, ...(this.options.extraDirs ?? []), ...(this.options.refDirs ?? [])],
        model:
          this.options.mainModel && this.options.mainModel !== 'default'
            ? this.options.mainModel
            : undefined,
        mcpServers: this.options.mcpServers,
        agents: this.options.agents,
        permissionMode: resolvePermissionMode(this.options.mode),
        allowDangerouslySkipPermissions: this.bypassing ? true : undefined,
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
        onElicitation: elicit ? (request, { signal }) => this.handleElicitation(elicit, request, signal) : undefined,
        hooks: {
          PreToolUse: [
            { matcher: 'Agent|Task', hooks: [() => this.gateSubagents()] },
            ...(this.options.denyTool ? [{ hooks: [(input: HookInput) => this.gateTool(input)] }] : []),
          ],
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
      let detail = explainExit(raw, this.containerised)
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
    this.captureContext(message)
    this.captureUsage(message)
    this.maybeDowngradeOnLimit(message)
    this.trackMcpCalls(message)
    this.mapper.handle(message)
    if (message.type === 'result') {
      const failed = message as { subtype: string; result?: string; errors?: string[] }
      this.turnError = !isFailedResult(message)
        ? null
        : [failed.result ?? '', ...(failed.errors ?? [])].join(' ').trim() || failed.subtype
      this.turnInFlight = false
      this.flushQueuedSends()
      this.recomputeStatus()
      this.options.onTurnComplete()
    }
  }

  private mcpCalls = new Map<string, ToolCall>()

  private trackMcpCalls(message: SDKMessage): void {
    const msg = message as {
      type?: string
      subtype?: string
      mcp_server_name?: string
      elicitation_id?: string
      message?: { content?: unknown }
    }
    if (msg.type === 'system' && msg.subtype === 'elicitation_complete') {
      if (msg.mcp_server_name && msg.elicitation_id) {
        this.options.elicit?.completed(this.sessionId, msg.mcp_server_name, msg.elicitation_id)
      }
      return
    }
    const content = Array.isArray(msg.message?.content) ? msg.message.content : []
    for (const block of content as { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }[]) {
      if (msg.type === 'assistant' && block.type === 'tool_use' && block.id && block.name?.startsWith('mcp__')) {
        const input = typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>) : {}
        this.mcpCalls.set(block.id, { toolUseId: block.id, tool: block.name, input })
      }
      if (msg.type === 'user' && block.type === 'tool_result' && block.tool_use_id && this.mcpCalls.delete(block.tool_use_id)) {
        this.options.elicit?.toolFinished(this.sessionId, block.tool_use_id)
      }
    }
  }

  private handleElicitation(
    elicit: ElicitationGate,
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    const prefix = mcpToolPrefix(request.serverName)
    const calls = [...this.mcpCalls.values()].filter((call) => call.tool.startsWith(prefix))
    return elicit.request({ sessionId: this.sessionId, request, signal, calls })
  }

  private appliedModel: string | null = null

  private downgraded = false
  private readonly startedPaired: boolean

  get limitModel(): string | undefined {
    return this.downgraded ? this.options.mainModel : undefined
  }

  private refreshModelSettings(): void {
    const next = this.options.resolveModels?.()
    if (!next) return
    this.options.effort = next.effort
    if (this.downgraded) return
    const routed =
      next.modelMode === 'jev' && this.routedModel && [next.intelligentModel, next.workerModel].includes(this.routedModel)
        ? this.routedModel
        : null
    this.options.mainModel = this.options.workerMainLoop ? next.workerModel : (routed ?? mainLoopModel(next.modelMode, next))
    this.options.modelMode = next.modelMode
    this.options.autoModelRouting = next.autoModelRouting
    this.switchLimit = (next.jevSwitchLimit ?? this.switchLimit / 1000) * 1000
  }

  private routedModel: string | null = null

  private switchLimit = 60_000

  private contextTokens: number | null = null

  private captureContext(message: SDKMessage): void {
    const msg = message as {
      type?: string
      parent_tool_use_id?: string | null
      message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }
    }
    const usage = msg.type === 'assistant' && !msg.parent_tool_use_id ? msg.message?.usage : undefined
    if (!usage) return
    this.contextTokens =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
  }

  private jevEnabled(): boolean {
    return !!this.options.askJev && this.options.modelMode === 'jev' && !this.downgraded && !this.options.workerMainLoop
  }

  private applyJev(answer: JevAnswer, text: string): void {
    const next = this.options.resolveModels?.()
    const current = this.options.mainModel ?? next?.intelligentModel ?? 'default'
    const route = jevRoute({
      answer,
      current,
      models: { intelligent: next?.intelligentModel ?? current, worker: next?.workerModel ?? current },
      contextTokens: this.contextTokens ?? (this.options.resumeSdkSessionId ? Number.POSITIVE_INFINITY : null),
      limitTokens: this.switchLimit,
    })
    this.routedModel = route.model
    this.options.mainModel = route.model
    this.options.onRoute?.(route)
    if (!answer.ok) {
      const auto = classifyWorkload(text)
      this.options.onTurnMode?.(auto === 'plan' || !this.startedPaired ? null : auto)
    } else {
      this.options.onTurnMode?.(null)
    }
    this.applyMainModel()
  }

  private applyModelForTurn(text: string): void {
    if (!this.options.autoModelRouting) return
    const workload = classifyWorkload(text)
    const forced = this.options.modelMode
    this.options.onTurnMode?.(workload === 'plan' || forced === 'basic' || !this.startedPaired ? null : workload)
    this.applyMainModel()
  }

  private applyMainModel(): void {
    const model = this.options.mainModel
    const wanted = model && model !== 'default' ? model : undefined
    const target = wanted ?? '__default__'
    if (this.appliedModel === target) return
    this.appliedModel = target
    void this.q?.setModel(wanted).catch(() => {})
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

  private gateTool(input: HookInput): Promise<HookJSONOutput> {
    const reason =
      input.hook_event_name === 'PreToolUse' ? this.options.denyTool?.(input.tool_name, input.tool_input) : null
    if (!reason) return Promise.resolve({})
    return Promise.resolve({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
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

  async slashCommands(): Promise<string[]> {
    return this.q ? (await this.q.supportedCommands()).map((c) => c.name) : []
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.q ? this.q.mcpServerStatus() : []
  }

  async reconnectMcpServer(name: string): Promise<void> {
    if (!this.q) throw new Error('The session has not started yet.')
    await this.q.reconnectMcpServer(name)
  }

  setPlanMode(enabled: boolean): void {
    const own = this.options.mode
    const mode = enabled ? 'plan' : resolvePermissionMode(own === 'plan' ? DEFAULT_SESSION_MODE : own)
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
    const msg = message as { api_error_status?: number | null; errors?: string[]; result?: string }
    if (!isFailedResult(message)) return
    const text = [msg.result ?? '', ...(msg.errors ?? [])].join('\n')
    if (msg.api_error_status !== 429 && !HostedSession.LIMIT.test(text)) return

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
    if (this.routedModel) {
      this.routedModel = null
      this.options.onRoute?.(null)
    }
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
    if (this.sandbox) text = toContainerPaths(text, this.sandbox.mounts)
    this.refreshModelSettings()
    this.applyEffort(this.options.effort ?? DEFAULT_SETTINGS.effort)
    if (this.jevEnabled() && this.options.askJev) {
      const ask = this.options.askJev
      this.turnInFlight = true
      this.jevWaiting = { eventId, text }
      this.recomputeStatus()
      void ask(text)
        .catch((): JevAnswer => ({ ok: false, why: 'Jev could not be reached' }))
        .then((answer) => {
          if (this.jevWaiting?.eventId !== eventId) return
          this.jevWaiting = null
          if (this.stopping || this.fatal) return
          this.applyJev(answer, text)
          this.pushTurn(eventId, text)
        })
      return
    }
    if (this.routedModel) {
      this.routedModel = null
      this.options.onRoute?.(null)
    }
    this.applyModelForTurn(text)
    this.pushTurn(eventId, text)
  }

  private pushTurn(eventId: string, text: string): void {
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

  private jevWaiting: QueuedSend | null = null

  async interrupt(): Promise<{ stillQueued: number }> {
    const waiting = this.jevWaiting
    this.jevWaiting = null
    if (waiting) {
      this.options.sink.update(waiting.eventId, { text: waiting.text, pending: false, withdrawn: true }, { persist: true })
    }
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

  get lastTurnError(): string | null {
    return this.turnError
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
