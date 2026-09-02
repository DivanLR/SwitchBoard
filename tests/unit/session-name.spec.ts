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
  // The section AND the branch: the section says what the session is for, the
  // branch says which checkout it is answering for. Running the same harness on
  // two branches at once is the case that needs both.
  it('names a test run after the section and the branch', () => {
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] }, 'main')).toBe('Tests - main')
  })

  it('names an API run the same way', () => {
    expect(sessionName('s1', { apiRunSessionIds: ['s1'] }, 'release/DL/Fixes')).toBe(
      'API - release/DL/Fixes',
    )
  })

  // A detached head or a session recorded before branches were tracked. The
  // section alone still says more than the bare id it would otherwise show.
  it('names the section alone when the branch is unknown', () => {
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] })).toBe('Tests')
    expect(sessionName('s1', { verifyRunSessionIds: ['s1'] }, null)).toBe('Tests')
  })

  // The description says which drawing this is, which beats the branch, and the
  // two together do not fit the row.
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

  // The kinds that leave no run row behind. A spec action, a diff comment and a
  // cleanup command each take a session of their own now, and without this every
  // one of them read as the bare branch — three rows a developer cannot tell
  // apart, which is the exact problem this function exists to solve.
  it('names a section that leaves no run row behind', () => {
    expect(sessionName('s1', { kinds: { s1: 'cleanup' } }, 'main')).toBe('Cleanup - main')
    expect(sessionName('s1', { kinds: { s1: 'diff' } })).toBe('Diff')
    expect(sessionName('s1', { kinds: { s1: 'spec' } }, 'main')).toBe('Specs - main')
  })

  // The live kind is what the session IS; a run row only says what it once did.
  it('prefers the live kind over a stale run row', () => {
    expect(sessionName('s1', { kinds: { s1: 'cleanup' }, verifyRunSessionIds: ['s1'] })).toBe(
      'Cleanup',
    )
  })

  it("leaves another session's kind alone", () => {
    expect(sessionName('mine', { kinds: { theirs: 'tests' } })).toBeNull()
  })

  // A FINISHED section session says so, rather than carrying a branch. Once the
  // work is over the useful fact is that it succeeded; the branch is shared with
  // every other session on the same checkout and tells the rows apart least.
  it('reads "<Section> - Complete" once its work finished successfully', () => {
    expect(sessionName('s1', { kinds: { s1: 'diagram' } }, 'main', 'completed')).toBe(
      'Diagram - Complete',
    )
    expect(sessionName('s1', { kinds: { s1: 'tests' } }, 'main', 'completed')).toBe(
      'Tests - Complete',
    )
  })

  // Only 'completed' earns it. A session someone stopped, or one that crashed,
  // did not finish its work, and saying "Complete" over either would be a lie
  // told in the one place the developer looks to find out what happened.
  it('keeps the branch for any ending that is not a success', () => {
    for (const reason of ['stopped', 'crashed', 'app_exit'] as const) {
      expect(sessionName('s1', { kinds: { s1: 'diagram' } }, 'main', reason)).toBe('Diagram - main')
    }
    // Still running: no ending to report at all.
    expect(sessionName('s1', { kinds: { s1: 'diagram' } }, 'main', null)).toBe('Diagram - main')
  })


  // AN ISOLATED RUN IS A QUEUE OF ONE-SUITE SESSIONS. Every one of them is
  // "Tests" against the same checkout, so the branch tells them apart least and
  // the suite tells them apart completely.
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

  // A shared-container run has no per-suite session, so nothing changes there.
  it('falls back to the branch when no suite is named', () => {
    expect(sessionName('s1', { kinds: { s1: 'tests' } }, 'main')).toBe('Tests - main')
  })
})
