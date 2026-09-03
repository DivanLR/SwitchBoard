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
  {
    // Verification runs (spec 002 US1-US4): one row per verify pass over the
    // working tree. `report` is the JSON the session reported — suites, coverage,
    // quality and evidence in one blob, because nothing queries inside it: the
    // panels render the latest run whole. `sessionId` is what makes every figure
    // traceable back to the output that produced it (FR-046/FR-051).
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
      // eval_runs is read as `WHERE projectId = ? ORDER BY createdAt DESC`
      // (repositories.ts listForProject) but shipped without an index matching
      // it, so every read was a full scan plus a sort. verify_runs got the
      // equivalent index when it was added; this one was simply missed.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_eval_runs_project
          ON eval_runs (projectId, createdAt DESC);
      `)
    },
  },
  {
    // API eval sets: one row per automated endpoint run. `calls` is JSON the app
    // itself produced — the requests it sent and the statuses it received — so
    // unlike verify_runs.report, nothing in it is a model's account of what
    // happened. `baseUrl` and `launched` record where the calls went and whether
    // this run started the server, which is what makes a result reproducible.
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
    // Which environment the calls went to. Needed on the ROW rather than derived
    // from the URL later: the second half of a run re-resolves its host from
    // settings, and a QA URL the developer has since edited would leave the app
    // deciding whether it may start a server against a deployed environment on a
    // string comparison. Existing rows are local, which is what they were.
    name: '017-api-runs-target',
    up: (db) => {
      db.exec(`ALTER TABLE api_runs ADD COLUMN target TEXT NOT NULL DEFAULT 'local';`)
    },
  },
  {
    // Risk and noise rules go back to being code.
    //
    // Both tables shipped as "editable" but never got an IPC method or a screen,
    // so they only ever held the seeded defaults — and because seedIfEmpty() will
    // not re-seed a non-empty table, changing a default meant hand-writing a
    // migration against seeded rows (009-progress-rule-scope did exactly that).
    // risk-rules.ts and swallow-rules.ts are now the only copy, which is what the
    // classifiers read. Dropping the tables cannot lose an edit, because no code
    // path could ever have written one.
    name: '018-drop-seeded-rule-tables',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS risk_rules;
        DROP TABLE IF EXISTS swallow_rules;
      `)
    },
  },
  {
    // Serves retention's two `resolvedAt < ?` statements, which previously
    // scanned the whole table (verified with EXPLAIN QUERY PLAN: both now
    // SEARCH via this index). Partial, because pending rows have a null
    // resolvedAt and are already served by idx_requests_pending.
    //
    // It does NOT help RequestsRepo.history(), which still scans and sorts
    // through a temp B-tree: `status != 'pending'` is an inequality SQLite
    // cannot seek on, and it does not imply this index's IS NOT NULL predicate.
    // Left that way deliberately. history() is capped at 100 rows over a table
    // retention keeps to 30 days of human approvals, so a second index earns
    // nothing but write cost.
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
    // Developer ownership of the risk and noise rules (PRODUCT.md Principle 3),
    // stored as the DIFFERENCE from the shipped defaults rather than as a copy of
    // them. That distinction is the whole design: migration 018 dropped the
    // earlier tables precisely because holding copies made a shipped default
    // unchangeable without a migration per change. See main/inbox/rule-prefs.ts.
    //
    // A row exists only for a rule the developer touched, so an empty table means
    // "shipped behaviour", and `body` is non-null only for a rule they wrote
    // themselves.
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
    // Whether a session was asked to START in plan mode. Only the start value is
    // stored, unlike bypassPermissions which is fixed for the session's life:
    // plan mode can be switched at runtime (the SDK's setPermissionMode), so the
    // current mode lives in memory on the session row and this column exists for
    // one thing — the restart toggle pre-filling from how the last one began.
    name: '021-session-plan-mode',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN planMode INTEGER;`)
    },
  },
  {
    // The mode a project's sessions start in, chosen when the project is added.
    // NOT NULL with a DEFAULT so every existing project gets a value in one
    // statement and no reader needs a fallback for a null. 'auto' is deliberate:
    // it is what every session in this app already spawned as (see
    // resolvePermissionMode), so this migration changes no behaviour for a
    // project that existed before the setting did.
    name: '022-project-session-mode',
    up: (db) => {
      db.exec(
        `ALTER TABLE projects ADD COLUMN defaultSessionMode TEXT NOT NULL DEFAULT 'auto'
           CHECK (defaultSessionMode IN ('default', 'auto', 'acceptEdits', 'plan', 'bypass'));`,
      )
    },
  },
  {
    // 'dontAsk' joins the mode list. The pickers were offering four of the SDK's
    // six permission modes, which is a picker quietly deciding for you; the two
    // missing ones are now offered, and this is the column that has to accept them.
    //
    // 022's CHECK cannot be edited — migrations are append-only, and a developer
    // who already ran it has that constraint on disk. SQLite has no way to alter a
    // CHECK in place either, so the column is dropped and re-added with the wider
    // list, with every project's chosen mode stashed and restored around it. That
    // is a smaller and more legible operation than rebuilding the whole projects
    // table, which by now carries columns from six separate migrations and would
    // have to name every one of them correctly to avoid losing data.
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
    // Diagram requests. NOT the diagrams themselves: those are files in the
    // project's own docs/diagrams folder, committed with the code, and the folder
    // is the list. This table remembers only what a file cannot say about itself —
    // which session produced it, and the sentence that asked for it.
    //
    // Keyed on (projectId, file) rather than an id, because the file name is what
    // the two sides have in common and a second request for the same name is a
    // regeneration of that diagram, not a new row.
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
    // The plan the drawing session states before it draws: the visual type, the
    // semantic pattern, the size preset, and whatever the complexity budget forced
    // out. The diagram-design skill already announces these — its own checklist
    // requires it — and the section threw them away with the rest of the chat.
    //
    // Nullable and JSON, deliberately. Nullable because every diagram drawn before
    // this has no plan and never will, and a diagram is still a diagram without
    // one. JSON because the shape belongs to the skill, not to this app: a new dial
    // in a later version of it should widen the record, not need a migration.
    name: '025-diagram-plan',
    up: (db) => {
      db.exec(`ALTER TABLE diagram_requests ADD COLUMN plan TEXT;`)
    },
  },
  {
    // Two facts the developer now owns directly, one per table.
    //
    // projects.useContainers: whether this project's SECTION work (specs, tests,
    // diff comments, cleanup, diagrams) runs in a Docker container. It used to be
    // hard-coded true in reuseOrStartBackground. DEFAULT 0 — off — because the
    // checkbox exists to be answerable, and "no" is the honest default: containers
    // need Docker Desktop up, cost a cold start, and only two may run at once
    // machine-wide (MAX_CONTAINERS). That cap is the reason this matters now:
    // every section kind takes a session of its own, and five of them cannot all
    // hold a container. Bypass still forces one regardless — it approves every
    // tool call, so the container is the only boundary left.
    //
    // sessions.label: the developer's own name for a session. Separate from the
    // derived Session.name (sessionName in domain.ts), which states what the app
    // started the session FOR; a typed name overrides it and nothing derives one.
    name: '026-project-containers-and-session-label',
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN useContainers INTEGER NOT NULL DEFAULT 0;`)
      db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT;`)
    },
  },
  {
    /*
     * Skills the developer imported from a Git host, and whether each is switched
     * on.
     *
     * The ROW is the registry; the FILES are the skill. Both exist because they
     * answer different questions: the files under the staging directory are what
     * a skill IS, and this table is what the app knows about it (where it came
     * from, what it calls itself, whether it is switched on). Keeping the files
     * out of the database is deliberate — a skill is a directory of markdown and
     * scripts, sometimes megabytes of it, and a BLOB column would make every
     * listing read the payload it does not need.
     *
     * `name` is the primary key rather than a generated id, because the name IS
     * the identity everywhere else: it is the directory under ~/.claude/skills,
     * it is what the CLI calls the skill, and it is what `/name` dispatches. Two
     * skills of the same name from two repositories are the same slash command
     * and cannot both be installed, so the database should refuse the second
     * rather than let a silent overwrite decide.
     */
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
    /*
     * What section a session was opened for, kept on the ROW so it survives the
     * session ending.
     *
     * It already existed, but only in memory: SessionManager held `sectionKind`
     * on its hosted entry and `sectionKinds()` read it back by walking the live
     * map. That answered correctly right up until the session closed, and then
     * the fact evaporated — so `sessionName` fell through to the branch, and a
     * finished drawing that had been listed as "Diagram" in the sidebar became
     * indistinguishable from the conversation running beside it on the same
     * checkout. A section session closes itself the moment its work is done
     * (endIfIdleBackground), so the window in which the old answer was right was
     * the one window nobody was looking at it in.
     *
     * Nullable with no default: an ordinary conversation belongs to no section,
     * and every row written before this migration is honestly unknown rather
     * than retroactively assigned one.
     */
    name: '028-session-section-kind',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN sectionKind TEXT;`)
    },
  },
  {
    /*
     * The derived name, frozen the first time it resolved.
     *
     * "My sessions keep renaming themselves." They did, and it was not a bug in
     * any one place: Session.name was re-derived on every project list from
     * facts that keep moving. The branch is re-read after every turn, so a
     * checkout renamed every session on it; a finished session traded its branch
     * for "- Complete"; and a conversation that started a verification run or
     * drew a diagram was renamed after the fact, because the run row and the
     * diagram record point back at its id. Each of those was right on its own
     * and together they meant a developer could not learn a session by its name.
     *
     * So the name is derived once and then kept. Not written at session start,
     * because the facts it needs do not all exist yet — the branch is read
     * asynchronously just after start, and a drawing's description arrives when
     * the session reports it — which is why this is filled by the list that
     * first sees a complete answer rather than by the insert.
     *
     * Distinct from `label` (026), which is the developer's own name and still
     * outranks this, and from the branch fallback the sidebar uses for a session
     * that has no name at all: a branch is a live fact, not a name, and it goes
     * on tracking the checkout.
     */
    name: '029-session-derived-name',
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN derivedName TEXT;`)
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
  // NORMAL is SQLite's own recommended pairing with WAL: the writer stops
  // fsyncing on every commit, which matters here because event inserts land on
  // the main thread at streaming rates. The trade is precise: with WAL, NORMAL
  // still cannot corrupt the database, it only risks losing the most recent
  // commits if the OS itself dies. Session events are a transcript, not money.
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
