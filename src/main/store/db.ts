// SQLite bootstrap: WAL mode plus ordered, idempotent schema migrations.
// The caller supplies the database path (Electron userData in production,
// a temporary directory in tests) so this module stays Electron-free.
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type AppDatabase = Database.Database

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

        CREATE VIEW decision_history AS
          SELECT * FROM permission_requests WHERE status != 'pending';

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
]

export function openDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
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
    const run = db.transaction(() => {
      migration.up(db)
      record.run(migration.name, new Date().toISOString())
    })
    run()
  }
}
