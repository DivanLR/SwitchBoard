// Project commands repository: available slash commands / skills per project.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  return { repos, projectId: project.id }
}

describe('ProjectCommandsRepo', () => {
  it('returns an empty list when nothing is stored', () => {
    const { repos, projectId } = setup()
    expect(repos.projectCommands.get(projectId)).toEqual([])
  })

  it('stores and returns the command list', () => {
    const { repos, projectId } = setup()
    repos.projectCommands.set(projectId, ['ponytail', 'ponytail-review', 'speckit-plan'])
    expect(repos.projectCommands.get(projectId)).toEqual(['ponytail', 'ponytail-review', 'speckit-plan'])
  })

  it('upserts (replaces) on the same project', () => {
    const { repos, projectId } = setup()
    repos.projectCommands.set(projectId, ['old'])
    repos.projectCommands.set(projectId, ['new-a', 'new-b'])
    expect(repos.projectCommands.get(projectId)).toEqual(['new-a', 'new-b'])
  })
})
