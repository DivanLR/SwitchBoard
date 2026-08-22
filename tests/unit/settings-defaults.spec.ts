// What a BRAND-NEW install arrives with.
//
// The app has no first-run questionnaire: it ships DEFAULT_SETTINGS and the
// developer changes what they want. That makes the constant the whole onboarding
// experience, and every one of these four was a setting the developer had to
// re-find in the Models tab on every fresh machine.
//
// Asserted through SettingsRepo on an empty database rather than against the
// constant directly, because that is the path a new install actually takes —
// `get()` on a missing row. Asserting the constant equals itself would pass even
// if `get()` stopped returning it.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/store/db'
import { createRepositories } from '../../src/main/store/repositories'
import { DEFAULT_SETTINGS } from '@shared/domain'

describe('a fresh install', () => {
  const fresh = (): ReturnType<typeof createRepositories>['settings'] =>
    createRepositories(openDatabase(':memory:')).settings

  it('arrives with the strong model, the worker, heavy subagents and summaries on', () => {
    const settings = fresh().get()

    // Named models, not the account default: 'default' means "whatever the
    // subscription happens to be", which is the trip to Settings this avoids.
    expect(settings.intelligentModel).not.toBe('default')
    expect(settings.workerModel).not.toBe('default')
    expect(settings.intelligentModel).not.toBe(settings.workerModel)

    expect(settings.heavySubagents).toBe(true)
    expect(settings.summaries).toBe(true)
  })

  it('names the intelligent model concretely, not by family alias', () => {
    // The Models tab marks its selected card by matching this against a
    // CLI-REPORTED model id. A family alias ('opus') matches no card, so the
    // picker would open with nothing selected and read as broken.
    for (const id of [DEFAULT_SETTINGS.intelligentModel, DEFAULT_SETTINGS.workerModel]) {
      expect(id).toMatch(/^claude-/)
    }
  })

  it('still lets the developer switch any of them off', () => {
    // The defaults are a starting point, not a policy: a stored false must
    // survive being merged over DEFAULT_SETTINGS, or switching off would appear
    // to work and silently revert on the next read.
    const settings = fresh()
    settings.set({ heavySubagents: false, summaries: false })

    expect(settings.get().heavySubagents).toBe(false)
    expect(settings.get().summaries).toBe(false)
  })
})
