// Codex CLI JSONL -> normalised Switchboard events, the counterpart of
// message-mapper.ts for the other engine. Pure state-machine logic over an
// EventSink so it is unit-testable without spawning anything.
//
// The vocabulary below was read off `codex exec --json` rather than from a
// specification: `thread.started`, `turn.started`, `item.started`,
// `item.completed`, `turn.completed`. Anything not recognised is emitted as raw
// output rather than dropped — the raw view's promise is the whole stream, and a
// CLI that grows a new item type must not make this one quietly lossy.
import type { EventPayloadMap } from '@shared/domain'
import type { EventSink, ModelTurnUsage } from './message-mapper'
import { previewOf } from './message-mapper'

/** The Codex usage block, as `turn.completed` reports it. */
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
  /** Fired once with the Codex thread id, which is what `codex exec resume` takes. */
  onThreadId?: (threadId: string) => void
  /** The model this session runs, so usage can be attributed to it — Codex
   *  reports usage without naming the model that spent it. */
  model?: string
  onTurnComplete?: () => void
  onModelUsage?: (modelUsage: Record<string, ModelTurnUsage>) => void
}

/** Which Switchboard tool name best describes a Codex item. */
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
  /** Codex item id -> the tool_activity event awaiting its completed half. */
  private openItems = new Map<string, { eventId: string; payload: EventPayloadMap['tool_activity'] }>()

  constructor(options: CodexMapperOptions) {
    this.sink = options.sink
    this.options = options
  }

  /**
   * One line of the CLI's stdout.
   *
   * A line that is not JSON is not an error: `codex exec` prints human notices
   * ("Reading additional input from stdin…") on the same stream. They are shown
   * as raw output, which is what a terminal would have done with them.
   */
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
        // Unknown frame: keep it rather than lose it.
        this.sink.append('raw_output', { text: JSON.stringify(event) })
    }
  }

  /** Emits a fatal error event; called by the session wrapper on process death. */
  fatalError(text: string): void {
    this.sink.append('error', { text, fatal: true })
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

  /** Streaming output for a command still running, applied in place. */
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
        // Not narrative, but part of what the session produced; the raw view shows
        // it, the clean view treats it as any other raw line.
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
          // Completed without a started half (a fast command, or a CLI that only
          // reports the end): still a tool row, just one that never streamed.
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
          // Codex reports no cost. Zero here means "not reported", and the result
          // line omits a cost entirely rather than claiming $0.00 was spent.
          costUSD: 0,
        },
      })
    }
    this.sink.append('result', {
      totalCostUsd: 0,
      usage: { inputTokens: input, outputTokens: output },
      durationMs: 0,
    })
    this.options.onTurnComplete?.()
  }

  private turnFailed(event: CodexEvent): void {
    this.sink.append('error', { text: textOf(event.error) || 'Codex turn failed', fatal: false })
    this.sink.append('result', { totalCostUsd: 0, usage: {}, durationMs: 0 })
    this.options.onTurnComplete?.()
  }
}

/** The part of an item that identifies the call, for the tool row's argument. */
function inputOf(item: CodexItem): unknown {
  if (typeof item.command === 'string') return { command: item.command }
  // The envelope fields are the item's plumbing, not what the call was about.
  const rest: Record<string, unknown> = { ...item }
  for (const field of ['id', 'type', 'status', 'aggregated_output']) delete rest[field]
  return rest
}

/** Whatever an item carries as its result, for tools that are not commands. */
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
