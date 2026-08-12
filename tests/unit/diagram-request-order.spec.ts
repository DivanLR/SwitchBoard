// DiagramRequestsRepo.latestSessionFor, used by SessionManager.backgroundSessionFor
// to decide whether a diagram, verify or API run can join an already-running
// background session. diagrams.spec.ts covers record() and forProject(); this file
// is the "most recent request wins" ordering that backgroundSessionFor actually
// depends on.
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
    // record() stamps createdAt with the real clock, and two calls in the same
    // test can land in the same millisecond, which would make the "most recent
    // wins" assertion flaky. Pinning createdAt directly, the same way
    // verify-runs.spec.ts backdates startedAt, makes the ordering explicit and
    // the test deterministic regardless of how fast the machine running it is.
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
    // Recorded in the order a, b, c, but c is backdated so it is not the newest
    // and a is backdated so it is not the oldest either. If the query were
    // reading insertion/rowid order instead of createdAt, this would return c
    // (last inserted) or a (first inserted) instead of b.
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
    // Give the other project's row the later timestamp: if latestSessionFor ever
    // dropped its projectId filter, this is the row it would wrongly surface.
    setCreatedAt(projectId, 'auth-flow.html', '2024-01-01T00:00:00.000Z')
    setCreatedAt(other.id, 'other.html', '2024-01-02T00:00:00.000Z')

    expect(repos.diagramRequests.latestSessionFor(projectId)).toBe('s-mine')
  })

  it('returns null, not a stray sessionId, when the newest request has none', () => {
    const { repos, projectId, setCreatedAt } = setup()
    // A diagram request is recorded before the session is asked (see record()'s
    // own comment), so a null sessionId is the ordinary state right after the
    // request row is written and before the session exists. The repo does not
    // distinguish this from "no request at all" ('row?.sessionId ?? null'
    // collapses both to null) and backgroundSessionFor treats both the same
    // way, via its `if (!id) continue`, so this is documenting the code's
    // actual behaviour rather than asserting a should-be distinction.
    repos.diagramRequests.record(projectId, 'older.html', 'Older, with a session', 's-old')
    repos.diagramRequests.record(projectId, 'newest.html', 'Newest, no session yet', null)
    setCreatedAt(projectId, 'older.html', '2024-01-01T00:00:00.000Z')
    setCreatedAt(projectId, 'newest.html', '2024-01-02T00:00:00.000Z')

    expect(repos.diagramRequests.latestSessionFor(projectId)).toBeNull()
  })
})
