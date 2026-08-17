// Developer retention command (FR-021a): `npm run prune -- --dry-run` reports
// what the retention job would delete; without the flag it prunes for real.
// Runs under plain Node (tsx), so the database path is resolved the same way
// Electron resolves userData on Windows.
//
// Also the ONLY place VACUUM runs (moved out of retention.ts's nightly job —
// see the ponytail note in runRetention). A VACUUM is a single-threaded
// full-database rewrite; here there is no BrowserWindow to freeze and no
// developer waiting on a background timer, only one who ran this command and
// is watching the terminal for it to finish.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openDatabase } from './db'
import { runRetention } from './retention'

// Same threshold the nightly job used to gate its VACUUM on: not worth a full
// rewrite for a handful of freed rows, even when the developer asked for one.
const VACUUM_MIN_DELETIONS = 500

const dryRun = process.argv.includes('--dry-run')
const pathArgIndex = process.argv.indexOf('--db')
const dbPath =
  pathArgIndex !== -1
    ? process.argv[pathArgIndex + 1]
    : join(
        process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming'),
        'terminal-switchboard',
        'switchboard.db',
      )

if (!existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}. Pass --db <path> to point at one.`)
  process.exit(1)
}

const db = openDatabase(dbPath)
const result = runRetention(db, { dryRun })
console.log(
  `${result.dryRun ? '[dry run] Would delete' : 'Deleted'} ${result.eventsDeleted} event rows and ${result.decisionsDeleted} resolved decisions (database: ${dbPath}).`,
)
// Dry run must not touch the file at all — VACUUM included — so it is gated
// on the same flag as the deletes above, not just on the row count.
if (!dryRun && result.eventsDeleted + result.decisionsDeleted >= VACUUM_MIN_DELETIONS) {
  try {
    db.exec('VACUUM')
    console.log('Vacuumed the database.')
  } catch (error) {
    // Not swallowed silently, unlike the old nightly path: a developer who ran
    // this command is watching for the result, so a busy database (e.g. the
    // app itself still has it open) is worth telling them about.
    console.error(`VACUUM failed (the app may have the database open): ${(error as Error).message}`)
  }
}
db.close()
