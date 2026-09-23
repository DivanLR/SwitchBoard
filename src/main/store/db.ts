import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

interface AppStatement {
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
    name: '002-session-diff-stats',
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN diffAdds INTEGER;
        ALTER TABLE sessions ADD COLUMN diffDels INTEGER;
      `)
    },
  },
  {
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
    name: '008-project-refs',
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN refs TEXT;`)
    },
  },
  {
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
    name: '012-session-bypass-permissions',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN bypassPermissions INTEGER;`)
    },
  },
  {
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
  {
    name: '014-verify-runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS verify_runs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          stackId TEXT NOT NULL,
          sessionId TEXT,
          branch TEXT,
          requested TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'pass', 'fail', 'inconclusive')),
          report TEXT,
          note TEXT,
          startedAt TEXT NOT NULL,
          finishedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_verify_runs_project
          ON verify_runs (projectId, startedAt DESC);
      `)
    },
  },
  {
    name: '015-eval-runs-project-index',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_eval_runs_project
          ON eval_runs (projectId, createdAt DESC);
      `)
    },
  },
  {
    name: '016-api-runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_runs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          baseUrl TEXT NOT NULL,
          launched INTEGER NOT NULL DEFAULT 0,
          sessionId TEXT,
          status TEXT NOT NULL CHECK (status IN ('running', 'pass', 'fail', 'error')),
          note TEXT,
          calls TEXT NOT NULL,
          startedAt TEXT NOT NULL,
          finishedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_api_runs_project
          ON api_runs (projectId, startedAt DESC);
      `)
    },
  },
  {
    name: '017-api-runs-target',
    up: (db) => {
      db.exec(`ALTER TABLE api_runs ADD COLUMN target TEXT NOT NULL DEFAULT 'local';`)
    },
  },
  {
    name: '018-drop-seeded-rule-tables',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS risk_rules;
        DROP TABLE IF EXISTS swallow_rules;
      `)
    },
  },
  {
    name: '019-requests-resolved-index',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_requests_resolved
          ON permission_requests (resolvedAt DESC)
          WHERE resolvedAt IS NOT NULL;
      `)
    },
  },
  {
    name: '020-rule-prefs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rule_prefs (
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('risk', 'swallow')),
          disabled INTEGER NOT NULL DEFAULT 0,
          risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
          body TEXT,
          position INTEGER,
          createdAt TEXT NOT NULL,
          PRIMARY KEY (id, kind)
        );
      `)
    },
  },
  {
    name: '021-session-plan-mode',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN planMode INTEGER;`)
    },
  },
  {
    name: '022-project-session-mode',
    up: (db) => {
      db.exec(
        `ALTER TABLE projects ADD COLUMN defaultSessionMode TEXT NOT NULL DEFAULT 'auto'
           CHECK (defaultSessionMode IN ('default', 'auto', 'acceptEdits', 'plan', 'bypass'));`,
      )
    },
  },
  {
    name: '023-session-mode-dontask',
    up: (db) => {
      db.exec(`
        CREATE TEMP TABLE mode_carry AS SELECT id, defaultSessionMode FROM projects;
        ALTER TABLE projects DROP COLUMN defaultSessionMode;
        ALTER TABLE projects ADD COLUMN defaultSessionMode TEXT NOT NULL DEFAULT 'auto'
          CHECK (defaultSessionMode IN ('default', 'dontAsk', 'auto', 'acceptEdits', 'plan', 'bypass'));
        UPDATE projects
           SET defaultSessionMode = COALESCE(
             (SELECT defaultSessionMode FROM mode_carry WHERE mode_carry.id = projects.id),
             'auto'
           );
        DROP TABLE mode_carry;
      `)
    },
  },
  {
    name: '024-diagram-requests',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS diagram_requests (
          projectId TEXT NOT NULL REFERENCES projects(id),
          file TEXT NOT NULL,
          sessionId TEXT,
          description TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          PRIMARY KEY (projectId, file)
        );
        CREATE INDEX IF NOT EXISTS idx_diagram_requests_project
          ON diagram_requests (projectId, createdAt DESC);
      `)
    },
  },
  {
    name: '025-diagram-plan',
    up: (db) => {
      db.exec(`ALTER TABLE diagram_requests ADD COLUMN plan TEXT;`)
    },
  },
  {
    name: '026-project-containers-and-session-label',
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN useContainers INTEGER NOT NULL DEFAULT 0;`)
      db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT;`)
    },
  },
  {
    name: '027-custom-skills',
    up: (db) => {
      db.exec(`
        CREATE TABLE custom_skills (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          sourceUrl TEXT NOT NULL,
          sourcePath TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          fileCount INTEGER NOT NULL DEFAULT 0,
          importedAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_custom_skills_source ON custom_skills (sourceUrl);
      `)
    },
  },
  {
    name: '028-session-section-kind',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN sectionKind TEXT;`)
    },
  },
  {
    name: '029-session-derived-name',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN derivedName TEXT;`)
    },
  },
  {
    name: '030-session-engine',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';`)
    },
  },
  {
    name: '031-security-runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_runs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          sessionId TEXT,
          scope TEXT NOT NULL CHECK (scope IN ('project', 'changes')),
          branch TEXT,
          status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
          report TEXT,
          note TEXT,
          outputDir TEXT NOT NULL,
          startedAt TEXT NOT NULL,
          finishedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_security_runs_project
          ON security_runs (projectId, startedAt DESC);
      `)
    },
  },
  {
    name: '032-flow-runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS flow_runs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          featureId TEXT NOT NULL,
          featureTitle TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'scoping', 'awaiting_approval', 'publishing', 'publish_interrupted',
            'ready', 'implementing', 'learning', 'done', 'failed', 'cancelled')),
          sessionId TEXT,
          risks TEXT NOT NULL DEFAULT '[]',
          outOfScope TEXT NOT NULL DEFAULT '[]',
          note TEXT,
          startedAt TEXT NOT NULL,
          finishedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_flow_runs_project
          ON flow_runs (projectId, startedAt DESC);

        CREATE TABLE IF NOT EXISTS flow_items (
          id TEXT PRIMARY KEY,
          runId TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
          projectId TEXT NOT NULL REFERENCES projects(id),
          position INTEGER NOT NULL,
          localId TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          acceptance TEXT NOT NULL DEFAULT '[]',
          estimate TEXT NOT NULL DEFAULT 'm' CHECK (estimate IN ('s', 'm', 'l')),
          workItemId TEXT,
          workItemUrl TEXT,
          branch TEXT,
          worktreePath TEXT,
          sessionId TEXT,
          status TEXT NOT NULL CHECK (status IN (
            'proposed', 'published', 'queued', 'preparing', 'implementing',
            'tech_review', 'revising', 'raising_pr', 'pr_interrupted', 'pr_open',
            'done', 'blocked', 'failed', 'cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          prId TEXT,
          prUrl TEXT,
          note TEXT,
          startedAt TEXT,
          finishedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_flow_items_run ON flow_items (runId, position);
        CREATE INDEX IF NOT EXISTS idx_flow_items_session
          ON flow_items (sessionId) WHERE sessionId IS NOT NULL;
      `)
    },
  },
  {
    name: '033-flow-run-work',
    up: (db) => {
      db.exec(`
        ALTER TABLE flow_runs ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 4;
        ALTER TABLE flow_runs ADD COLUMN baseBranch TEXT;
        ALTER TABLE flow_runs ADD COLUMN worktreeRoot TEXT;
      `)
    },
  },
  {
    name: '034-flow-crosscheck-and-lessons',
    up: (db) => {
      db.exec(`
        ALTER TABLE flow_runs ADD COLUMN crosscheckRound INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE flow_runs ADD COLUMN concerns TEXT NOT NULL DEFAULT '[]';

        CREATE TEMP TABLE flow_status_carry AS SELECT id, status FROM flow_runs;
        ALTER TABLE flow_runs DROP COLUMN status;
        ALTER TABLE flow_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'scoping'
          CHECK (status IN (
            'scoping', 'crosscheck', 'awaiting_approval', 'publishing', 'publish_interrupted',
            'ready', 'implementing', 'learning', 'done', 'failed', 'cancelled'));
        UPDATE flow_runs
           SET status = COALESCE(
             (SELECT status FROM flow_status_carry WHERE flow_status_carry.id = flow_runs.id),
             'scoping'
           );
        DROP TABLE flow_status_carry;

        CREATE TABLE IF NOT EXISTS flow_lessons (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          runId TEXT REFERENCES flow_runs(id) ON DELETE SET NULL,
          ruleId TEXT NOT NULL,
          rule TEXT NOT NULL,
          section TEXT,
          evidence TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
          reason TEXT,
          createdAt TEXT NOT NULL,
          decidedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_flow_lessons_project
          ON flow_lessons (projectId, createdAt DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_lessons_rule
          ON flow_lessons (projectId, ruleId);
      `)
    },
  },
  {
    name: '035-flow-spec-session',
    up: (db) => {
      db.exec(`ALTER TABLE flow_runs ADD COLUMN specSessionId TEXT;`)
    },
  },
  {
    name: '036-drop-unused-sections',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS eval_runs;
        DROP TABLE IF EXISTS api_runs;
        DROP TABLE IF EXISTS security_runs;
        DROP TABLE IF EXISTS rule_prefs;
        DROP TABLE IF EXISTS mcp_scans;
      `)
    },
  },
  {
    name: '037-claude-only',
    up: (db) => {
      db.exec(`
        CREATE TEMP TABLE mode_carry AS SELECT id, defaultSessionMode FROM projects;
        ALTER TABLE projects DROP COLUMN defaultSessionMode;
        ALTER TABLE projects ADD COLUMN defaultSessionMode TEXT NOT NULL DEFAULT 'auto'
          CHECK (defaultSessionMode IN ('default', 'dontAsk', 'auto', 'acceptEdits', 'plan'));
        UPDATE projects
           SET defaultSessionMode = COALESCE(
             (SELECT CASE WHEN defaultSessionMode = 'bypass' THEN 'auto' ELSE defaultSessionMode END
                FROM mode_carry WHERE mode_carry.id = projects.id),
             'auto'
           );
        DROP TABLE mode_carry;
      `)
      for (const statement of [
        "UPDATE sessions SET sdkSessionId = NULL WHERE engine = 'codex'",
        'ALTER TABLE sessions DROP COLUMN engine',
        'ALTER TABLE sessions DROP COLUMN bypassPermissions',
        'ALTER TABLE projects DROP COLUMN useContainers',
      ]) {
        try {
          db.exec(statement)
        } catch {}
      }
    },
  },
  {
    name: '039-flow-pipeline',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS flow_items;
        DROP TABLE IF EXISTS flow_lessons;
        DROP TABLE IF EXISTS flow_runs;

        CREATE TABLE flow_runs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('ado', 'text', 'spec')),
          sourceRef TEXT,
          sourceUrl TEXT,
          description TEXT NOT NULL DEFAULT '',
          stacks TEXT NOT NULL DEFAULT '[]',
          stage TEXT NOT NULL CHECK (stage IN (
            'spec', 'plan', 'build', 'clean', 'test', 'review', 'ship')),
          status TEXT NOT NULL CHECK (status IN (
            'running', 'waiting', 'done', 'failed', 'cancelled')),
          autopilot INTEGER NOT NULL DEFAULT 0,
          autoShip INTEGER NOT NULL DEFAULT 0,
          baseBranch TEXT,
          branch TEXT,
          worktreePath TEXT,
          specDir TEXT,
          prUrl TEXT,
          prId TEXT,
          note TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          finishedAt TEXT
        );
        CREATE INDEX idx_flow_runs_project ON flow_runs (projectId, createdAt DESC);

        CREATE TABLE flow_stages (
          runId TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
          stage TEXT NOT NULL CHECK (stage IN (
            'spec', 'plan', 'build', 'clean', 'test', 'review', 'ship')),
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'running', 'review', 'approved', 'skipped', 'failed')),
          sessionId TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          report TEXT,
          feedback TEXT,
          startedAt TEXT,
          finishedAt TEXT,
          PRIMARY KEY (runId, stage)
        );
      `)
    },
  },
  {
    name: '040-drop-custom-skills',
    up: (db) => {
      db.exec(`DROP TABLE IF EXISTS custom_skills;`)
    },
  },
]

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
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
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
