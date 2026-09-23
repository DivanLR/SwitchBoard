import { describe, expect, it } from 'vitest'
import { modelDeviation } from '@main/sessions/model-fallback'

describe('modelDeviation', () => {
  it('catches a turn that moved to another family', () => {
    expect(modelDeviation('claude-fable-5-20260301', 'claude-opus-5[1m]')).toBe(true)
    expect(modelDeviation('claude-sonnet-5', 'claude-opus-5')).toBe(true)
  })

  it('is quiet when the reported id is the configured model wearing a date or alias', () => {
    expect(modelDeviation('claude-opus-5-20260101', 'claude-opus-5[1m]')).toBe(false)
    expect(modelDeviation('claude-opus-5[1m]', 'claude-opus-5[1m]')).toBe(false)
  })

  it('says nothing when there is nothing to compare against', () => {
    expect(modelDeviation('claude-fable-5', 'default')).toBe(false)
    expect(modelDeviation('claude-fable-5', undefined)).toBe(false)
    expect(modelDeviation(undefined, 'claude-opus-5')).toBe(false)
  })

  it('treats an unrecognised family as no evidence, in either direction', () => {
    expect(modelDeviation('some-new-model-1', 'claude-opus-5')).toBe(false)
    expect(modelDeviation('claude-opus-5', 'some-new-model-1')).toBe(false)
  })
})
