// Retention job (FR-021a): keeps events for the current and immediately
// previous session per project, prunes resolved decisions older than 30 days,
// and vacuums opportunistically. Runs at startup and nightly.
import type { AppDatabase } from './db'
import type { Repositories } from './repositories'

export interface RetentionResult {
  eventsDeleted: number
  decisionsDeleted: number
  dryRun: boolean
}

export interface RetentionOptions {
  dryRun?: boolean
  now?: Date
}

export function runRetention(
  db: AppDatabase,
  repos: Repositories,
  options: RetentionOptions = {},
): RetentionResult {
  const dryRun = options.dryRun ?? false
  const now = options.now ?? new Date()
  const settings = repos.settings.get()

  const keepIds = repos.sessions.retainedSessionIds(settings.retentionSessionsPerProject)
  const placeholders = keepIds.map(() => '?').join(', ')
  const eventsWhere =
    keepIds.length > 0 ? `WHERE sessionId NOT IN (${placeholders})` : ''

  const decisionCutoff = new Date(
    now.getTime() - settings.retentionDecisionDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  let eventsDeleted: number
  let decisionsDeleted: number

  if (dryRun) {
    eventsDeleted = (
      db.prepare(`SELECT COUNT(*) AS n FROM events ${eventsWhere}`).get(...keepIds) as { n: number }
    ).n
    decisionsDeleted = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM permission_requests WHERE status != 'pending' AND resolvedAt < ?",
        )
        .get(decisionCutoff) as { n: number }
    ).n
  } else {
    eventsDeleted = db.prepare(`DELETE FROM events ${eventsWhere}`).run(...keepIds).changes
    decisionsDeleted = db
      .prepare("DELETE FROM permission_requests WHERE status != 'pending' AND resolvedAt < ?")
      .run(decisionCutoff).changes
    if (eventsDeleted + decisionsDeleted > 0) {
      try {
        db.exec('VACUUM')
      } catch {
        // Opportunistic only; a busy database skips the vacuum.
      }
    }
  }

  return { eventsDeleted, decisionsDeleted, dryRun }
}

const NIGHTLY_HOUR = 3

/** Startup run plus a nightly schedule (03:00 local). Returns a cancel function. */
export function scheduleRetention(run: () => void): () => void {
  run()
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
  scheduleNext()
  return () => clearTimeout(timer)
}
