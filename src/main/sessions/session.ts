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
import type { SessionStatus } from '@shared/domain'
import { MessageMapper, type EventSink } from './message-mapper'

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
  /** SDK session id of a prior conversation to resume (R2). */
  resumeSdkSessionId?: string
  /** Terse-mode instruction appended to the Claude Code system prompt, if enabled. */
  systemPromptAppend?: string
  /** Path to the bundled standalone Claude executable (avoids the Electron spawn crash). */
  claudeExecutablePath?: string
  sink: EventSink
  gate: PermissionGate
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  onSdkSessionId: (sdkSessionId: string) => void
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
    this.mapper.handle(message)
    if (message.type === 'result') {
      this.turnInFlight = false
      this.flushQueuedSends()
      this.recomputeStatus()
      this.options.onTurnComplete()
    }
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
    const next: SessionStatus =
      this.attentionCount > 0 ? 'needs_you' : this.turnInFlight ? 'working' : 'done'
    this.setStatus(next)
  }

  private setStatus(status: SessionStatus, detail?: string | null): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatusChange(status, detail ?? null)
  }
}
