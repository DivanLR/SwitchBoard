// Planned task queue repository: prompts/goals that auto-run in sequence (FR-023).
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

describe('TaskQueueRepo', () => {
  it('lists tasks in insertion order', () => {
    const { repos, projectId } = setup()
    repos.taskQueue.add(projectId, 'first goal')
    repos.taskQueue.add(projectId, 'second goal')
    expect(repos.taskQueue.listForProject(projectId).map((t) => t.text)).toEqual([
      'first goal',
      'second goal',
    ])
  })

  it('takeNext removes and returns the front of the queue (FIFO)', () => {
    const { repos, projectId } = setup()
    repos.taskQueue.add(projectId, 'one')
    repos.taskQueue.add(projectId, 'two')
    expect(repos.taskQueue.takeNext(projectId)?.text).toBe('one')
    expect(repos.taskQueue.listForProject(projectId).map((t) => t.text)).toEqual(['two'])
    expect(repos.taskQueue.takeNext(projectId)?.text).toBe('two')
    expect(repos.taskQueue.takeNext(projectId)).toBeNull()
  })

  it('preserves order after an intermediate removal', () => {
    const { repos, projectId } = setup()
    repos.taskQueue.add(projectId, 'a')
    const b = repos.taskQueue.add(projectId, 'b')
    repos.taskQueue.add(projectId, 'c')
    repos.taskQueue.remove(b.id)
    expect(repos.taskQueue.listForProject(projectId).map((t) => t.text)).toEqual(['a', 'c'])
    expect(repos.taskQueue.takeNext(projectId)?.text).toBe('a')
    expect(repos.taskQueue.takeNext(projectId)?.text).toBe('c')
  })

  it('trims text and scopes the queue per project', () => {
    const { repos, projectId, otherId } = setup()
    repos.taskQueue.add(projectId, '  padded  ')
    repos.taskQueue.add(otherId, 'other project')
    expect(repos.taskQueue.listForProject(projectId).map((t) => t.text)).toEqual(['padded'])
    expect(repos.taskQueue.takeNext(otherId)?.text).toBe('other project')
    expect(repos.taskQueue.listForProject(projectId)).toHaveLength(1)
  })
})
