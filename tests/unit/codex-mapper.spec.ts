import { describe, expect, it } from 'vitest'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import { CodexMapper } from '@main/sessions/codex-mapper'
import { sandboxArgs, turnArgs } from '@main/sessions/codex-session'
import type { EventSink } from '@main/sessions/message-mapper'

class FakeSink implements EventSink {
  seq = 0
  appended: SessionEvent[] = []
  updates: { eventId: string; payload: unknown; persist: boolean }[] = []

  append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
    this.seq += 1
    const event: SessionEvent = {
      id: `e${this.seq}`,
      sessionId: 's1',
      seq: this.seq,
      kind,
      payload,
      noiseKind: null,
      createdAt: new Date().toISOString(),
    }
    this.appended.push(event)
    return event as SessionEvent<K>
  }

  update<K extends EventKind>(
    eventId: string,
    payload: EventPayloadMap[K],
    options?: { persist?: boolean },
  ): void {
    this.updates.push({ eventId, payload, persist: options?.persist === true })
  }
}

function makeMapper() {
  const sink = new FakeSink()
  let threadId: string | null = null
  let turns = 0
  const mapper = new CodexMapper({
    sink,
    model: 'gpt-5.6-sol',
    onThreadId: (id) => {
      threadId = id
    },
    onTurnComplete: () => {
      turns += 1
    },
  })
  return { sink, mapper, threadId: () => threadId, turns: () => turns }
}

describe('CodexMapper', () => {
  it('captures the thread id, which is what resumes the conversation', () => {
    const { mapper, threadId } = makeMapper()
    mapper.line('{"type":"thread.started","thread_id":"01a094a7-1ba3-73f3"}')
    expect(threadId()).toBe('01a094a7-1ba3-73f3')
  })

  it('renders an agent message as assistant text', () => {
    const { mapper, sink } = makeMapper()
    mapper.line('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}')
    expect(sink.appended.at(-1)?.kind).toBe('assistant_text')
    expect((sink.appended.at(-1)?.payload as { text: string }).text).toBe('OK')
  })

  it('pairs a command with its output and marks a non-zero exit as failed', () => {
    const { mapper, sink } = makeMapper()
    mapper.line(
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwsh -c ls","status":"in_progress"}}',
    )
    expect(sink.appended.at(-1)?.kind).toBe('tool_activity')
    mapper.line(
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwsh -c ls","aggregated_output":"nope","exit_code":1,"status":"completed"}}',
    )
    const update = sink.updates.at(-1)?.payload as { resultPreview: string; isError: boolean }
    expect(update.resultPreview).toBe('nope')
    expect(update.isError).toBe(true)
    expect(sink.appended.filter((e) => e.kind === 'tool_activity')).toHaveLength(1)
  })

  it('reports the turn total and hands usage to the session', () => {
    const sink = new FakeSink()
    let usage: Record<string, { inputTokens: number; outputTokens: number }> | null = null
    const mapper = new CodexMapper({
      sink,
      model: 'gpt-5.6-sol',
      onModelUsage: (u) => {
        usage = u
      },
    })
    mapper.line(
      '{"type":"turn.completed","usage":{"input_tokens":17999,"cached_input_tokens":12288,"output_tokens":5}}',
    )
    expect(sink.appended.at(-1)?.kind).toBe('result')
    expect(usage!['gpt-5.6-sol'].inputTokens).toBe(17999)
    expect((sink.appended.at(-1)?.payload as { totalCostUsd: number }).totalCostUsd).toBe(0)
  })

  it('keeps what it does not recognise, rather than dropping it', () => {
    const { mapper, sink } = makeMapper()
    mapper.line('Reading additional input from stdin...')
    mapper.line('{"type":"something.new","detail":42}')
    mapper.line('{"type":"item.completed","item":{"id":"i9","type":"brand_new_kind","text":"hi"}}')
    expect(sink.appended.map((e) => e.kind)).toEqual(['raw_output', 'raw_output', 'raw_output'])
  })

  it('surfaces a failed turn as an error and still closes the turn', () => {
    const { mapper, sink, turns } = makeMapper()
    mapper.line('{"type":"turn.failed","error":{"message":"rate limited"}}')
    expect(sink.appended.map((e) => e.kind)).toEqual(['error', 'result'])
    expect((sink.appended[0].payload as { text: string }).text).toBe('rate limited')
    expect(turns()).toBe(1)
  })

  it('fails the tool rows that were still open when the turn failed', () => {
    const { mapper, sink } = makeMapper()
    mapper.line(
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"in_progress"}}',
    )
    mapper.line('{"type":"turn.failed","error":{"message":"rate limited"}}')
    const update = sink.updates.at(-1)?.payload as { resultPreview: string; isError: boolean }
    expect(update.isError).toBe(true)
    expect(update.resultPreview).toBe('rate limited')
  })

  it('does the same when the process dies outright', () => {
    const { mapper, sink } = makeMapper()
    mapper.line(
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"in_progress"}}',
    )
    mapper.fatalError('Codex exited with code 1')
    expect((sink.updates.at(-1)?.payload as { isError: boolean }).isError).toBe(true)
  })

  it('keeps no open item across a turn boundary', () => {
    const { mapper, sink } = makeMapper()
    mapper.line(
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"in_progress"}}',
    )
    mapper.line('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')
    const before = sink.updates.length
    mapper.line(
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","aggregated_output":"late","exit_code":0}}',
    )
    expect(sink.updates.length).toBe(before)
    expect(sink.appended.at(-1)?.kind).toBe('tool_activity')
  })
})

describe('codex argv', () => {
  it('starts a thread, then resumes the one it was given', () => {
    const base = { prompt: 'do it', projectPath: 'C:/repo', mode: 'auto' as const }
    expect(turnArgs(base).slice(0, 2)).toEqual(['exec', '--json'])
    expect(turnArgs({ ...base, threadId: 't1' }).slice(0, 3)).toEqual(['exec', 'resume', 't1'])
    expect(turnArgs(base).at(-1)).toBe('do it')
  })

  it('is the only place that can switch the sandbox off, and only for bypass', () => {
    expect(sandboxArgs('bypass')).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(sandboxArgs('plan')).toEqual(['-s', 'read-only'])
    expect(sandboxArgs('auto')).toEqual(['-s', 'workspace-write'])
    expect(sandboxArgs('default')).toEqual(['-s', 'workspace-write'])
  })
})
