import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/store/db'
import { createRepositories } from '../../src/main/store/repositories'
import { DEFAULT_SETTINGS } from '@shared/domain'

describe('a fresh install', () => {
  const fresh = (): ReturnType<typeof createRepositories>['settings'] =>
    createRepositories(openDatabase(':memory:')).settings

  it('arrives on Basic with the newest Opus, xhigh effort and summaries on', () => {
    const settings = fresh().get()

    expect(settings.model).toBe('opus')
    expect(settings.modelMode).toBe('basic')
    expect(settings.autoModelRouting).toBe(true)
    expect(settings.jevSwitchLimit).toBe(60)

    expect(settings.effort).toBe('xhigh')
    expect(settings.subagentEffort).toBe('low')
    expect(settings.summaries).toBe(true)
  })

  it('names the Model by family alias, so it always resolves to the newest build', () => {
    expect(DEFAULT_SETTINGS.model).toBe('opus')
    expect(DEFAULT_SETTINGS).not.toHaveProperty('intelligentModel')
    expect(DEFAULT_SETTINGS).not.toHaveProperty('workerModel')
  })

  it('still lets the developer switch any of them off', () => {
    const settings = fresh()
    settings.set({ effort: 'low', summaries: false })

    expect(settings.get().effort).toBe('low')
    expect(settings.get().summaries).toBe(false)
  })
})

describe('reading a settings row an install already stored', () => {
  it('moves a stored intelligent model to the one Model, keeping a Fable id and aliasing an older Opus', () => {
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
    expect(stored.model).toBe('claude-fable-5')
    expect(stored.modelMode).toBe('basic')
    expect(stored.autoModelRouting).toBe(false)
    expect(stored.effort).toBe('high')
  })

  it('drops every key the settings no longer have, on read and so on the next write', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    const retired = {
      intelligentModel: 'claude-opus-4-8',
      workerModel: 'claude-sonnet-5',
      flowConcurrency: 4,
      heavySubagents: true,
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ model: 'claude-opus-4', ...retired }),
    })

    expect(Object.keys(settings.get()).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    expect(settings.get().model).toBe('opus')
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

  it('reads a retired Advisor or Orchestrator mode back as Basic, and defaults the switch limit', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ modelMode: 'advisor' }),
    })
    expect(settings.get().modelMode).toBe('basic')
    expect(settings.get().jevSwitchLimit).toBe(60)

    db.prepare(`UPDATE settings SET value = @value WHERE key = 'settings'`).run({
      value: JSON.stringify({ modelMode: 'orchestrator' }),
    })
    expect(settings.get().modelMode).toBe('basic')
  })

  it('reads a retired Auto mode as Jev, which startup then settles to Basic when no key is saved', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ modelMode: 'auto' }),
    })
    expect(settings.get().modelMode).toBe('jev')
  })

  it('keeps Jev mode and a stored switch limit as an install set them', () => {
    const db = openDatabase(':memory:')
    const settings = createRepositories(db).settings
    db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', @value)`).run({
      value: JSON.stringify({ modelMode: 'jev', jevSwitchLimit: 120 }),
    })
    expect(settings.get().modelMode).toBe('jev')
    expect(settings.get().jevSwitchLimit).toBe(120)
  })
})
