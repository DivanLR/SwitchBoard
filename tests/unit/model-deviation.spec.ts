// A turn that ran on a model the app did not ask for.
//
// Claude Code honours a skill's own `model:` frontmatter, and one of the
// commands this app dispatches carries it: /speckit-implement-scaffold asks for
// Fable 5. A session configured for Opus therefore runs that turn on Fable —
// the skill working as written — and used to STAY there, because the app's
// applied-model cache still held what it had last asked for. Settings said Opus
// and every later turn ran on Fable, with nothing connecting the two.
import { describe, expect, it } from 'vitest'
import { modelDeviation } from '@main/sessions/model-routing'

describe('modelDeviation', () => {
  it('catches a turn that moved to another family', () => {
    expect(modelDeviation('claude-fable-5-20260301', 'claude-opus-5[1m]')).toBe(true)
    expect(modelDeviation('claude-sonnet-5', 'claude-opus-5')).toBe(true)
  })

  it('is quiet when the reported id is the configured model wearing a date or alias', () => {
    // The whole reason this compares families: the SDK answers with a dated id
    // against a configured alias, and calling that a deviation would fire on
    // every turn of every session.
    expect(modelDeviation('claude-opus-5-20260101', 'claude-opus-5[1m]')).toBe(false)
    expect(modelDeviation('claude-opus-5[1m]', 'claude-opus-5[1m]')).toBe(false)
  })

  it('says nothing when there is nothing to compare against', () => {
    // 'default' means the account chooses, so no model is being contradicted.
    expect(modelDeviation('claude-fable-5', 'default')).toBe(false)
    expect(modelDeviation('claude-fable-5', undefined)).toBe(false)
    expect(modelDeviation(undefined, 'claude-opus-5')).toBe(false)
  })

  it('treats an unrecognised family as no evidence, in either direction', () => {
    // A model released after this build should not be reported as a deviation
    // on the strength of a name the app does not know yet.
    expect(modelDeviation('some-new-model-1', 'claude-opus-5')).toBe(false)
    expect(modelDeviation('claude-opus-5', 'some-new-model-1')).toBe(false)
  })
})
