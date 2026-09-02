// The model list is read from the CLI and everything cosmetic is derived from the
// id, so a newly released Claude model needs no code change. These checks pin
// that: an id the app has never seen still gets a label, a price and a rung.
import { describe, expect, it } from 'vitest'
import { modelFamily, modelLabel, modelPrice } from '@shared/domain'
import { toAvailableModels } from '@main/sessions/model-catalog'

describe('modelLabel (derived display name)', () => {
  it('derives a versioned name from any model id', () => {
    expect(modelLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)')
    expect(modelLabel('claude-fable-5')).toBe('Fable 5')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('sonnet')).toBe('Sonnet')
  })

  it('names a model the app has never seen', () => {
    expect(modelLabel('claude-opus-7-2[1m]')).toBe('Opus 7.2 (1M)')
    expect(modelLabel('claude-mythos-6')).toBe('Mythos 6')
  })

  it('labels the account default and empty ids', () => {
    expect(modelLabel('default')).toBe('Account default')
    expect(modelLabel('')).toBe('Account default')
  })
})

describe('modelPrice / modelFamily (family-derived hints)', () => {
  it('prices by family, so a new release inherits its family hint', () => {
    expect(modelPrice('claude-fable-9')).toBe('$$$')
    expect(modelPrice('claude-opus-7-2[1m]')).toBe('$$$')
    expect(modelPrice('claude-sonnet-6')).toBe('$$')
    expect(modelPrice('claude-haiku-5')).toBe('$')
  })

  it('admits when a family is unrecognised rather than guessing', () => {
    expect(modelFamily('claude-mythos-6')).toBeNull()
    expect(modelPrice('claude-mythos-6')).toBe('—')
  })
})

describe('toAvailableModels (SDK report → selectable list)', () => {
  it('keys on the canonical wire id and drops the default alias row', () => {
    const models = toAvailableModels([
      { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    ])
    // The default row must not claim Opus 5's id, or Opus 5 loses its own card.
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5[1m]', 'claude-sonnet-5'])
    expect(models[0]?.label).toBe('Opus (1M context)')
  })

  it('dedupes aliases of one model and tolerates missing fields', () => {
    const models = toAvailableModels([
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
      { value: 'claude-sonnet-5' },
      { value: '' },
    ])
    expect(models).toEqual([{ id: 'claude-sonnet-5', label: 'claude-sonnet-5', description: '' }])
  })
})

// A model released after this code was written must need no code change. Fable
// 5.1 is the live example: the CLI did not report it yet, and the question was
// whether the app would show it once the CLI did.
describe('a model the app has never seen', () => {
  it('gets a label, a family, a price and a downgrade rung from its id alone', () => {
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)')
    expect(modelFamily('claude-fable-5-1')).toBe('fable')
    expect(modelPrice('claude-fable-5-1')).toBe('$$$')
  })

  // An entirely unknown family still renders rather than breaking the picker.
  it('still renders an unrecognised family, without claiming a price it cannot know', () => {
    expect(modelLabel('claude-quartz-2')).toBe('Quartz 2')
    expect(modelFamily('claude-quartz-2')).toBeNull()
    expect(modelPrice('claude-quartz-2')).toBe('—')
  })

  // The alias and the resolved id collapse to one row, which is what stops a new
  // release appearing twice in the picker.
  it('collapses an alias onto the id it resolves to', () => {
    const models = toAvailableModels([
      { value: 'default', resolvedModel: 'claude-fable-5-1' },
      { value: 'fable[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
      { value: 'claude-fable-5-1', displayName: 'Fable 5.1' },
    ])
    expect(models.map((m) => m.id)).toEqual(['claude-fable-5-1'])
  })
})
