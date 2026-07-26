// Eval loop (spec 002 US7): the acceptance line, its check outcome, and the
// developer's verdict + 1-5 rating are the whole record for a small change.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  const other = repos.projects.insert({ name: 'b', path: 'C:\\b', source: 'manual' })
  return { repos, projectId: project.id, otherId: other.id }
}

describe('EvalsRepo', () => {
  it('records a line as not run and unrated — never as passing', () => {
    const { repos, projectId } = setup()
    const run = repos.evals.add(projectId, '  end-session shows a bar  ', 'npx vitest run x')
    expect(run).toMatchObject({
      acceptance: 'end-session shows a bar',
      checkCmd: 'npx vitest run x',
      checkStatus: 'not_run',
      verdict: 'pending',
      rating: null,
      note: null,
    })
  })

  it('keeps a line with no check (styling-only: the manual pass is the check)', () => {
    const { repos, projectId } = setup()
    expect(repos.evals.add(projectId, 'the pill is green', '   ').checkCmd).toBeNull()
    expect(repos.evals.add(projectId, 'the pill is amber').checkCmd).toBeNull()
  })

  it('lists newest first and scopes to one project', () => {
    const { repos, projectId, otherId } = setup()
    repos.evals.add(projectId, 'first')
    repos.evals.add(projectId, 'second')
    repos.evals.add(otherId, 'elsewhere')
    expect(repos.evals.listForProject(projectId).map((r) => r.acceptance)).toEqual([
      'second',
      'first',
    ])
    expect(repos.evals.listForProject(otherId).map((r) => r.acceptance)).toEqual(['elsewhere'])
  })

  it('patches only the keys given, so a rating survives a later verdict change', () => {
    const { repos, projectId } = setup()
    const run = repos.evals.add(projectId, 'a line', 'npx vitest run x')
    repos.evals.update(run.id, { rating: 4, note: 'close' })
    const afterVerdict = repos.evals.update(run.id, { verdict: 'pass' })
    expect(afterVerdict).toMatchObject({ verdict: 'pass', rating: 4, note: 'close' })
    // The check outcome is independent of the human verdict.
    expect(afterVerdict?.checkStatus).toBe('not_run')
    expect(repos.evals.update(run.id, { checkStatus: 'fail' })?.verdict).toBe('pass')
  })

  it('clears a rating when it is set back to null', () => {
    const { repos, projectId } = setup()
    const run = repos.evals.add(projectId, 'a line')
    repos.evals.update(run.id, { rating: 5 })
    expect(repos.evals.update(run.id, { rating: null })?.rating).toBeNull()
  })

  it('refuses a rating outside 1-5 at the schema level', () => {
    const { repos, projectId } = setup()
    const run = repos.evals.add(projectId, 'a line')
    expect(() => repos.evals.update(run.id, { rating: 6 })).toThrow()
    expect(() => repos.evals.update(run.id, { rating: 0 })).toThrow()
    expect(repos.evals.update(run.id, {})?.rating).toBeNull()
  })

  it('returns null for a line that no longer exists', () => {
    const { repos, projectId } = setup()
    const run = repos.evals.add(projectId, 'a line')
    repos.evals.remove(run.id)
    expect(repos.evals.update(run.id, { verdict: 'pass' })).toBeNull()
    expect(repos.evals.listForProject(projectId)).toEqual([])
  })
})
