// Command history repository: powers terminal-style composer suggestions.
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

describe('CommandHistoryRepo', () => {
  it('returns commands most-recent-first, distinct', () => {
    const { repos, projectId } = setup()
    repos.commandHistory.add(projectId, 'git status')
    repos.commandHistory.add(projectId, 'npm test')
    repos.commandHistory.add(projectId, 'git status') // repeat moves it to the front
    const recent = repos.commandHistory.recent(projectId)
    expect(recent).toEqual(['git status', 'npm test'])
  })

  it('trims and ignores empty commands', () => {
    const { repos, projectId } = setup()
    repos.commandHistory.add(projectId, '   ')
    repos.commandHistory.add(projectId, '  run build  ')
    expect(repos.commandHistory.recent(projectId)).toEqual(['run build'])
  })

  it('scopes history to the project', () => {
    const { repos, projectId, otherId } = setup()
    repos.commandHistory.add(projectId, 'in-a')
    repos.commandHistory.add(otherId, 'in-b')
    expect(repos.commandHistory.recent(projectId)).toEqual(['in-a'])
    expect(repos.commandHistory.recent(otherId)).toEqual(['in-b'])
  })

  it('respects the limit', () => {
    const { repos, projectId } = setup()
    for (let i = 0; i < 10; i += 1) repos.commandHistory.add(projectId, `cmd ${i}`)
    expect(repos.commandHistory.recent(projectId, 3)).toEqual(['cmd 9', 'cmd 8', 'cmd 7'])
  })
})
