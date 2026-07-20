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
}

export class MessageMapper {
  private sink: EventSink
  private onSdkSessionId?: (id: string) => void
  private sdkSessionIdSeen = false
  /** Live streaming assistant text per producer ('' = main loop, else the subagent's tool_use id). */
  private partials = new Map<string, { eventId: string; text: string }>()
  /** tool_use id -> tool_activity event id awaiting its result half. */
  private openToolUses = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()
  /** Final MAIN-LOOP assistant text of the current turn, candidate for the summary upgrade. */
  private lastAssistantText: { eventId: string; text: string } | null = null

  constructor(options: MessageMapperOptions) {
    this.sink = options.sink
    this.onSdkSessionId = options.onSdkSessionId
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
        // init and other control frames carry no stream content
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
        if (block.id) this.openToolUses.set(block.id, { eventId: event.id, payload })
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
          this.sink.update(this.lastAssistantText.eventId, { text }, { persist: true, kind: 'summary' })
        } else {
          this.sink.append('summary', { text })
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
