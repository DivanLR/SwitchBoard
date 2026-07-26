// SQLite bootstrap: WAL mode plus ordered, idempotent schema migrations.
// The caller supplies the database path (Electron userData in production,
// a temporary directory in tests) so this module stays Electron-free.
//
// The store runs on the runtime's own `node:sqlite`, not a native npm module, so
// there is no compiled binary to match to an ABI: the same code runs under
// Electron and under Vitest with no rebuild step, and nothing has to be unpacked
// from the asar archive. One behavioural difference to know about, since the
// schema is the guard rather than the driver: node:sqlite binds a MISSING named
// parameter as NULL where better-sqlite3 threw, so a NOT NULL column raises a
// constraint error and a nullable one quietly stores NULL.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The slice of node:sqlite the store actually uses, with rows typed as `unknown`
 * so each repository can assert its own row shape directly. The driver types rows
 * as `Record<string, SQLOutputValue>`, which does not overlap with a plain
 * interface, so without this every query would need an `as unknown as Row` cast.
 */
export interface AppStatement {
  all(...params: (SQLInputValue | object)[]): unknown[]
  get(...params: (SQLInputValue | object)[]): unknown
  run(...params: (SQLInputValue | object)[]): {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }
}

export interface AppDatabase {
  prepare(sql: string): AppStatement
  exec(sql: string): void
  close(): void
}

interface Migration {
  name: string
  up: (db: AppDatabase) => void
}

