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
    expect(settings.modelMode).toBe('auto')
    expect(settings.autoModelRouting).toBe(true)

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

describe('reading a settings row an install already stored', () => {
  it('keeps the model modes and both models exactly as stored', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({
        intelligentModel: 'claude-fable-5',
        workerModel: 'claude-haiku-4-5',
        modelMode: 'basic',
        autoModelRouting: false,
        effort: 'high',
      }),
    })

    const stored = settings.get()
    expect(stored.intelligentModel).toBe('claude-fable-5')
    expect(stored.workerModel).toBe('claude-haiku-4-5')
    expect(stored.modelMode).toBe('basic')
    expect(stored.autoModelRouting).toBe(false)
    expect(stored.effort).toBe('high')
  })

  it('drops every key the settings no longer have, on read and so on the next write', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    const retired = {
      model: 'claude-opus-5',
      flowConcurrency: 4,
      heavySubagents: true,
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ intelligentModel: 'claude-opus-5', ...retired }),
    })

    expect(Object.keys(settings.get()).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    settings.set({ effort: 'high' })
    const stored = JSON.parse(
      (db.prepare(`SELECT value FROM settings WHERE key = 'settings'`).get() as { value: string })
        .value,
    ) as Record<string, unknown>
    for (const key of Object.keys(retired)) expect(stored).not.toHaveProperty(key)
  })

  it('keeps the container settings an older install stored', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ sandboxMemory: '12G', projectIsolatedRuns: { p: true } }),
    })

    expect(settings.get().sandboxMemory).toBe('12G')
    expect(settings.get().projectIsolatedRuns).toEqual({ p: true })
    expect(DEFAULT_SETTINGS.sandboxMemory).toBe('6g')
  })

  it('keeps the Codex engine and model an older install stored', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ defaultEngine: 'codex', codexModel: 'gpt-5-codex' }),
    })

    expect(settings.get().defaultEngine).toBe('codex')
    expect(settings.get().codexModel).toBe('gpt-5-codex')
    expect(DEFAULT_SETTINGS.defaultEngine).toBe('claude')
  })
})
