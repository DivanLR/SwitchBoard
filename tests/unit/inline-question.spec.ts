// Inline clarify-question detection + option parsing (Spec Kit idiom).
import { describe, expect, it } from 'vitest'
import { isInteractiveQuestion, parseInlineQuestion } from '@shared/inline-question'

// Real /speckit-clarify closing message (markdown table flowed onto one line).
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