const MIGRATIONS: Migration[] = [
  {
    name: '001-initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL CHECK (source IN ('suggested', 'manual')),
          createdAt TEXT NOT NULL,
          archivedAt TEXT
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          sdkSessionId TEXT,
          status TEXT NOT NULL CHECK (status IN ('working', 'needs_you', 'done', 'error')),
          statusDetail TEXT,
          branch TEXT,
          startedAt TEXT NOT NULL,
          endedAt TEXT,
          endReason TEXT CHECK (endReason IN ('completed', 'stopped', 'crashed', 'app_exit'))
        );
        CREATE INDEX idx_sessions_project ON sessions(projectId, startedAt DESC);

        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL REFERENCES sessions(id),
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          noiseKind TEXT,
          createdAt TEXT NOT NULL,
          UNIQUE (sessionId, seq)
        );
        CREATE INDEX idx_events_kind_created ON events(kind, createdAt);

        CREATE TABLE permission_requests (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL REFERENCES sessions(id),
          projectId TEXT NOT NULL REFERENCES projects(id),
          type TEXT NOT NULL CHECK (type IN ('tool_permission', 'plan_approval')),
          toolName TEXT,
          title TEXT NOT NULL,
          explanation TEXT NOT NULL,
          detail TEXT NOT NULL,
          risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'rule_approved')),
          createdAt TEXT NOT NULL,
          resolvedAt TEXT,
          deliveryFailed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_requests_pending ON permission_requests(status, projectId, createdAt);

        CREATE TABLE permission_rules (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          toolName TEXT NOT NULL,
          matcher TEXT NOT NULL,
          createdFromRequestId TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          revokedAt TEXT
        );

        CREATE TABLE risk_rules (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT 'global',
          position INTEGER NOT NULL,
          toolMatcher TEXT NOT NULL,
          inputMatcher TEXT,
          risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
          builtin INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE swallow_rules (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
          projectId TEXT,
          position INTEGER NOT NULL,
          eventKindMatcher TEXT NOT NULL,
          pattern TEXT NOT NULL,
          noiseKind TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          text TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
      `)
    },
  },
  {
    // Working-tree diff line counts shown in the session header (design reference).
    name: '002-session-diff-stats',
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN diffAdds INTEGER;
        ALTER TABLE sessions ADD COLUMN diffDels INTEGER;
      `)
    },
  },
  {
    // Per-project command history for terminal-style composer suggestions.
    name: '003-command-history',
    up: (db) => {
      db.exec(`
        CREATE TABLE command_history (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          text TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX idx_cmdhist_project ON command_history(projectId, createdAt DESC);
      `)
    },
  },
  {
    // Available slash commands / skills per project (from the session init
    // message), suggested in the composer.
    name: '004-project-commands',
    up: (db) => {
      db.exec(`
        CREATE TABLE project_commands (
          projectId TEXT PRIMARY KEY REFERENCES projects(id),
          commands TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
      `)
    },
  },
  {
    // Subscription rate-limit usage per session (session usage meter).
    name: '005-session-usage',
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN usageUtilization REAL;
        ALTER TABLE sessions ADD COLUMN usageResetsAt INTEGER;
        ALTER TABLE sessions ADD COLUMN usageLimitType TEXT;
      `)
    },
  },
  {
    // Planned task queue per project: prompts/commands that auto-run in
    // sequence, each delivered when the session next goes idle.
    name: '006-task-queue',
    up: (db) => {
      db.exec(`
        CREATE TABLE task_queue (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          text TEXT NOT NULL,
          position INTEGER NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX idx_taskqueue_project ON task_queue(projectId, position);
      `)
    },
  },
  {
    // Explicit sidebar ordering (design: drag to reorder / move up-down).
    name: '007-project-order',
    up: (db) => {
      db.exec(`
        ALTER TABLE projects ADD COLUMN position INTEGER;
        UPDATE projects SET position = (
          SELECT COUNT(*) FROM projects p2
          WHERE p2.createdAt < projects.createdAt
             OR (p2.createdAt = projects.createdAt AND p2.id < projects.id)
        );
      `)
    },
  },
  {
    // Referenced folders per project (design: header REFS chips) — JSON array
    // of { path, label }, granted to sessions as additional directories.
    name: '008-project-refs',
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN refs TEXT;`)
    },
  },
  {
    // The seeded 'progress' rule matched a bare percentage on ANY event kind
    // (eventKindMatcher '*'), so a response containing a % — e.g. /usage — was
    // hidden from the clean view. Re-scope the untouched default to raw_output
    // and drop the bare-percentage alternative. Rules a user has edited (any
    // other matcher or pattern) are left untouched. The pattern here must match
    // the seed in swallow-rules.ts so seeded and migrated databases agree.
    name: '009-progress-rule-scope',
    up: (db) => {
      db.prepare(
        `UPDATE swallow_rules
            SET eventKindMatcher = 'raw_output', pattern = ?
          WHERE scope = 'global' AND noiseKind = 'progress' AND eventKindMatcher = '*'`,
      ).run('(\\.{4,}|Downloading|Installing|Fetching|Receiving objects|Progress:)')
    },
  },
  {
    // Retroactive fix for the same bug: a noiseKind is only ever valid on a
    // swallowable kind. Events upgraded to a non-swallowable kind (e.g. a
    // /usage response, assistant_text upgraded to a summary) kept the stale tag
    // and stayed hidden in the clean view. Clear it so those responses show.
    // The insert/update path no longer produces such rows (session-manager).
    name: '010-clear-stale-noisekind',
    up: (db) => {
      db.prepare(
        `UPDATE events SET noiseKind = NULL
          WHERE noiseKind IS NOT NULL
            AND kind NOT IN ('tool_activity', 'raw_output', 'assistant_text')`,
      ).run()
    },
  },
  {
    // Scanned MCP combinations: one row per distinct set of active servers, so
    // the MCP view can answer "have I scanned this combination before?".
    name: '011-mcp-scan-history',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_scans (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          comboKey TEXT NOT NULL,
          servers TEXT NOT NULL,
          scannedAt TEXT NOT NULL,
          UNIQUE (projectId, comboKey)
        );
      `)
    },
  },
  {
    // Bypass sessions run inside a container and keep their SDK transcript in a
    // Docker volume rather than the host's ~/.claude, so "resume" has to know
    // which of the two a previous session used. That outlives the app process,
    // so the flag can no longer be in-memory only.
    name: '012-session-bypass-permissions',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN bypassPermissions INTEGER;`)
    },
  },
  {
    // The eval loop (spec 002, US7): a small change is one observable acceptance
    // line, the check that proves it, and the developer's verdict + 1-5 rating.
    // No spec/plan/task files — this row IS the record. `attempts` counts the
    // parallel worktree-isolated attempts asked for (best-of-N) and `judge` holds
    // the second-opinion review of the diff, both read back from the session.
    name: '013-eval-runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS eval_runs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          acceptance TEXT NOT NULL,
          checkCmd TEXT,
          checkStatus TEXT NOT NULL CHECK (checkStatus IN ('not_run', 'pass', 'fail', 'inconclusive')),
          verdict TEXT NOT NULL CHECK (verdict IN ('pending', 'pass', 'fail')),
          rating INTEGER CHECK (rating BETWEEN 1 AND 5),
          note TEXT,
          attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 5),
          judge TEXT,
          createdAt TEXT NOT NULL
        );
      `)
    },
  },
]

/**
 * Runs `work` inside a transaction, rolling back if it throws. node:sqlite has no
 * transaction wrapper of its own (better-sqlite3 supplied `db.transaction()`).
 *
 * ponytail: no SAVEPOINT nesting — nothing here nests, and a nested call fails
 * loudly ("cannot start a transaction within a transaction") rather than quietly
 * committing early. Add savepoints only when something actually needs to nest.
 */
export function transaction<T>(db: AppDatabase, work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  // WAL keeps reads from blocking on the writer. Foreign keys are already on by
  // default in node:sqlite; stated anyway so the guarantee is not inherited.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );
  `)
  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name),
  )
  const record = db.prepare('INSERT INTO migrations (name, appliedAt) VALUES (?, ?)')
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    transaction(db, () => {
      migration.up(db)
      record.run(migration.name, new Date().toISOString())
    })
  }
}
