import { describe, expect, it } from 'vitest'
import { sessionName } from '@shared/domain'

describe('sessionName', () => {
  it('names a test run after the section and the branch', () => {
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] }, 'main')).toBe('Tests - main')
  })

  it('names the section alone when the branch is unknown', () => {
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] })).toBe('Tests')
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] }, null)).toBe('Tests')
  })

  it('leaves a diagram named after its description, not the branch', () => {
    expect(
      sessionName('s1', { diagrams: [{ sessionId: 's1', description: 'Auth flow' }] }, 'main'),
    ).toBe('Diagram: Auth flow')
  })

  it('names a diagram after the sentence that asked for it', () => {
    const name = sessionName('s1', {
      diagrams: [{ sessionId: 's1', description: 'Auth flow from login to session refresh' }],
    })
    expect(name).toBe('Diagram: Auth flow from login to session')
  })

  it('caps a long description rather than naming a row after a paragraph', () => {
    const name = sessionName('s1', {
      diagrams: [
        {
          sessionId: 's1',
          description: 'one two three four five six seven eight nine ten eleven twelve',
        },
      ],
    })
    expect(name).toBe('Diagram: one two three four five six')
  })

  it('leaves a conversation unnamed, because there is no such fact about it', () => {
    expect(sessionName('s1', {})).toBeNull()
    expect(sessionName('s1', { verifyRunSessionIds: ['other'] })).toBeNull()
  })

  it('never confuses one session with another project’s work', () => {
    expect(
      sessionName('mine', {
        verifyRunSessionIds: ['theirs'],
        diagrams: [{ sessionId: 'theirs', description: 'Their diagram' }],
      }),
    ).toBeNull()
  })

  it('ignores a diagram that has no session behind it', () => {
    expect(sessionName('s1', { diagrams: [{ sessionId: null, description: 'Orphan' }] })).toBeNull()
  })

  it('falls back to a plain label when the description slugifies to nothing', () => {
    expect(sessionName('s1', { diagrams: [{ sessionId: 's1', description: '   ' }] })).toBe('Diagram')
  })

  it('names a section that leaves no run row behind', () => {
    expect(sessionName('s1', { kinds: { s1: 'flow' } }, 'main')).toBe('Flow - main')
    expect(sessionName('s1', { kinds: { s1: 'diff' } })).toBe('Diff')
    expect(sessionName('s1', { kinds: { s1: 'flow' } }, 'main')).toBe('Flow - main')
  })

  it('prefers the live kind over a stale run row', () => {
    expect(sessionName('s1', { kinds: { s1: 'flow' }, verifyRunSessionIds: ['s1'] })).toBe(
      'Flow',
    )
  })

  it("leaves another session's kind alone", () => {
    expect(sessionName('mine', { kinds: { theirs: 'tests' } })).toBeNull()
  })

  it('reads "<Section> - Complete" once its work finished successfully', () => {
    expect(sessionName('s1', { kinds: { s1: 'diagram' } }, 'main', 'completed')).toBe(
      'Diagram - Complete',
    )
    expect(sessionName('s1', { kinds: { s1: 'tests' } }, 'main', 'completed')).toBe(
      'Tests - Complete',
    )
  })

  it('keeps the branch for any ending that is not a success', () => {
    for (const reason of ['stopped', 'crashed', 'app_exit'] as const) {
      expect(sessionName('s1', { kinds: { s1: 'diagram' } }, 'main', reason)).toBe('Diagram - main')
    }
    expect(sessionName('s1', { kinds: { s1: 'diagram' } }, 'main', null)).toBe('Diagram - main')
  })

  it('names an isolated test session by its suite, not by the shared branch', () => {
    expect(
      sessionName('s1', { kinds: { s1: 'tests' }, suites: { s1: 'Unit' } }, 'main'),
    ).toBe('Tests: Unit')
    expect(
      sessionName('s2', { kinds: { s2: 'tests' }, suites: { s2: 'HTTP smoke' } }, 'main'),
    ).toBe('Tests: HTTP smoke')
  })

  it('still says Complete when that suite finished', () => {
    expect(
      sessionName('s1', { kinds: { s1: 'tests' }, suites: { s1: 'Unit' } }, 'main', 'completed'),
    ).toBe('Tests: Unit - Complete')
  })

  it('falls back to the branch when no suite is named', () => {
    expect(sessionName('s1', { kinds: { s1: 'tests' } }, 'main')).toBe('Tests - main')
  })

  it('names a Skills section session after its section', () => {
    expect(sessionName('s1', { kinds: { s1: 'skills' } }, 'main')).toBe('Skills - main')
  })

  it('names a session the SDD tab started after the tab', () => {
    expect(sessionName('s1', { kinds: { s1: 'spec' } }, 'main')).toBe('SDD - main')
  })

  it.each(['cleanup', 'security'])(
    'gives no name to a session from the retired %s section, rather than "undefined"',
    (retired) => {
      const kinds = { s1: retired } as never
      expect(sessionName('s1', { kinds }, 'main', 'completed')).toBeNull()
      expect(sessionName('s1', { kinds }, null, 'app_exit')).toBeNull()
    },
  )
})
