// A session driven by the OpenAI Codex CLI, presenting the same SessionHost
// surface as the Claude one (session.ts) so the manager, the stream and the
// views need no branch beyond which class is constructed.
//
// SHAPE OF THE INTEGRATION: `codex exec --json` runs ONE turn and exits, so a
// session here is a sequence of short-lived processes rather than one long-lived
// one. The first turn starts a thread; every turn after it is
// `codex exec resume <thread id>`, which is how the CLI itself continues a
// conversation. A turn in flight therefore has a real process to kill, which is
// what makes interrupt honest.
//
// WHAT A CODEX SESSION DOES NOT HAVE, and why nothing here pretends otherwise:
// the permission inbox, containers, plan mode, subagent pairing and background
// tasks are all Claude Agent SDK features. `codex exec` is non-interactive and
// decides for itself inside the sandbox it was given, so there is no approval to
// route to the inbox. The session mode is translated to the closest Codex
// sandbox policy and the session header says which engine is running.
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { AvailableModel, SessionMode, SessionStatus } from '@shared/domain'
import type { EventSink, ModelTurnUsage } from './message-mapper'
import { CodexMapper } from './codex-mapper'
import { CODEX_MISSING_MESSAGE, resolveCodexExecutable } from './codex-executable'
import type { QueuedSend, SessionHost } from './session'

export interface CodexSessionOptions {
  sessionId: string
  projectPath: string
  /** Codex model id (from probeCodexModels); omitted uses the CLI's own default. */
  model?: string
  /** Main-loop reasoning effort, passed through as Codex's model_reasoning_effort. */
  effort?: string
  /** The Switchboard mode, translated to a Codex sandbox policy (sandboxArgs). */
  mode: SessionMode
  /** Codex thread id of a prior conversation to resume. */
  resumeThreadId?: string
  sink: EventSink
  onStatusChange: (status: SessionStatus, detail?: string | null) => void
  /** The Codex thread id, stored as the session's resume handle. */
  onSdkSessionId: (threadId: string) => void
  onModel?: (model: string) => void
  onModels?: (models: AvailableModel[]) => void
  onModelUsage?: (modelUsage: Record<string, ModelTurnUsage>) => void
  onTurnComplete: () => void
  onExit: (reason: 'completed' | 'stopped' | 'crashed', detail?: string) => void
}

/**
 * The Codex sandbox policy for a Switchboard session mode.
 *
 * `bypass` is the only mode that disables the sandbox, and it does so
 * explicitly: everything else keeps Codex's own sandbox in force. `plan` maps to
 * read-only, which is the nearest true equivalent — Codex has no plan mode, and
 * a read-only sandbox is the honest version of "look but do not touch" rather
 * than a promise this app cannot keep.
 */
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

/** The argv for one turn: a fresh thread, or a resume of the one in progress. */
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

export class CodexSession implements SessionHost {
  private readonly options: CodexSessionOptions
  private readonly mapper: CodexMapper
  // stdin is 'ignore', so the process type has no writable stdin — which is the
  // point: the prompt is an argument, and `codex exec` treats a piped stdin as
  // extra prompt material.
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private threadId: string | undefined
  private status: SessionStatus = 'done'
  private statusDetail: string | null = null
  private queuedSends: QueuedSend[] = []
  private stopping = false
  private started = false
  private attention = false
  /** Partial stdout between chunk boundaries; JSONL is only valid per line. */
  private stdoutBuffer = ''

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

  /**
   * There is no process to start until there is something to say.
   *
   * A Claude session boots a CLI that then waits; `codex exec` runs a turn and
   * exits, so starting one with no prompt would spend a turn on nothing. The
   * session reports itself idle and ready, and the first message starts the
   * first process.
   */
  start(): void {
    if (!resolveCodexExecutable()) {
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
    const queued = this.child !== null
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
    return this.child !== null
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

  /** Codex reports no background tasks, so there is never a stale set to clear. */
  clearBackgroundTasks(): void {}

  /** Codex has no plan mode; the mode is fixed at spawn as a sandbox policy. */
  setPlanMode(): void {}

  /** Plugins are a Claude Code concept; nothing to reload here. */
  async reloadPlugins(): Promise<void> {}

  private runTurn(prompt: string): void {
    const executable = resolveCodexExecutable()
    if (!executable) {
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
    // stdin is closed: `codex exec` reads a piped stdin as extra prompt material,
    // and the prompt is already an argument.
    const child = spawn(executable, args, {
      cwd: this.options.projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.stdoutBuffer = ''
    this.setStatus('working', null)

    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk.toString()))
    // Codex writes progress notices to stderr; they are part of what the session
    // produced, so they belong in the stream rather than in a log nobody reads.
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.options.sink.append('raw_output', { text })
    })
    child.on('error', (error) => {
      this.mapper.fatalError(error.message)
      this.finishTurn('crashed', error.message)
    })
    child.on('close', (code) => {
      // Flush a last line with no trailing newline before deciding the outcome.
      if (this.stdoutBuffer.trim()) {
        this.mapper.line(this.stdoutBuffer)
        this.stdoutBuffer = ''
      }
      if (this.stopping) return
      if (code === 0) {
        this.finishTurn('completed')
      } else if (code === null) {
        // Killed: interrupt() has already said so.
        this.child = null
        this.drainQueue()
      } else {
        const detail = `Codex exited with code ${code}`
        this.mapper.fatalError(detail)
        this.finishTurn('crashed', detail)
      }
    })
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline: number
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.mapper.line(line)
    }
  }

  /**
   * A turn ended. Unlike the Claude host, a crashed turn does NOT end the
   * session: the process was always going to exit, so a failed one leaves the
   * conversation intact and the developer can send another message.
   */
  private finishTurn(reason: 'completed' | 'crashed', detail?: string): void {
    this.child = null
    this.setStatus(reason === 'crashed' ? 'error' : 'done', detail ?? null)
    this.options.onTurnComplete()
    this.drainQueue()
  }

  private drainQueue(): void {
    const next = this.queuedSends.shift()
    if (!next) return
    this.options.sink.update(next.eventId, { text: next.text, pending: false }, { persist: true })
    this.runTurn(next.text)
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (!child) return
    child.kill()
  }

  private setStatus(status: SessionStatus, detail: string | null): void {
    // Attention is the developer's own flag and outranks a working process, the
    // same way it does on a Claude session.
    const effective = this.attention && status !== 'error' ? 'needs_you' : status
    this.status = effective
    this.statusDetail = detail
    this.options.onStatusChange(effective, detail)
  }
}
