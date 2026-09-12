import type { EventPayloadMap } from '@shared/domain'
import type { EventSink, ModelTurnUsage } from './message-mapper'
import { previewOf } from './message-mapper'

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  [key: string]: unknown
}

export interface CodexEvent {
  type?: string
  thread_id?: string
  item?: CodexItem
  usage?: CodexUsage
  error?: unknown
  [key: string]: unknown
}

interface CodexMapperOptions {
  sink: EventSink
  onThreadId?: (threadId: string) => void
  model?: string
  onTurnComplete?: () => void
  onModelUsage?: (modelUsage: Record<string, ModelTurnUsage>) => void
}

const TOOL_NAMES: Record<string, string> = {
  command_execution: 'Bash',
  file_change: 'Edit',
  patch_apply: 'Edit',
  mcp_tool_call: 'MCP',
  web_search: 'WebSearch',
}

export class CodexMapper {
  private readonly sink: EventSink
  private readonly options: CodexMapperOptions
  private threadIdSeen = false
  private openItems = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()

  constructor(options: CodexMapperOptions) {
    this.sink = options.sink
    this.options = options
  }

  line(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('{')) {
      this.sink.append('raw_output', { text: trimmed })
      return
    }
    let event: CodexEvent
    try {
      event = JSON.parse(trimmed)
    } catch {
      this.sink.append('raw_output', { text: trimmed })
      return
    }
    this.handle(event)
  }

  handle(event: CodexEvent): void {
    switch (event.type) {
      case 'thread.started':
        if (event.thread_id && !this.threadIdSeen) {
          this.threadIdSeen = true
          this.options.onThreadId?.(event.thread_id)
        }
        return
      case 'turn.started':
        return
      case 'item.started':
        this.itemStarted(event.item ?? {})
        return
      case 'item.updated':
        this.itemUpdated(event.item ?? {})
        return
      case 'item.completed':
        this.itemCompleted(event.item ?? {})
        return
      case 'turn.completed':
        this.turnCompleted(event.usage)
        return
      case 'turn.failed':
        this.turnFailed(event)
        return
      case 'error':
        this.sink.append('error', { text: textOf(event.error) || 'Codex reported an error', fatal: false })
        return
      default:
        this.sink.append('raw_output', { text: JSON.stringify(event) })
    }
  }

  fatalError(text: string): void {
    this.closeOpenItems(text)
    this.sink.append('error', { text, fatal: true })
  }

  private closeOpenItems(reason: string): void {
    for (const [, open] of this.openItems) {
      this.sink.update(
        open.eventId,
        { ...open.payload, resultPreview: previewOf(reason), isError: true },
        { persist: true },
      )
    }
    this.openItems.clear()
  }

  private itemStarted(item: CodexItem): void {
    const toolName = TOOL_NAMES[item.type ?? '']
    if (!toolName || !item.id) return
    if (this.openItems.has(item.id)) return
    const payload: EventPayloadMap['tool_activity'] = {
      toolName,
      inputPreview: previewOf(inputOf(item)),
      toolUseId: item.id,
    }
    const event = this.sink.append('tool_activity', payload)
    this.openItems.set(item.id, { eventId: event.id, payload })
  }

  private itemUpdated(item: CodexItem): void {
    if (!item.id) return
    const open = this.openItems.get(item.id)
    if (!open) return
    if (typeof item.aggregated_output !== 'string') return
    this.sink.update(
      open.eventId,
      { ...open.payload, resultPreview: previewOf(item.aggregated_output) },
      { persist: false },
    )
  }

  private itemCompleted(item: CodexItem): void {
    switch (item.type) {
      case 'agent_message':
        if (item.text) this.sink.append('assistant_text', { text: item.text, partial: false })
        return
      case 'reasoning':
        if (item.text) this.sink.append('raw_output', { text: item.text })
        return
      case 'error':
        this.sink.append('error', { text: item.text ?? 'Codex reported an error', fatal: false })
        return
      default: {
        const open = item.id ? this.openItems.get(item.id) : undefined
        if (open) {
          this.openItems.delete(item.id as string)
          this.sink.update(
            open.eventId,
            {
              ...open.payload,
              resultPreview: previewOf(item.aggregated_output ?? outputOf(item)),
              isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed',
            },
            { persist: true },
          )
          return
        }
        const toolName = TOOL_NAMES[item.type ?? '']
        if (toolName) {
          this.sink.append('tool_activity', {
            toolName,
            inputPreview: previewOf(inputOf(item)),
            toolUseId: item.id,
            resultPreview: previewOf(item.aggregated_output ?? outputOf(item)),
            isError:
              typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed',
          })
          return
        }
        this.sink.append('raw_output', { text: JSON.stringify(item) })
      }
    }
  }

  private turnCompleted(usage: CodexUsage | undefined): void {
    const input = usage?.input_tokens ?? 0
    const output = usage?.output_tokens ?? 0
    if (usage && this.options.onModelUsage && this.options.model) {
      this.options.onModelUsage({
        [this.options.model]: {
          inputTokens: input,
          outputTokens: output,
          cacheReadInputTokens: usage.cached_input_tokens ?? 0,
          cacheCreationInputTokens: usage.cache_write_input_tokens ?? 0,
          costUSD: 0,
        },
      })
    }
    this.closeOpenItems('no result reported')
    this.sink.append('result', {
      totalCostUsd: 0,
      usage: { inputTokens: input, outputTokens: output },
      durationMs: 0,
    })
    this.options.onTurnComplete?.()
  }

  private turnFailed(event: CodexEvent): void {
    const text = textOf(event.error) || 'Codex turn failed'
    this.closeOpenItems(text)
    this.sink.append('error', { text, fatal: false })
    this.sink.append('result', { totalCostUsd: 0, usage: {}, durationMs: 0 })
    this.options.onTurnComplete?.()
  }
}

function inputOf(item: CodexItem): unknown {
  if (typeof item.command === 'string') return { command: item.command }
  const rest: Record<string, unknown> = { ...item }
  for (const field of ['id', 'type', 'status', 'aggregated_output']) delete rest[field]
  return rest
}

function outputOf(item: CodexItem): unknown {
  if (typeof item.text === 'string') return item.text
  const output = item.output ?? item.result ?? item.content
  return output ?? ''
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return value === undefined || value === null ? '' : JSON.stringify(value)
}
