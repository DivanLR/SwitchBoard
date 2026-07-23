// T016: every contracts/session-events.md mapping row, ordering, and in-place
// update behaviour of the message mapper.
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import { SWALLOWABLE_KINDS } from '@shared/domain'
import { MessageMapper, previewOf, type EventSink } from '@main/sessions/message-mapper'
import { classifyNoise, defaultSwallowRules } from '@main/stream/swallow-rules'

interface RecordedUpdate {
  eventId: string
  payload: unknown
  persist: boolean
  kind?: EventKind
}

class FakeSink implements EventSink {
  seq = 0
  appended: SessionEvent[] = []
  persisted = new Set<string>()
  updates: RecordedUpdate[] = []
  byId = new Map<string, SessionEvent>()

  append<K extends EventKind>(
    kind: K,
    payload: EventPayloadMap[K],
    options?: { persist?: boolean },
  ): SessionEvent<K> {
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
    this.byId.set(event.id, event)
    if (options?.persist !== false) this.persisted.add(event.id)
    return event as SessionEvent<K>
  }

  update<K extends EventKind>(
    eventId: string,
    payload: EventPayloadMap[K],
    options?: { persist?: boolean; kind?: K },
  ): void {
    this.updates.push({ eventId, payload, persist: options?.persist === true, kind: options?.kind })
    const event = this.byId.get(eventId)
    if (event) {
      event.payload = payload
      if (options?.kind) event.kind = options.kind
    }
    if (options?.persist) this.persisted.add(eventId)
  }
}

function makeMapper() {
  const sink = new FakeSink()
  let sdkSessionId: string | null = null
  const mapper = new MessageMapper({
    sink,
    onSdkSessionId: (id) => {
      sdkSessionId = id
    },
  })
  return { sink, mapper, sdkSessionId: () => sdkSessionId }
}

const asMessage = (value: unknown): SDKMessage => value as SDKMessage

function assistantText(text: string): SDKMessage {
  return asMessage({
    type: 'assistant',
    session_id: 'sdk-1',
    message: { content: [{ type: 'text', text }] },
  })
}

function resultSuccess(overrides: Record<string, unknown> = {}): SDKMessage {
  return asMessage({
    type: 'result',
    subtype: 'success',
    session_id: 'sdk-1',
    result: '',
    total_cost_usd: 0.0123,
    duration_ms: 4200,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  })
}

