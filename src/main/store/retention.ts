import { transaction, type AppDatabase } from './db.ts'
import { ARCHIVE_DELETE_DAYS } from '../../shared/domain.ts'

interface RetentionResult {
  eventsDeleted: number
  decisionsDeleted: number
  projectsDeleted: number
  dryRun: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const DECISION_DAYS = 30
const SESSIONS_PER_PROJECT = 12

export type ProjectDeleteBlocker = 'live_session' | 'flow_worktree'

export function projectDeleteBlocker(db: AppDatabase, projectId: string): ProjectDeleteBlocker | null {
  if (db.prepare('SELECT 1 FROM sessions WHERE projectId = ? AND endedAt IS NULL LIMIT 1').get(projectId)) {
    return 'live_session'
  }
  const runs = db
    .prepare('SELECT projectId, repos FROM flow_runs WHERE worktreePath IS NOT NULL')
    .all() as { projectId: string; repos: string }[]
  const owns = runs.some(
    (run) =>
      run.projectId === projectId ||
      (JSON.parse(run.repos) as { projectId: string; worktreePath: string | null }[]).some(
        (repo) => repo.projectId === projectId && repo.worktreePath,
      ),
  )
  return owns ? 'flow_worktree' : null
}

export function deleteProject(db: AppDatabase, projectId: string): void {
  transaction(db, () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('projects', 'sessions')")
      .all() as { name: string }[]
    for (const { name } of tables) {
      const columns = new Set(
        (db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]).map((c) => c.name),
      )
      const where = [
        ...(columns.has('projectId') ? ['projectId = @projectId'] : []),
        ...(columns.has('sessionId')
          ? ['sessionId IN (SELECT id FROM sessions WHERE projectId = @projectId)']
          : []),
      ]
      if (where.length > 0) db.prepare(`DELETE FROM "${name}" WHERE ${where.join(' OR ')}`).run({ projectId })
    }
    const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      | { value: string }
      | undefined
    if (row) {
      const stored = JSON.parse(row.value) as Record<string, unknown>
      for (const value of Object.values(stored)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          delete (value as Record<string, unknown>)[projectId]
        }
      }
      db.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(JSON.stringify(stored))
    }
    db.prepare('DELETE FROM sessions WHERE projectId = ?').run(projectId)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })
}

export function runRetention(
  db: AppDatabase,
  options: { dryRun?: boolean; now?: Date } = {},
): RetentionResult {
  const dryRun = options.dryRun ?? false
  const now = options.now ?? new Date()

  const eventsWhere = `WHERE sessionId NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY startedAt DESC) AS rn
        FROM sessions
      ) WHERE rn <= ?
    )
    AND sessionId NOT IN (SELECT id FROM sessions WHERE endedAt IS NULL)
    AND sessionId NOT IN (SELECT sessionId FROM flow_stages WHERE sessionId IS NOT NULL)`

  const decisionCutoff = new Date(now.getTime() - DECISION_DAYS * DAY_MS).toISOString()
  const archiveCutoff = new Date(now.getTime() - ARCHIVE_DELETE_DAYS * DAY_MS).toISOString()

  const expired = (
    db
      .prepare('SELECT id FROM projects WHERE archivedAt IS NOT NULL AND archivedAt < ?')
      .all(archiveCutoff) as { id: string }[]
  ).filter((project) => !projectDeleteBlocker(db, project.id))

  let eventsDeleted: number
  let decisionsDeleted: number

  if (dryRun) {
    eventsDeleted = (
      db.prepare(`SELECT COUNT(*) AS n FROM events ${eventsWhere}`).get(SESSIONS_PER_PROJECT) as { n: number }
    ).n
    decisionsDeleted = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM permission_requests WHERE status != 'pending' AND resolvedAt < ?",
        )
        .get(decisionCutoff) as { n: number }
    ).n
  } else {
    for (const project of expired) deleteProject(db, project.id)
    eventsDeleted = Number(
      db.prepare(`DELETE FROM events ${eventsWhere}`).run(SESSIONS_PER_PROJECT).changes,
    )
    decisionsDeleted = Number(
      db
        .prepare("DELETE FROM permission_requests WHERE status != 'pending' AND resolvedAt < ?")
        .run(decisionCutoff).changes,
    )
  }

  return { eventsDeleted, decisionsDeleted, projectsDeleted: expired.length, dryRun }
}

const NIGHTLY_HOUR = 3
const INITIAL_DELAY_MS = 5000

export function scheduleRetention(run: () => void): () => void {
  let timer: NodeJS.Timeout
  const scheduleNext = (): void => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), NIGHTLY_HOUR, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    timer = setTimeout(() => {
      run()
      scheduleNext()
    }, next.getTime() - now.getTime())
  }
  timer = setTimeout(() => {
    run()
    scheduleNext()
  }, INITIAL_DELAY_MS)
  return () => clearTimeout(timer)
}
