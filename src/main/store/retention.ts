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

// Fixed in v1 (FR-021a); promote to Settings only when a UI actually sets them.
const DECISION_DAYS = 30
const SESSIONS_PER_PROJECT = 2
// VACUUM is a heavy, single-threaded rewrite; only run it when a meaningful
// number of rows were actually pruned, not on every trivial deletion.
const VACUUM_MIN_DELETIONS = 500

export function runRetention(
  db: AppDatabase,
  repos: Repositories,
  options: RetentionOptions = {},
): RetentionResult {
  const dryRun = options.dryRun ?? false
  const now = options.now ?? new Date()

  const keepIds = repos.sessions.retainedSessionIds(SESSIONS_PER_PROJECT)
  const placeholders = keepIds.map(() => '?').join(', ')
  const eventsWhere =
    keepIds.length > 0 ? `WHERE sessionId NOT IN (${placeholders})` : ''

  const decisionCutoff = new Date(
    now.getTime() - DECISION_DAYS * 24 * 60 * 60 * 1000,
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
    if (eventsDeleted + decisionsDeleted >= VACUUM_MIN_DELETIONS) {
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
// Delay the first pass so it never runs on the synchronous startup path (a
// large VACUUM must not gate window creation); the window paints first.
const INITIAL_DELAY_MS = 5000

/** Deferred first run plus a nightly schedule (03:00 local). Returns a cancel function. */
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
  // First pass is deferred off the startup critical path, then nightly.
  timer = setTimeout(() => {
    run()
    scheduleNext()
  }, INITIAL_DELAY_MS)
  return () => clearTimeout(timer)
}
