import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/store/db'
import { createRepositories } from '../../src/main/store/repositories'
import { DEFAULT_SETTINGS } from '@shared/domain'

describe('a fresh install', () => {
  const fresh = (): ReturnType<typeof createRepositories>['settings'] =>
    createRepositories(openDatabase(':memory:')).settings

  it('arrives with the strong model, the worker, xhigh effort and summaries on', () => {
    const settings = fresh().get()

    expect(settings.intelligentModel).not.toBe('default')
    expect(settings.workerModel).not.toBe('default')
    expect(settings.intelligentModel).not.toBe(settings.workerModel)

    expect(settings.effort).toBe('xhigh')
    expect(settings.subagentEffort).toBe('low')
    expect(settings.summaries).toBe(true)
  })

  it('names the intelligent model concretely, not by family alias', () => {
    for (const id of [DEFAULT_SETTINGS.intelligentModel, DEFAULT_SETTINGS.workerModel]) {
      expect(id).toMatch(/^claude-/)
    }
  })

  it('still lets the developer switch any of them off', () => {
    const settings = fresh()
    settings.set({ effort: 'low', summaries: false })

    expect(settings.get().effort).toBe('low')
    expect(settings.get().summaries).toBe(false)
  })
})
