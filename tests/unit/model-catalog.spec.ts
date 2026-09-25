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
  it('keeps only the newest model of each family, by its alias when it has one, and drops the default row', () => {
    const models = toAvailableModels([
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
      { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5' },
      { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5' },
      { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)' },
    ])
    expect(models.map((m) => m.id)).toEqual(['opus', 'claude-fable-5-1', 'sonnet', 'haiku', 'opus[1m]'])
    expect(models.map((m) => m.label)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5', 'Opus 5.5 (1M)'])
  })

  it('compares versions as numbers, so 4.10 beats 4.9 and 5 beats 4.8, whatever order they arrive in', () => {
    const models = toAvailableModels([
      { value: 'claude-opus-4-9' },
      { value: 'claude-opus-4-10' },
      { value: 'claude-sonnet-5' },
      { value: 'claude-sonnet-4-8' },
    ])
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-10', 'claude-sonnet-5'])
  })

  it('treats a dated build as the same version, and keeps the first of two equals', () => {
    const models = toAvailableModels([
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
      { value: 'claude-haiku-4-5' },
    ])
    expect(models.map((m) => m.id)).toEqual(['haiku'])
  })

  it('prefers the alias to an explicit id of the same build, whichever comes first', () => {
    const models = toAvailableModels([
      { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5' },
    ])
    expect(models.map((m) => m.id)).toEqual(['opus'])
  })

  it('tolerates missing fields', () => {
    const models = toAvailableModels([
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
      { value: 'claude-sonnet-5' },
      { value: '' },
    ])
    expect(models).toEqual([{ id: 'sonnet', label: 'Sonnet 5', description: '', engine: 'claude' }])
  })
})

describe('a model the app has never seen', () => {
  it('gets a label, a family, a price and a downgrade rung from its id alone', () => {
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)')
    expect(modelFamily('claude-fable-5-1')).toBe('fable')
    expect(modelPrice('claude-fable-5-1')).toBe('$$$')
  })

  it('still renders an unrecognised family, without claiming a price it cannot know', () => {
    expect(modelLabel('claude-quartz-2')).toBe('Quartz 2')
    expect(modelFamily('claude-quartz-2')).toBeNull()
    expect(modelPrice('claude-quartz-2')).toBe('—')
  })

  it('keeps each version of a family it cannot name, rather than guessing which is newest', () => {
    const models = toAvailableModels([{ value: 'claude-quartz-2' }, { value: 'claude-quartz-3' }])
    expect(models.map((m) => m.id)).toEqual(['claude-quartz-2', 'claude-quartz-3'])
  })
})
