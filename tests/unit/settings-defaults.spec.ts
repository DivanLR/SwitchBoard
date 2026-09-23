import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/store/db'
import { createRepositories } from '../../src/main/store/repositories'
import { DEFAULT_SETTINGS } from '@shared/domain'

describe('a fresh install', () => {
  const fresh = (): ReturnType<typeof createRepositories>['settings'] =>
    createRepositories(openDatabase(':memory:')).settings

  it('arrives with a model, xhigh effort and summaries on', () => {
    const settings = fresh().get()

    expect(settings.model).not.toBe('default')
    expect(settings.effort).toBe('xhigh')
    expect(settings.subagentEffort).toBe('low')
    expect(settings.summaries).toBe(true)
  })

  it('names the model concretely, not by family alias', () => {
    expect(DEFAULT_SETTINGS.model).toMatch(/^claude-/)
  })

  it('still lets the developer switch any of them off', () => {
    const settings = fresh()
    settings.set({ effort: 'low', summaries: false })

    expect(settings.get().effort).toBe('low')
    expect(settings.get().summaries).toBe(false)
  })
})

describe('migrating a settings row from before the model rename', () => {
  it('carries an old intelligentModel value forward as model, and drops the routing keys', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('settings', @value)`,
    ).run({
      value: JSON.stringify({
        intelligentModel: 'claude-fable-5',
        workerModel: 'claude-sonnet-5',
        modelMode: 'auto',
        autoModelRouting: true,
        effort: 'high',
      }),
    })

    const migrated = settings.get()
    expect(migrated.model).toBe('claude-fable-5')
    expect(migrated.effort).toBe('high')
    expect(migrated).not.toHaveProperty('intelligentModel')
    expect(migrated).not.toHaveProperty('workerModel')
    expect(migrated).not.toHaveProperty('modelMode')
    expect(migrated).not.toHaveProperty('autoModelRouting')
  })
})