describe('MessageMapper (contracts/session-events.md)', () => {
  it('captures the SDK session id once from the first message', () => {
    const { mapper, sdkSessionId } = makeMapper()
    mapper.handle(assistantText('hello'))
    mapper.handle(assistantText('again'))
    expect(sdkSessionId()).toBe('sdk-1')
  })

  it('maps final assistant text to assistant_text with partial=false', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(assistantText('Hello world'))
    expect(sink.appended).toHaveLength(1)
    expect(sink.appended[0].kind).toBe('assistant_text')
    expect(sink.appended[0].payload).toEqual({ text: 'Hello world', partial: false })
  })

  it('streams partials in place and persists only the final form', () => {
    const { sink, mapper } = makeMapper()
    const delta = (text: string) =>
      asMessage({
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      })
    mapper.handle(delta('Hel'))
    mapper.handle(delta('lo'))
    expect(sink.appended).toHaveLength(1)
    const partialId = sink.appended[0].id
    expect(sink.persisted.has(partialId)).toBe(false)
    expect(sink.updates.at(-1)?.payload).toEqual({ text: 'Hello', partial: true })

    // The final assistant message replaces its partials by the same event id.
    mapper.handle(assistantText('Hello there'))
    expect(sink.appended).toHaveLength(1)
    const finalUpdate = sink.updates.at(-1)
    expect(finalUpdate?.eventId).toBe(partialId)
    expect(finalUpdate?.payload).toEqual({ text: 'Hello there', partial: false })
    expect(finalUpdate?.persist).toBe(true)
    expect(sink.persisted.has(partialId)).toBe(true)
  })

  it('pairs tool_use and tool_result into one tool_activity updated in place', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'assistant',
        session_id: 'sdk-1',
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git status' } }],
        },
      }),
    )
    expect(sink.appended).toHaveLength(1)
    expect(sink.appended[0].kind).toBe('tool_activity')
    const toolEventId = sink.appended[0].id

    mapper.handle(
      asMessage({
        type: 'user',
        session_id: 'sdk-1',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'On branch main', is_error: false },
          ],
        },
      }),
    )
    expect(sink.appended).toHaveLength(1)
    const update = sink.updates.at(-1)
    expect(update?.eventId).toBe(toolEventId)
    expect(update?.persist).toBe(true)
    expect((update?.payload as { resultPreview: string }).resultPreview).toContain('On branch main')
    expect((update?.payload as { isError: boolean }).isError).toBe(false)
  })

  it('flags tool_result errors on the paired tool_activity', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'assistant',
        session_id: 'sdk-1',
        message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'x' } }] },
      }),
    )
    mapper.handle(
      asMessage({
        type: 'user',
        session_id: 'sdk-1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'boom', is_error: true }],
        },
      }),
    )
    expect((sink.updates.at(-1)?.payload as { isError: boolean }).isError).toBe(true)
  })

  it('ignores plain user text (the composer echoes prompts on delivery)', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'user',
        session_id: 'sdk-1',
        message: { content: [{ type: 'text', text: 'typed elsewhere' }] },
      }),
    )
    expect(sink.appended).toHaveLength(0)
  })

  it('upgrades the closing assistant text to summary when the result repeats it', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(assistantText('All done, 3 files changed.'))
    mapper.handle(resultSuccess({ result: 'All done, 3 files changed.' }))
    const summary = sink.appended.find((e) => e.id === 'e1')
    expect(summary?.kind).toBe('summary')
    const result = sink.appended.find((e) => e.kind === 'result')
    expect(result).toBeDefined()
  })

  it('appends a distinct summary when the result text differs', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(assistantText('working on it'))
    mapper.handle(resultSuccess({ result: 'Final answer.' }))
    const kinds = sink.appended.map((e) => e.kind)
    expect(kinds).toEqual(['assistant_text', 'summary', 'result'])
  })

  it('extracts cost, usage and duration onto the result event', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(resultSuccess({ result: 'done' }))
    const result = sink.appended.find((e) => e.kind === 'result')
    const payload = result?.payload as {
      totalCostUsd: number
      durationMs: number
      usage: { inputTokens: number; outputTokens: number }
    }
    expect(payload.totalCostUsd).toBeCloseTo(0.0123)
    expect(payload.durationMs).toBe(4200)
    expect(payload.usage.inputTokens).toBe(100)
    expect(payload.usage.outputTokens).toBe(50)
  })

  it('maps result errors to a non-fatal error event plus a result event', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sdk-1',
        errors: ['something failed'],
        total_cost_usd: 0.001,
        duration_ms: 100,
        usage: {},
      }),
    )
    const error = sink.appended.find((e) => e.kind === 'error')
    expect(error?.payload).toEqual({ text: 'something failed', fatal: false })
    expect(sink.appended.some((e) => e.kind === 'result')).toBe(true)
  })

  it('emits fatal errors for process death (FR-006)', () => {
    const { sink, mapper } = makeMapper()
    mapper.fatalError('process exited')
    expect(sink.appended[0].kind).toBe('error')
    expect((sink.appended[0].payload as { fatal: boolean }).fatal).toBe(true)
  })

  it('maps thinking blocks and unclassified text to raw_output', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'assistant',
        session_id: 'sdk-1',
        message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
      }),
    )
    mapper.handle(asMessage({ type: 'unknown_kind', session_id: 'sdk-1', text: 'stray output' }))
    expect(sink.appended.map((e) => e.kind)).toEqual(['raw_output', 'raw_output'])
  })

  it('finalises a dangling partial at turn end so nothing is lost', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'orphan' } },
      }),
    )
    mapper.handle(resultSuccess({ result: '' }))
    const update = sink.updates.find(
      (u) => (u.payload as { text: string; partial: boolean }).partial === false,
    )
    expect(update).toBeDefined()
    expect(update?.persist).toBe(true)
  })

  it('assigns seq in arrival order (the only ordering key)', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(assistantText('one'))
    mapper.handle(assistantText('two'))
    mapper.handle(resultSuccess({ result: '' }))
    expect(sink.appended.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('truncates long previews', () => {
    expect(previewOf('x'.repeat(1000)).length).toBeLessThanOrEqual(401)
  })
})

