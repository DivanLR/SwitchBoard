import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { runRetention } from './retention.ts'

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

const db = dryRun ? new DatabaseSync(dbPath, { readOnly: true }) : openDatabase(dbPath)
let result: ReturnType<typeof runRetention>
try {
  result = runRetention(db, { dryRun })
} catch (error) {
  console.error(
    `Could not read ${dbPath}: ${(error as Error).message}. A database from an older Switchboard has to be opened by the app once first.`,
  )
  process.exit(1)
}
console.log(
  `${result.dryRun ? '[dry run] Would delete' : 'Deleted'} ${result.eventsDeleted} event rows and ${result.decisionsDeleted} resolved decisions (database: ${dbPath}).`,
)
if (!dryRun && result.eventsDeleted + result.decisionsDeleted >= VACUUM_MIN_DELETIONS) {
  try {
    db.exec('VACUUM')
    console.log('Vacuumed the database.')
  } catch (error) {
    console.error(`VACUUM failed (the app may have the database open): ${(error as Error).message}`)
  }
}
db.close()
