// Retention job (FR-021a): keeps events for the current and immediately
// previous session per project, prunes resolved decisions older than 30 days.
// Runs at startup and nightly. Does NOT vacuum — see the ponytail note below
// runRetention; that now lives in prune-cli.ts, the offline entry point.
import type { AppDatabase } from './db'

interface RetentionResult {
  eventsDeleted: number
  decisionsDeleted: number
  dryRun: boolean
}

// Fixed in v1 (FR-021a); promote to Settings only when a UI actually sets them.
const DECISION_DAYS = 30
const SESSIONS_PER_PROJECT = 2

export function runRetention(
  db: AppDatabase,
  options: { dryRun?: boolean; now?: Date } = {},
): RetentionResult {
  const dryRun = options.dryRun ?? false
  const now = options.now ?? new Date()

  // Keep events for the most recent SESSIONS_PER_PROJECT sessions per project;
  // the window subquery is the keep-set, so nothing round-trips through JS.
  //
  // Rank alone used to be the whole rule, and rank is ordered by startedAt with
  // no regard for whether a session has actually ENDED. With three or more
  // sessions running concurrently in one project, the one that happened to
  // start EARLIEST among them drops out of the top SESSIONS_PER_PROJECT the
  // moment a later one starts — even though it is still live, mid-conversation,
  // and its transcript is still growing. The second clause is a second,
  // independent keep-set: any session with no endedAt yet is never pruned
  // regardless of rank, so a live session's history cannot be deleted out from
  // under it. Shared by the dry-run count and the real delete below, so the
  // two can never report different sets.
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
    // ponytail: a VACUUM used to run right here once enough rows were pruned.
    // It is a single-threaded full-database rewrite, and even gated behind the
    // 5s startup delay below (INITIAL_DELAY_MS) it still fires again every
    // night at NIGHTLY_HOUR and freezes the window for however long the
    // rewrite takes — the exact cost that delay was trying to avoid, just
    // deferred a few seconds rather than removed. SQLite reuses freed pages on
    // its own once rows are deleted, so dropping VACUUM from this path costs
    // only that the file stops SHRINKING automatically; it does not grow
    // unboundedly, since the next inserts reuse the space these deletes just
    // freed. Run `npm run prune` (prune-cli.ts) when disk actually matters —
    // that is the offline entry point, with no window to freeze and no
    // developer waiting on the result.
  }

  return { eventsDeleted, decisionsDeleted, dryRun }
}

const NIGHTLY_HOUR = 3
// Delay the first pass so it never runs on the synchronous startup path; the
// window paints first. Originally sized to keep a VACUUM off that path — the
// job no longer vacuums (see the ponytail note in runRetention) — but the
// prune queries themselves are still real DELETEs against however large the
// events table has grown, so the delay stays.
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
  timer = setTimeout(() => {
    run()
    scheduleNext()
  }, INITIAL_DELAY_MS)
  return () => clearTimeout(timer)
}
