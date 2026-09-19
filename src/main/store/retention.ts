import type { AppDatabase } from './db'

interface RetentionResult {
  eventsDeleted: number
  decisionsDeleted: number
  dryRun: boolean
}

const DECISION_DAYS = 30
// A flow run puts a session on the project per work item, plus its own, so keeping
// only the last two would delete a run's history while it was still going.
const SESSIONS_PER_PROJECT = 12

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
    AND sessionId NOT IN (SELECT id FROM sessions WHERE endedAt IS NULL)`

  const decisionCutoff = new Date(
    now.getTime() - DECISION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

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
    eventsDeleted = Number(
      db.prepare(`DELETE FROM events ${eventsWhere}`).run(SESSIONS_PER_PROJECT).changes,
    )
    decisionsDeleted = Number(
      db
        .prepare("DELETE FROM permission_requests WHERE status != 'pending' AND resolvedAt < ?")
        .run(decisionCutoff).changes,
    )
  }

  return { eventsDeleted, decisionsDeleted, dryRun }
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
