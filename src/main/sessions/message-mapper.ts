// Implements contracts/session-events.md: Claude Agent SDK messages ->
// normalised Switchboard events. The mapper is pure state-machine logic over
// an EventSink so it is unit-testable without the SDK or a database.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, ResultUsage, SessionEvent } from '@shared/domain'

/**
 * Materialises mapper output. `persist: false` appends/updates are pushed to
 * the renderer only; text partials persist solely their final form while
 * marker/question status updates persist (contracts/session-events.md).
 */
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

const PREVIEW_LIMIT = 400

export function previewOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
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

export interface MessageMapperOptions {
  sink: EventSink
  /** Fired once when the SDK reports its session id (used for resume). */
  onSdkSessionId?: (sdkSessionId: string) => void
  /** Relabel a turn's closing message as ✦ SUMMARY. Off keeps it plain
   *  assistant text (the raw response). Defaults to on. */
  summaries?: boolean
}

export class MessageMapper {
  private sink: EventSink
  private onSdkSessionId?: (id: string) => void
  private readonly summaries: boolean
  private sdkSessionIdSeen = false
  /** Live streaming assistant text per producer ('' = main loop, else the subagent's tool_use id). */
  private partials = new Map<string, { eventId: string; text: string }>()
  /** tool_use id -> tool_activity event id awaiting its result half. */
  private openToolUses = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()
  /** task_id -> tool_activity event id for subagents reported via the SDK task
   *  channel (backgrounded / parallel fan-outs like /deep-research), which never
   *  appear as ordinary in-band Task tool_use/tool_result pairs. */
  private openTasks = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()
  /** Task/Agent tool_use ids ever seen in-band, so a late task_started for the
   *  same id is deduped even after its in-band tool_result already closed it. */
  private seenAgentToolUses = new Set<string>()
  /** Final MAIN-LOOP assistant text of the current turn, candidate for the summary upgrade. */
  private lastAssistantText: { eventId: string; text: string } | null = null

  constructor(options: MessageMapperOptions) {
    this.sink = options.sink
    this.onSdkSessionId = options.onSdkSessionId
    this.summaries = options.summaries !== false
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
        // init/status frames carry no stream content, but the task_* subtypes
        // report subagents (deep-research fan-out) that must show in the stream.
        this.handleTaskMessage(message)
        return
      default:
        this.handleUnclassified(message)
    }
  }

  /** Emits a fatal error event; called by the session wrapper on process death (FR-006). */
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

  /** Subagent attribution: the SDK stamps messages produced inside a Task tool run. */
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
          // The final message replaces its partials in place (contract).
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
          // Remember agent invocations so a later task_started for the same id
          // is recognised as a duplicate even after its tool_result closes it.
          if (block.name === 'Task' || block.name === 'Agent') this.seenAgentToolUses.add(block.id)
        }
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        // Not part of the narrative kinds; retained for raw-view completeness (FR-018).
        this.sink.append('raw_output', { text: block.thinking, agentId })
      }
    }
  }

  private handleUser(message: Extract<SDKMessage, { type: 'user' }>): void {
    // Composer prompts are echoed by the session wrapper on delivery; only the
    // tool_result half of tool activity is consumed here.
    const content = (message.message as { content?: unknown })?.content
    if (!Array.isArray(content)) return
    for (const block of content as ContentBlockLike[]) {
      if (block.type === 'tool_result' && block.tool_use_id) {
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

  /**
   * SDK task channel (task_started/task_updated/task_notification): surfaces
   * subagents that run backgrounded or in parallel (e.g. a /deep-research
   * fan-out) and so never arrive as ordinary in-band Task tool_use blocks. Each
   * becomes a Task tool_activity event, exactly the shape activeAgents() reads,
   * so no new agent concept or renderer change is needed.
   */
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
        if (msg.skip_transcript) return // ambient/housekeeping — hide per the SDK
        // A foreground Task already shown via its in-band tool_use block (open or
        // already closed), or an already-open task — don't list it twice.
        if (msg.tool_use_id && this.seenAgentToolUses.has(msg.tool_use_id)) return
        if (this.openTasks.has(taskId)) return
        const payload: EventPayloadMap['tool_activity'] = {
          toolName: 'Task',
          // Same JSON shape agentOf() parses for name/task/prompt.
          inputPreview: previewOf({
            subagent_type: msg.subagent_type,
            description: msg.description,
            prompt: msg.prompt,
          }),
          toolUseId: msg.tool_use_id ?? taskId,
          // Stays visible across a turn's result until its close signal arrives.
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
        return // task_progress and others: no per-agent state change needed
    }
  }

  /** Mark a task-channel subagent finished so activeAgents() stops listing it. */
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
    // Dangling partials at turn end are finalised as-is so nothing is lost.
    for (const [key, partial] of this.partials) {
      const agentId = key || undefined
      this.sink.update(partial.eventId, { text: partial.text, partial: false, agentId }, { persist: true })
      if (!agentId) this.lastAssistantText = { eventId: partial.eventId, text: partial.text }
    }
    this.partials.clear()

    if (message.subtype === 'success') {
      const text = message.result ?? ''
      if (text) {
        if (this.lastAssistantText && this.lastAssistantText.text === text) {
          // The turn's closing assistant message is the summary (design: ✦ SUMMARY).
          // Summaries off: leave it as the plain assistant text already streamed.
          if (this.summaries) {
            this.sink.update(this.lastAssistantText.eventId, { text }, { persist: true, kind: 'summary' })
          }
        } else {
          // No streamed twin (e.g. a /usage report): show the raw text, styled as
          // a summary only when summaries are on.
          this.sink.append(this.summaries ? 'summary' : 'assistant_text', { text })
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
    // Contract: any stdout/stderr-like content not otherwise classified -> raw_output.
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
