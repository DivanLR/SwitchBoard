import { describe, expect, it } from 'vitest'
import { isInteractiveQuestion, parseInlineQuestion, pendingQuestion } from '@shared/inline-question'

const CLARIFY = `Contract defines run-level passRate and metric-level pass booleans, but never what makes a single test case pass. Asking max 2 questions, one at a time.

Question 1 of 2

What makes an individual golden-set test case count as "passed" for the run's pass rate (passRate over testCount)?

Recommended: Option A - Matches the existing deterministic retrieval harness, keeps nightly pass rate stable.

| Option | Description | |--------|-------------| | A | Retrieval-only: case passes when its expected path/symbol appears in top-k results | | B | Strict: case passes only when retrieval expectation is met AND every applicable LLM-judged score meets its threshold | | C | No per-case notion: pass rate = share of metrics currently above threshold | | Short | Provide a different short answer (<=5 words) |

You can reply with the option letter (e.g., "A"), accept the recommendation by saying "yes" or "recommended", or provide your own short answer.`

describe('inline questions', () => {
  it('detects the clarify idiom and not ordinary summaries', () => {
    expect(isInteractiveQuestion(CLARIFY)).toBe(true)
    expect(isInteractiveQuestion('Implemented rotating refresh tokens across 3 files.')).toBe(false)
    expect(isInteractiveQuestion('Any questions? Reply if unsure.')).toBe(false)
  })

  it('parses options, marks the recommended one, drops header/separator/Short', () => {
    const q = parseInlineQuestion(CLARIFY)
    expect(q).not.toBeNull()
    expect(q!.options.map((o) => o.label)).toEqual(['A (Recommended)', 'B', 'C'])
    expect(q!.options[1].description).toContain('Strict')
    expect(q!.answered).toBe(false)
  })

  it('parses multi-line tables too', () => {
    const text = [
      'Question 1 of 1',
      '| Option | Description |',
      '|--------|-------------|',
      '| A | First choice |',
      '| B | Second choice |',
    ].join('\n')
    const q = parseInlineQuestion(text)
    expect(q!.options.map((o) => o.label)).toEqual(['A', 'B'])
  })

  it('returns null for question-marker text without a usable table', () => {
    expect(parseInlineQuestion('Question 1 of 2\nWhat should the default be?')).toBeNull()
  })
})

describe('pendingQuestion', () => {
  const ev = (id: string, kind: string, text?: string) => ({ id, kind, payload: { text } })
  const QUESTION =
    'Question 1 of 1\n\n| Option | Description |\n| A | Six per-domain sheets |\n| B | One wall chart |\n\nReply with the option letter.'

  it('finds the question a session is waiting on', () => {
    const found = pendingQuestion([ev('e1', 'assistant_text', QUESTION)])
    expect(found?.eventId).toBe('e1')
    expect(found?.payload.options.map((o) => o.label)).toEqual(['A', 'B'])
  })

  it('is null once a prompt follows the question', () => {
    expect(
      pendingQuestion([ev('e1', 'assistant_text', QUESTION), ev('e2', 'prompt', 'A')]),
    ).toBeNull()
  })

  it('looks past tool activity and results between the question and now', () => {
    const found = pendingQuestion([
      ev('e1', 'assistant_text', QUESTION),
      ev('e2', 'tool_activity'),
      ev('e3', 'result'),
    ])
    expect(found?.eventId).toBe('e1')
  })

  it('is null for a card the developer has just answered', () => {
    expect(pendingQuestion([ev('e1', 'assistant_text', QUESTION)], 'e1')).toBeNull()
  })

  it('is null for ordinary output, and for an empty session', () => {
    expect(pendingQuestion([ev('e1', 'assistant_text', 'Wrote the file.')])).toBeNull()
    expect(pendingQuestion([])).toBeNull()
  })

  it('answers about the most recent question, not the first', () => {
    const found = pendingQuestion([
      ev('e1', 'assistant_text', QUESTION),
      ev('e2', 'prompt', 'A'),
      ev('e3', 'assistant_text', QUESTION),
    ])
    expect(found?.eventId).toBe('e3')
  })

  describe('a question asked as a tool call', () => {
    const asked = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      kind: 'question',
      payload: {
        text: 'Which authentication should the scanner use?',
        options: [{ label: 'Device code' }, { label: 'Personal access token' }],
        answered: false,
        ...over,
      },
    })

    it('is offered with its options', () => {
      const found = pendingQuestion([asked('q1')])
      expect(found?.eventId).toBe('q1')
      expect(found?.payload.options.map((o) => o.label)).toEqual([
        'Device code',
        'Personal access token',
      ])
    })

    it('is gone once answered, by the record on the event or by this click', () => {
      expect(pendingQuestion([asked('q1', { answered: true })])).toBeNull()
      expect(pendingQuestion([asked('q1')], 'q1')).toBeNull()
    })

    it('is gone once the run has moved on past it', () => {
      expect(pendingQuestion([asked('q1'), ev('e2', 'assistant_text', 'Wrote plan.md.')])).toBeNull()
    })

    it('is ignored when it carries no options to choose from', () => {
      expect(pendingQuestion([asked('q1', { options: [] })])).toBeNull()
    })
  })
})
