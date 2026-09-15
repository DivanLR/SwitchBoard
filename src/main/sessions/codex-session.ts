import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { AvailableModel, SessionMode, SessionStatus } from '@shared/domain'
import type { EventSink, ModelTurnUsage } from './message-mapper'
import { CodexMapper } from './codex-mapper'
import { CODEX_MISSING_MESSAGE, codexInstalled, resolveCodexLaunch } from './codex-executable'
import type { QueuedSend, SessionHost } from './session'

interface CodexSessionOptions {
  sessionId: string
  projectPath: string
  model?: string
  effort?: string
  mode: SessionMode
  resumeThreadId?: string
  sink: EventSink
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  onSdkSessionId: (threadId: string) => void
  onModel?: (model: string) => void
  onModels?: (models: AvailableModel[]) => void
  onModelUsage?: (modelUsage: Record<string, ModelTurnUsage>) => void
  onTurnComplete: () => void
  onExit: (reason: 'completed' | 'stopped' | 'crashed', detail?: string) => void
}

export function sandboxArgs(mode: SessionMode): string[] {
  switch (mode) {
    case 'bypass':
      return ['--dangerously-bypass-approvals-and-sandbox']
    case 'plan':
      return ['-s', 'read-only']
    default:
      return ['-s', 'workspace-write']
  }
}

export function turnArgs(options: {
  prompt: string
  projectPath: string
  threadId?: string
  model?: string
  effort?: string
  mode: SessionMode
}): string[] {
  const shared = [
    '--json',
    '--skip-git-repo-check',
    '-C',
    options.projectPath,
    ...sandboxArgs(options.mode),
    ...(options.model ? ['-m', options.model] : []),
    ...(options.effort ? ['-c', `model_reasoning_effort="${options.effort}"`] : []),
  ]
  return options.threadId
    ? ['exec', 'resume', options.threadId, ...shared, options.prompt]
    : ['exec', ...shared, options.prompt]
}

interface ActiveTurn {
  child: ChildProcessByStdio<null, Readable, Readable>
  stdout: string
  settled: boolean
}

export class CodexSession implements SessionHost {
  private readonly options: CodexSessionOptions
  private readonly mapper: CodexMapper
  private turn: ActiveTurn | null = null
  private threadId: string | undefined
  private status: SessionStatus = 'done'
  private statusDetail: string | null = null
  private queuedSends: QueuedSend[] = []
  private stopping = false
  private started = false
  private attention = false

  constructor(options: CodexSessionOptions) {
    this.options = options
    this.threadId = options.resumeThreadId
    this.mapper = new CodexMapper({
      sink: options.sink,
      model: options.model,
      onThreadId: (threadId) => {
        this.threadId = threadId
        options.onSdkSessionId(threadId)
      },
      onModelUsage: options.onModelUsage,
    })
  }

  start(): void {
    if (!codexInstalled()) {
      this.options.sink.append('error', { text: CODEX_MISSING_MESSAGE, fatal: true })
      this.options.onExit('crashed', CODEX_MISSING_MESSAGE)
      return
    }
    this.started = true
    this.options.onModel?.(this.options.model ?? 'codex default')
    this.options.sink.append('injection', {
      text: [
        'codex session ready',
        `model: ${this.options.model ?? 'the CLI default'}`,
        `cwd: ${this.options.projectPath}`,
        `sandbox: ${sandboxArgs(this.options.mode).join(' ')}`,
        this.threadId ? `resuming thread: ${this.threadId}` : 'new thread',
      ].join('\n'),
      source: 'system',
    })
    this.setStatus('done', null)
  }

  send(text: string): { queued: boolean; deliver: (eventId: string) => void } {
    const queued = this.turn !== null
    return {
      queued,
      deliver: (eventId: string) => {
        if (queued) {
          this.queuedSends.push({ eventId, text })
          return
        }
        this.options.sink.update(eventId, { text, pending: false }, { persist: true })
        this.runTurn(text)
      },
    }
  }

