import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  return {
    repos,
    projectId: project.id,
    setCreatedAt: (projectId: string, file: string, iso: string): void => {
      db.prepare('UPDATE diagram_requests SET createdAt = ? WHERE projectId = ? AND file = ?').run(
        iso,
        projectId,
        file,
      )
    },
  }
}

describe('DiagramRequestsRepo.latestSessionFor', () => {
  it('returns the session of the request with the latest createdAt, not the one recorded last', () => {
    const { repos, projectId, setCreatedAt } = setup()
    repos.diagramRequests.record(projectId, 'a.html', 'A', 's-a')
    repos.diagramRequests.record(projectId, 'b.html', 'B', 's-b')
    repos.diagramRequests.record(projectId, 'c.html', 'C', 's-c')
    setCreatedAt(projectId, 'a.html', '2024-01-01T00:00:00.000Z')
    setCreatedAt(projectId, 'c.html', '2024-01-02T00:00:00.000Z')
    setCreatedAt(projectId, 'b.html', '2024-01-03T00:00:00.000Z')

    expect(repos.diagramRequests.latestSessionFor(projectId)).toBe('s-b')
  })

  it('returns null for a project that has never asked for a diagram', () => {
    const { repos, projectId } = setup()

    expect(repos.diagramRequests.latestSessionFor(projectId)).toBeNull()
  })

  it("never answers with another project's request, even one recorded more recently", () => {
    const { repos, projectId, setCreatedAt } = setup()
    const other = repos.projects.insert({ name: 'b', path: 'C:\\b', source: 'manual' })
    repos.diagramRequests.record(projectId, 'auth-flow.html', 'Auth flow', 's-mine')
    repos.diagramRequests.record(other.id, 'other.html', 'Something else', 's-other')
    setCreatedAt(projectId, 'auth-flow.html', '2024-01-01T00:00:00.000Z')
    setCreatedAt(other.id, 'other.html', '2024-01-02T00:00:00.000Z')

    expect(repos.diagramRequests.latestSessionFor(projectId)).toBe('s-mine')
  })

  it('returns null, not a stray sessionId, when the newest request has none', () => {
    const { repos, projectId, setCreatedAt } = setup()
    repos.diagramRequests.record(projectId, 'older.html', 'Older, with a session', 's-old')
    repos.diagramRequests.record(projectId, 'newest.html', 'Newest, no session yet', null)
    setCreatedAt(projectId, 'older.html', '2024-01-01T00:00:00.000Z')
    setCreatedAt(projectId, 'newest.html', '2024-01-02T00:00:00.000Z')

    expect(repos.diagramRequests.latestSessionFor(projectId)).toBeNull()
  })
})
