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

  it('stores and returns the command list with descriptions', () => {
    const { repos, projectId } = setup()
    repos.projectCommands.set(projectId, [
      { name: 'ponytail', description: 'Laziest working solution' },
      { name: 'speckit-plan' },
    ])
    expect(repos.projectCommands.get(projectId)).toEqual([
      { name: 'ponytail', description: 'Laziest working solution' },
      { name: 'speckit-plan' },
    ])
  })

  it('upserts (replaces) on the same project', () => {
    const { repos, projectId } = setup()
    repos.projectCommands.set(projectId, [{ name: 'old' }])
    repos.projectCommands.set(projectId, [{ name: 'new-a' }, { name: 'new-b' }])
    expect(repos.projectCommands.get(projectId)).toEqual([{ name: 'new-a' }, { name: 'new-b' }])
  })

  it('maps legacy rows that stored plain name strings', () => {
    const { repos, projectId } = setup()
    repos.projectCommands.set(projectId, [{ name: 'seed' }])
    // Overwrite the stored JSON with the pre-description format.
    const db = (repos.projectCommands as unknown as { db: import('@main/store/db').AppDatabase }).db
    db.prepare('UPDATE project_commands SET commands = ? WHERE projectId = ?').run(
      JSON.stringify(['ponytail', 'speckit-plan']),
      projectId,
    )
    expect(repos.projectCommands.get(projectId)).toEqual([
      { name: 'ponytail' },
      { name: 'speckit-plan' },
    ])
  })
})
