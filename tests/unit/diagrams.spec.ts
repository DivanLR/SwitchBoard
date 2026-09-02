// Diagrams section: the pure naming/prompt rules in src/shared/diagram.ts, which
// every process (main, renderer, tests) must agree on without a database, plus
// DiagramRequestsRepo against a real in-memory database, in the conventions of
// verify-runs.spec.ts (openDatabase(':memory:') + createRepositories, never a mock).
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { DIAGRAMS_DIR, diagramFileName, diagramPrompt } from '@shared/diagram'

describe('diagramFileName', () => {
  // A NAME THE DEVELOPER TYPED goes through the same slugifier as a derived one,
  // which is what makes it safe to accept at all: whatever they type can only
  // reach the filesystem as [a-z0-9-] plus `.html`.
  it('cannot be talked into a separator, a traversal or an extension of its own', () => {
    expect(diagramFileName('../../etc/passwd')).toBe('etc-passwd.html')
    expect(diagramFileName('docs/diagrams/thing.html')).toBe('docs-diagrams-thing-html.html')
    expect(diagramFileName('..')).toBe('diagram.html')
    expect(diagramFileName(String.raw`C:\Windows\System32`)).toBe('c-windows-system32.html')
  })

  // Six words is right for a name derived from a SENTENCE, where the tail is
  // prose. A typed name is already the short version, so that path asks for more
  // rather than editing the developer's own words down for them.
  it('keeps more of a name the developer typed than of a sentence', () => {
    const long = 'one two three four five six seven eight'
    expect(diagramFileName(long)).toBe('one-two-three-four-five-six.html')
    expect(diagramFileName(long, [], 12)).toBe('one-two-three-four-five-six-seven-eight.html')
  })

  // Naming two diagrams the same thing is a revision, not an overwrite, and that
  // has to hold for a typed name as much as for a derived one.
  it('uniquifies a typed name against the folder', () => {
    expect(diagramFileName('auth flow', ['auth-flow.html'], 12)).toBe('auth-flow-2.html')
  })

  it('slugifies a sentence into a short kebab-case .html name', () => {
    expect(diagramFileName('Auth flow for login')).toBe('auth-flow-for-login.html')
  })

  it('caps the length rather than naming the file after a whole paragraph', () => {
    const name = diagramFileName(
      'This is a very long description of a diagram with far more words than anyone needs in a file name',
    )
    // Capped at 6 words (see diagram.ts slice(0, 6)); a name this short cannot have
    // absorbed the whole paragraph.
    expect(name.replace(/\.html$/, '').split('-')).toHaveLength(6)
  })

  it('never collides: a second request for the same subject gets a distinct name', () => {
    const first = diagramFileName('Auth flow')
    const second = diagramFileName('Auth flow', [first])
    const third = diagramFileName('Auth flow', [first, second])
    expect(new Set([first, second, third]).size).toBe(3)
    expect(second).toBe('auth-flow-2.html')
    expect(third).toBe('auth-flow-3.html')
  })

  it('still returns a usable name when the description slugifies to nothing', () => {
    expect(diagramFileName('???')).toBe('diagram.html')
    expect(diagramFileName('')).toBe('diagram.html')
    // And that fallback collides the same way any other slug does.
    expect(diagramFileName('???', ['diagram.html'])).toBe('diagram-2.html')
  })
})

describe('diagramPrompt', () => {
  it('names the exact output path', () => {
    const prompt = diagramPrompt('Auth flow', 'auth-flow.html')
    expect(prompt).toContain(`${DIAGRAMS_DIR}/auth-flow.html`)
  })

  it('instructs the model not to stop and ask about brand colours or fonts', () => {
    const prompt = diagramPrompt('Auth flow', 'auth-flow.html')
    // The plugin's first-run gate asks for a website to sample brand colours from;
    // left unanswered it hangs the one button in the section, so this line has to
    // survive whatever else changes about the prompt's wording.
    expect(prompt).toMatch(/do not ask about brand colours/i)
  })
})

describe('DiagramRequestsRepo', () => {
  function setup() {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    return { repos, projectId: project.id }
  }

  it('records a request and reads it back keyed by file name', () => {
    const { repos, projectId } = setup()
    repos.diagramRequests.record(projectId, 'auth-flow.html', 'Auth flow for login', 's1')

    const map = repos.diagramRequests.forProject(projectId)
    expect(map.get('auth-flow.html')).toEqual({ sessionId: 's1', description: 'Auth flow for login', plan: null })
  })

  it('updates rather than throwing on a second request for the same file', () => {
    const { repos, projectId } = setup()
    repos.diagramRequests.record(projectId, 'auth-flow.html', 'Auth flow for login', 's1')
    repos.diagramRequests.record(projectId, 'auth-flow.html', 'Auth flow, revised', 's2')

    const map = repos.diagramRequests.forProject(projectId)
    expect(map.size).toBe(1)
    expect(map.get('auth-flow.html')).toEqual({ sessionId: 's2', description: 'Auth flow, revised', plan: null })
  })

  it('never leaks a row from one project into another project\'s map', () => {
    const { repos, projectId } = setup()
    const other = repos.projects.insert({ name: 'b', path: 'C:\\b', source: 'manual' })
    repos.diagramRequests.record(projectId, 'auth-flow.html', 'Auth flow', 's1')
    repos.diagramRequests.record(other.id, 'other.html', 'Something else', 's2')

    expect(repos.diagramRequests.forProject(projectId).has('other.html')).toBe(false)
    expect(repos.diagramRequests.forProject(other.id).has('auth-flow.html')).toBe(false)
  })

  it('round-trips a null sessionId', () => {
    const { repos, projectId } = setup()
    repos.diagramRequests.record(projectId, 'no-session.html', 'Drawn before any session ran', null)

    const map = repos.diagramRequests.forProject(projectId)
    expect(map.get('no-session.html')?.sessionId).toBeNull()
  })
})
