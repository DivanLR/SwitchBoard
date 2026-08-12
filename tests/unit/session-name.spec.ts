// Every session of a project runs against the same checkout, so the branch name
// is identical on all of them and a project running three showed one repeated
// row with nothing to tell them apart. A section's session does know what it was
// started for; a conversation does not, and says so by staying unnamed.
//
// Derived rather than stored on purpose: a name written at session start would
// be blank for every session that already exists, and would need a migration to
// hold a fact the app can already work out.
import { describe, expect, it } from 'vitest'
import { sessionName } from '@shared/domain'

describe('sessionName', () => {
  it('names a verification run', () => {
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] })).toBe('Verification run')
  })

  it('names an API run', () => {
    expect(sessionName('s1', { apiRunSessionIds: ['s1'] })).toBe('API run')
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
    expect(sessionName('s1', { verifyRunSessionIds: ['other'], apiRunSessionIds: ['other'] })).toBeNull()
  })

  it('never confuses one session with another project’s work', () => {
    expect(
      sessionName('mine', {
        verifyRunSessionIds: ['theirs'],
        diagrams: [{ sessionId: 'theirs', description: 'Their diagram' }],
      }),
    ).toBeNull()
  })

  // A diagram request can be recorded before any session ran, so its sessionId is
  // null. Matching null against a real id would name an unrelated session.
  it('ignores a diagram that has no session behind it', () => {
    expect(sessionName('s1', { diagrams: [{ sessionId: null, description: 'Orphan' }] })).toBeNull()
  })

  it('falls back to a plain label when the description slugifies to nothing', () => {
    expect(sessionName('s1', { diagrams: [{ sessionId: 's1', description: '   ' }] })).toBe('Diagram')
  })
})