  editQueuedSend(eventId: string, text: string): boolean {
    const index = this.queuedSends.findIndex((send) => send.eventId === eventId)
    if (index === -1) return false
    if (text.trim()) {
      this.queuedSends[index] = { eventId, text }
      this.options.sink.update(eventId, { text, pending: true }, { persist: true })
    } else {
      this.queuedSends.splice(index, 1)
      this.options.sink.update(eventId, { text: '', pending: false, withdrawn: true }, { persist: true })
    }
    return true
  }

  async interrupt(): Promise<{ stillQueued: number }> {
    this.killChild()
    const stillQueued = this.queuedSends.length
    this.setStatus('done', 'Interrupted')
    return { stillQueued }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.killChild()
    this.queuedSends = []
    this.options.onExit('stopped')
  }

  takeQueuedSends(): QueuedSend[] {
    const queued = this.queuedSends
    this.queuedSends = []
    return queued
  }

  get isMidTask(): boolean {
    return this.turn !== null
  }

  get currentStatus(): SessionStatus {
    return this.status
  }

  attentionRaised(): void {
    this.attention = true
    this.setStatus(this.status, this.statusDetail)
  }

  attentionCleared(): void {
    this.attention = false
    this.setStatus(this.status, this.statusDetail)
  }

  clearBackgroundTasks(): void {}

  setPlanMode(): void {}

  async reloadPlugins(): Promise<void> {}

  private runTurn(prompt: string): void {
    const launch = resolveCodexLaunch()
    if (!launch) {
      this.options.sink.append('error', { text: CODEX_MISSING_MESSAGE, fatal: true })
      this.options.onExit('crashed', CODEX_MISSING_MESSAGE)
      return
    }
    if (!this.started) this.started = true
    const args = turnArgs({
      prompt,
      projectPath: this.options.projectPath,
      threadId: this.threadId,
      model: this.options.model,
      effort: this.options.effort,
      mode: this.options.mode,
    })
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      cwd: this.options.projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env },
    })
    const turn: ActiveTurn = { child, stdout: '', settled: false }
    this.turn = turn
    this.setStatus('working', null)

    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(turn, chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.options.sink.append('raw_output', { text })
    })
    child.on('error', (error) => {
      if (turn.settled) return
      this.mapper.fatalError(error.message)
      this.settle(turn, 'crashed', error.message)
    })
    child.on('close', (code) => {
      if (turn.settled) return
      if (turn.stdout.trim()) {
        this.mapper.line(turn.stdout)
        turn.stdout = ''
      }
      if (this.stopping) {
        turn.settled = true
        return
      }
      if (code === 0) {
        this.settle(turn, 'completed')
      } else if (code === null) {
        this.settle(turn, 'killed')
      } else {
        const detail = `Codex exited with code ${code}`
        this.mapper.fatalError(detail)
        this.settle(turn, 'crashed', detail)
      }
    })
  }

  private consumeStdout(turn: ActiveTurn, chunk: string): void {
    if (turn.settled) return
    turn.stdout += chunk
    let newline: number
    while ((newline = turn.stdout.indexOf('\n')) >= 0) {
      const line = turn.stdout.slice(0, newline)
      turn.stdout = turn.stdout.slice(newline + 1)
      this.mapper.line(line)
    }
  }

  private settle(
    turn: ActiveTurn,
    reason: 'completed' | 'crashed' | 'killed',
    detail?: string,
  ): void {
    if (turn.settled) return
    turn.settled = true
    if (this.turn !== turn) return
    this.turn = null
    if (reason !== 'killed') {
      this.setStatus(reason === 'crashed' ? 'error' : 'done', detail ?? null)
      this.options.onTurnComplete()
    }
    this.drainQueue()
  }

  private drainQueue(): void {
    const next = this.queuedSends.shift()
    if (!next) return
    this.options.sink.update(next.eventId, { text: next.text, pending: false }, { persist: true })
    this.runTurn(next.text)
  }

  private killChild(): void {
    const turn = this.turn
    this.turn = null
    if (!turn) return
    turn.settled = true
    turn.child.kill()
  }

  private setStatus(status: SessionStatus, detail: string | null): void {
    const effective = this.attention && status !== 'error' ? 'needs_you' : status
    this.status = effective
    this.statusDetail = detail
    this.options.onStatusChange(effective, detail)
  }
}
