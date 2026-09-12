import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, ResultUsage, SessionEvent } from '@shared/domain'
import { classifyInjection } from '@shared/domain'
import { isInteractiveQuestion } from '@shared/inline-question'

export interface EventSink {
  append<K extends EventKind>(
    kind: K,
    payload: EventPayloadMap[K],
    options?: { persist?: boolean },
  ): SessionEvent<K>
  update<K extends EventKind>(
    eventId: string,
    payload: EventPayloadMap[K],
    options?: { persist?: boolean; kind?: K },
  ): void
}

interface ContentBlockLike {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

const PREVIEW_LIMIT = 100_000

export function previewOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= PREVIEW_LIMIT) return text
  const dropped = text.length - PREVIEW_LIMIT
  return `${text.slice(0, PREVIEW_LIMIT)}\n… [${dropped} more characters not stored]`
}

function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return previewOf(content)
}

function usageOf(raw: Record<string, unknown> | undefined): ResultUsage {
  if (!raw) return {}
  return {
    ...raw,
    inputTokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : undefined,
    outputTokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : undefined,
  }
}

interface MessageMapperOptions {
  sink: EventSink
  onSdkSessionId?: (sdkSessionId: string) => void
  summaries?: boolean
  onModelUsage?: (modelUsage: Record<string, ModelTurnUsage>) => void
}

export interface ModelTurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

export function foldModelTotals(
  prev: Record<string, { tokens: number; costUsd: number }>,
  modelUsage: Record<string, ModelTurnUsage>,
): Record<string, { tokens: number; costUsd: number }> {
  const totals = { ...prev }
  for (const [model, u] of Object.entries(modelUsage)) {
    totals[model] = {
      tokens: u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
      costUsd: u.costUSD,
    }
  }
  return totals
}

export class MessageMapper {
  private sink: EventSink
  private onSdkSessionId?: (id: string) => void
  private onModelUsage?: (modelUsage: Record<string, ModelTurnUsage>) => void
  private readonly summaries: boolean
  private sdkSessionIdSeen = false
  private partials = new Map<string, { eventId: string; text: string }>()
  private openToolUses = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()
  private openTasks = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()
  private seenAgentToolUses = new Set<string>()
  private lastAssistantText: { eventId: string; text: string } | null = null
  private pendingEchoes: string[] = []

  constructor(options: MessageMapperOptions) {
    this.sink = options.sink
    this.onSdkSessionId = options.onSdkSessionId
    this.summaries = options.summaries !== false
    this.onModelUsage = options.onModelUsage
  }

  handle(message: SDKMessage): void {
    this.captureSessionId(message)
    switch (message.type) {
      case 'assistant':
        this.handleAssistant(message)
        return
      case 'user':
        this.handleUser(message)
        return
      case 'stream_event':
        this.handleStreamEvent(message)
        return
      case 'result':
        this.handleResult(message)
        return
      case 'system':
        this.handleSystemInit(message)
        this.handleTaskMessage(message)
        return
      default:
        this.handleUnclassified(message)
    }
  }

  noteDelivered(text: string): void {
    this.pendingEchoes.push(text)
    if (this.pendingEchoes.length > 10) this.pendingEchoes.shift()
  }

  private emitInjection(text: string, agentId?: string): void {
    let remainder = text
    for (let i = 0; i < this.pendingEchoes.length; i++) {
      const echo = this.pendingEchoes[i]
      if (!echo) continue
      if (remainder === echo) {
        this.pendingEchoes.splice(i, 1)
        return
      }
      if (remainder.startsWith(echo)) {
        this.pendingEchoes.splice(i, 1)
        remainder = remainder.slice(echo.length)
        break
      }
    }
    if (!remainder.trim()) return
    this.sink.append('injection', {
      text: remainder,
      source: classifyInjection(remainder),
      agentId,
    })
  }

  fatalError(text: string): void {
    this.sink.append('error', { text, fatal: true })
  }