describe('subagent attribution (parent_tool_use_id)', () => {
  it('stamps agentId on subagent events and toolUseId on tool spawns', () => {
    const { sink, mapper } = makeMapper()
    mapper.handle(
      asMessage({
        type: 'assistant',
        session_id: 'sdk-1',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Task', input: { description: 'Scan', subagent_type: 'Explore' } },
          ],
        },
      }),
    )
    mapper.handle(
      asMessage({
        type: 'assistant',
        session_id: 'sdk-1',
        parent_tool_use_id: 'tu-1',
        message: { content: [{ type: 'text', text: 'Reading files…' }] },
      }),
    )
    mapper.handle(assistantText('Main loop update'))

    const [spawn, agentText, mainText] = sink.appended
    expect(spawn.payload).toMatchObject({ toolName: 'Task', toolUseId: 'tu-1' })
    expect((spawn.payload as { agentId?: string }).agentId).toBeUndefined()
    expect(agentText.payload).toMatchObject({ text: 'Reading files…', agentId: 'tu-1' })
    expect((mainText.payload as { agentId?: string }).agentId).toBeUndefined()
  })

  it('streams main and subagent partials independently and only the main text becomes the summary', () => {
    const { sink, mapper } = makeMapper()
    const delta = (text: string, parent?: string): SDKMessage =>
      asMessage({
        type: 'stream_event',
        session_id: 'sdk-1',
        parent_tool_use_id: parent,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      })
    mapper.handle(delta('Main '))
    mapper.handle(delta('agent says hi', 'tu-9'))
    mapper.handle(delta('done'))
    mapper.handle(resultSuccess({ result: 'Main done' }))

    // The main partial finalised to 'Main done' and was upgraded to the turn
    // summary; the subagent's partial finalised untouched with its agentId.
    const mainEvent = sink.appended.find((e) => e.kind === 'summary')
    const agentEvent = sink.appended.find(
      (e) => (e.payload as { agentId?: string }).agentId === 'tu-9',
    )
    expect(mainEvent?.payload).toMatchObject({ text: 'Main done' })
    expect(agentEvent?.payload).toMatchObject({ text: 'agent says hi', partial: false })
    expect(agentEvent?.kind).toBe('assistant_text')
  })
})

// A sink that tags swallowable events with the real classifier, then carries
// the tag through the mapper's assistant_text -> summary upgrade (as the old
// code did) WITHOUT clearing it. This deliberately isolates the progress-rule
// fix: if the rule regressed to matching assistant_text, the upgraded summary
// would carry a noiseKind and this test would fail. A truthy noiseKind is what
// the clean view swallows.
class ClassifyingSink implements EventSink {
  seq = 0
  byId = new Map<string, SessionEvent>()
  rules = defaultSwallowRules()
  private classify(event: SessionEvent): void {
    if (SWALLOWABLE_KINDS.includes(event.kind)) {
      event.noiseKind = classifyNoise(this.rules, event, 'p1')
    }
  }
  append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
    this.seq += 1
    const event: SessionEvent = {
      id: `e${this.seq}`, sessionId: 's1', seq: this.seq, kind, payload,
      noiseKind: null, createdAt: new Date().toISOString(),
    }
    this.classify(event)
    this.byId.set(event.id, event)
    return event as SessionEvent<K>
  }
  update<K extends EventKind>(eventId: string, payload: EventPayloadMap[K], options?: { kind?: K }): void {
    const event = this.byId.get(eventId)
    if (!event) return
    event.payload = payload
    if (options?.kind) event.kind = options.kind
    this.classify(event)
  }
}

describe('the /usage response is not hidden by the clean view (regression)', () => {
  // The real response captured from a session: a summary event, dominated by
  // percentages, that the old bare-percentage progress rule tagged as noise.
  const USAGE_RESPONSE = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 48% used · resets Jul 22, 12:39pm',
    'Current week (all models): 20% used · resets Jul 27, 6:59pm',
    'Current week (Fable): 0% used',
    '  88% of your usage came from subagent-heavy sessions',
  ].join('\n')

  it('classifies the upgraded summary as visible (noiseKind null)', () => {
    const sink = new ClassifyingSink()
    const mapper = new MessageMapper({ sink })
    // Same sequence the CLI emits for /usage: the text arrives as assistant
    // output, then the success result (identical text) upgrades it to a summary.
    mapper.handle(assistantText(USAGE_RESPONSE))
    mapper.handle(resultSuccess({ result: USAGE_RESPONSE }))

    const summary = [...sink.byId.values()].find((e) => e.kind === 'summary')
    expect(summary).toBeDefined()
    // A truthy noiseKind would collapse it into a swallowed block; null renders.
    expect(summary?.noiseKind).toBeNull()
  })

  it('surfaces the result message per-model usage through onModelUsage', () => {
    const sink = new FakeSink()
    const seen: Record<string, unknown>[] = []
    const mapper = new MessageMapper({
      sink,
      onModelUsage: (mu) => seen.push(mu),
    })
    mapper.handle(
      resultSuccess({
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 200,
            costUSD: 0.02,
          },
        },
      }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]['claude-opus-4-8']).toMatchObject({ inputTokens: 100, costUSD: 0.02 })
  })

  it('keeps interactive-question closings as plain assistant text, not summary', () => {
    const { mapper, sink } = makeMapper()
    mapper.handle(
      resultSuccess({
        result:
          'Question 1 of 2\n\nWhich option?\n\n| Option | Description |\n| A | First |\n| B | Second |\n\nYou can reply with the option letter.',
      }),
    )
    expect(sink.appended.some((e) => e.kind === 'summary')).toBe(false)
    expect(sink.appended.some((e) => e.kind === 'assistant_text')).toBe(true)
  })
})
