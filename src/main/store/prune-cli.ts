// Developer retention command (FR-021a): `npm run prune -- --dry-run` reports
// what the retention job would delete; without the flag it prunes for real.
// Runs under plain Node (tsx), so the database path is resolved the same way
// Electron resolves userData on Windows.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openDatabase } from './db'
import { createRepositories } from './repositories'
import { runRetention } from './retention'

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
const repos = createRepositories(db)
const result = runRetention(db, repos, { dryRun })
console.log(
  `${result.dryRun ? '[dry run] Would delete' : 'Deleted'} ${result.eventsDeleted} event rows and ${result.decisionsDeleted} resolved decisions (database: ${dbPath}).`,
)
db.close()