  private captureSessionId(message: SDKMessage): void {
    const sessionId = (message as { session_id?: string }).session_id
    if (sessionId && !this.sdkSessionIdSeen) {
      this.sdkSessionIdSeen = true
      this.onSdkSessionId?.(sessionId)
    }
  }

  private agentIdOf(message: SDKMessage): string | undefined {
    const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id
    return parent ?? undefined
  }

  private handleAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    const agentId = this.agentIdOf(message)
    const partialKey = agentId ?? ''
    const blocks = (message.message?.content ?? []) as ContentBlockLike[]
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const partial = this.partials.get(partialKey)
        if (partial) {
          this.sink.update(partial.eventId, { text: block.text, partial: false, agentId }, { persist: true })
          if (!agentId) this.lastAssistantText = { eventId: partial.eventId, text: block.text }
          this.partials.delete(partialKey)
        } else {
          const event = this.sink.append('assistant_text', { text: block.text, partial: false, agentId })
          if (!agentId) this.lastAssistantText = { eventId: event.id, text: block.text }
        }
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const payload: EventPayloadMap['tool_activity'] = {
          toolName: block.name,
          inputPreview: previewOf(block.input),
          toolUseId: block.id,
          agentId,
        }
        const event = this.sink.append('tool_activity', payload)
        if (block.id) {
          this.openToolUses.set(block.id, { eventId: event.id, payload })
          if (block.name === 'Task' || block.name === 'Agent') this.seenAgentToolUses.add(block.id)
        }
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        this.sink.append('raw_output', { text: block.thinking, agentId })
      }
    }
  }

  private handleUser(message: Extract<SDKMessage, { type: 'user' }>): void {
    const agentId = this.agentIdOf(message)
    const content = (message.message as { content?: unknown })?.content
    if (typeof content === 'string') {
      this.emitInjection(content, agentId)
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content as ContentBlockLike[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        this.emitInjection(block.text, agentId)
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const open = this.openToolUses.get(block.tool_use_id)
        if (!open) continue
        this.openToolUses.delete(block.tool_use_id)
        const updated: EventPayloadMap['tool_activity'] = {
          ...open.payload,
          resultPreview: previewOf(textOfToolResult(block.content)),
          isError: block.is_error === true,
        }
        this.sink.update(open.eventId, updated, { persist: true })
      }
    }
  }

  private handleSystemInit(message: SDKMessage): void {
    const frame = message as {
      subtype?: string
      model?: string
      cwd?: string
      permissionMode?: string
      tools?: unknown[]
      mcp_servers?: unknown[]
      slash_commands?: unknown[]
      agents?: unknown[]
    }
    if (frame.subtype !== 'init') return
    const lines = ['session started']
    if (frame.model) lines.push(`model: ${frame.model}`)
    if (frame.cwd) lines.push(`cwd: ${frame.cwd}`)
    if (frame.permissionMode) lines.push(`permission mode: ${frame.permissionMode}`)
    if (Array.isArray(frame.tools)) lines.push(`tools: ${frame.tools.length}`)
    if (Array.isArray(frame.mcp_servers)) lines.push(`mcp servers: ${frame.mcp_servers.length}`)
    if (Array.isArray(frame.slash_commands))
      lines.push(`slash commands: ${frame.slash_commands.length}`)
    if (Array.isArray(frame.agents)) lines.push(`agents: ${frame.agents.length}`)
    this.sink.append('injection', { text: lines.join('\n'), source: 'system' })
  }

  private handleTaskMessage(message: SDKMessage): void {
    const msg = message as {
      subtype?: string
      task_id?: string
      tool_use_id?: string
      description?: string
      subagent_type?: string
      prompt?: string
      skip_transcript?: boolean
      status?: string
      summary?: string
      patch?: { status?: string; description?: string; error?: string }
    }
    const taskId = msg.task_id
    if (!taskId) return
    switch (msg.subtype) {
      case 'task_started': {
        if (msg.skip_transcript) return 
        if (msg.tool_use_id && this.seenAgentToolUses.has(msg.tool_use_id)) return
        if (this.openTasks.has(taskId)) return
        const payload: EventPayloadMap['tool_activity'] = {
          toolName: 'Task',
          inputPreview: previewOf({
            subagent_type: msg.subagent_type,
            description: msg.description,
            prompt: msg.prompt,
          }),
          toolUseId: msg.tool_use_id ?? taskId,
          background: true,
        }
        const event = this.sink.append('tool_activity', payload)
        this.openTasks.set(taskId, { eventId: event.id, payload })
        return
      }
      case 'task_updated': {
        const status = msg.patch?.status
        if (status === 'completed' || status === 'failed' || status === 'killed') {
          this.closeTask(taskId, msg.patch?.error ?? status)
        }
        return
      }
      case 'task_notification':
        this.closeTask(taskId, msg.summary || msg.status || 'done')
        return
      default:
        return 
    }
  }

  private closeTask(taskId: string, resultPreview: string): void {
    const open = this.openTasks.get(taskId)
    if (!open) return
    this.openTasks.delete(taskId)
    this.sink.update(
      open.eventId,
      { ...open.payload, resultPreview: previewOf(resultPreview) },
      { persist: true },
    )
  }

  private handleStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const event = message.event as {
      type: string
      delta?: { type?: string; text?: string }
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      const agentId = this.agentIdOf(message)
      const partialKey = agentId ?? ''
      const partial = this.partials.get(partialKey)
      if (!partial) {
        const appended = this.sink.append(
          'assistant_text',
          { text: event.delta.text, partial: true, agentId },
          { persist: false },
        )
        this.partials.set(partialKey, { eventId: appended.id, text: event.delta.text })
      } else {
        partial.text += event.delta.text
        this.sink.update(
          partial.eventId,
          { text: partial.text, partial: true, agentId },
          { persist: false },
        )
      }
    }
  }

  private handleResult(message: Extract<SDKMessage, { type: 'result' }>): void {
    const modelUsage = (message as { modelUsage?: Record<string, ModelTurnUsage> }).modelUsage
    if (modelUsage && this.onModelUsage) this.onModelUsage(modelUsage)

    for (const [key, partial] of this.partials) {
      const agentId = key || undefined
      this.sink.update(partial.eventId, { text: partial.text, partial: false, agentId }, { persist: true })
      if (!agentId) this.lastAssistantText = { eventId: partial.eventId, text: partial.text }
    }
    this.partials.clear()

    if (message.subtype === 'success') {
      const text = message.result ?? ''
      if (text) {
        const asSummary = this.summaries && !isInteractiveQuestion(text)
        if (this.lastAssistantText && this.lastAssistantText.text === text) {
          if (asSummary) {
            this.sink.update(this.lastAssistantText.eventId, { text }, { persist: true, kind: 'summary' })
          }
        } else {
          this.sink.append(asSummary ? 'summary' : 'assistant_text', { text })
        }
      }
      this.sink.append('result', {
        text: text || undefined,
        totalCostUsd: message.total_cost_usd ?? 0,
        usage: usageOf(message.usage as Record<string, unknown>),
        durationMs: message.duration_ms ?? 0,
      })
    } else {
      const errors = (message as { errors?: string[] }).errors
      const text =
        errors && errors.length > 0 ? errors.join('\n') : `Session turn failed (${message.subtype})`
      this.sink.append('error', { text, fatal: false })
      this.sink.append('result', {
        totalCostUsd: message.total_cost_usd ?? 0,
        usage: usageOf(message.usage as Record<string, unknown>),
        durationMs: message.duration_ms ?? 0,
      })
    }
    this.lastAssistantText = null
  }

  private handleUnclassified(message: SDKMessage): void {
    const candidate = message as { text?: unknown; output?: unknown; content?: unknown }
    const text =
      typeof candidate.text === 'string'
        ? candidate.text
        : typeof candidate.output === 'string'
          ? candidate.output
          : typeof candidate.content === 'string'
            ? candidate.content
            : null
    if (text) this.sink.append('raw_output', { text })
  }
}
