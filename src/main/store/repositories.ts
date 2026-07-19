// Typed repositories over the SQLite schema (data-model.md). All JSON columns
// are serialised here so the rest of the main process works with domain types.
import { randomUUID } from 'node:crypto'
import type { AppDatabase } from './db'
import type {
  DecisionOutcome,
  DecisionRecord,
  Draft,
  EventKind,
  EventPayloadMap,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  PermissionRuleMatcher,
  Project,
  ProjectSource,
  RiskClassificationRule,
  QueuedTask,
  Session,
  SessionEndReason,
  SessionEvent,
  SessionStatus,
  Settings,
  SwallowRule,
} from '@shared/domain'
import { DEFAULT_SETTINGS } from '@shared/domain'

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

// --- Row mapping helpers ---

interface ProjectRow {
  id: string
  name: string
  path: string
  source: ProjectSource
  createdAt: string
  archivedAt: string | null
}

interface SessionRow {
  id: string
  projectId: string
  sdkSessionId: string | null
  status: SessionStatus
  statusDetail: string | null
  branch: string | null
  diffAdds: number | null
  diffDels: number | null
  usageUtilization: number | null
  usageResetsAt: number | null
  usageLimitType: string | null
  startedAt: string
  endedAt: string | null
  endReason: SessionEndReason | null
}

interface EventRow {
  id: string
  sessionId: string
  seq: number
  kind: EventKind
  payload: string
  noiseKind: string | null
  createdAt: string
}

interface RequestRow {
  id: string
  sessionId: string
  projectId: string
  type: PermissionRequest['type']
  toolName: string | null
  title: string
  explanation: string
  detail: string
  risk: PermissionRequest['risk']
  status: PermissionRequestStatus
  createdAt: string
  resolvedAt: string | null
  deliveryFailed: number
}

function toEvent(row: EventRow): SessionEvent {
  return { ...row, payload: JSON.parse(row.payload) }
}

function toRequest(row: RequestRow): PermissionRequest {
  return { ...row, deliveryFailed: row.deliveryFailed === 1 }
}

// --- Repositories ---

export class ProjectsRepo {
  constructor(private db: AppDatabase) {}

  insert(input: { name: string; path: string; source: ProjectSource }): Project {
    const project: Project = {
      id: newId(),
      name: input.name,
      path: input.path,
      source: input.source,
      createdAt: nowIso(),
      archivedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, source, createdAt, archivedAt)
         VALUES (@id, @name, @path, @source, @createdAt, @archivedAt)`,
      )
      .run(project)
    return project
  }

  byId(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  }

  byPath(path: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined
  }

  listActive(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects WHERE archivedAt IS NULL ORDER BY createdAt')
      .all() as ProjectRow[]
  }

  archive(id: string): void {
    this.db.prepare('UPDATE projects SET archivedAt = ? WHERE id = ?').run(nowIso(), id)
  }

  /** Restore a previously removed project (re-adding the same folder). */
  unarchive(id: string): void {
    this.db.prepare('UPDATE projects SET archivedAt = NULL WHERE id = ?').run(id)
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  }
}

export class SessionsRepo {
  constructor(private db: AppDatabase) {}

  insert(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, projectId, sdkSessionId, status, statusDetail, branch, diffAdds, diffDels, usageUtilization, usageResetsAt, usageLimitType, startedAt, endedAt, endReason)
         VALUES (@id, @projectId, @sdkSessionId, @status, @statusDetail, @branch, @diffAdds, @diffDels, @usageUtilization, @usageResetsAt, @usageLimitType, @startedAt, @endedAt, @endReason)`,
      )
      .run(session)
  }

  byId(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Session,
        | 'sdkSessionId'
        | 'status'
        | 'statusDetail'
        | 'branch'
        | 'diffAdds'
        | 'diffDels'
        | 'usageUtilization'
        | 'usageResetsAt'
        | 'usageLimitType'
        | 'endedAt'
        | 'endReason'
      >
    >,
  ): void {
    const fields = Object.keys(patch)
    if (fields.length === 0) return
    const assignments = fields.map((f) => `${f} = @${f}`).join(', ')
    this.db.prepare(`UPDATE sessions SET ${assignments} WHERE id = @id`).run({ id, ...patch })
  }

  activeForProject(projectId: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE projectId = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1')
      .get(projectId) as SessionRow | undefined
  }

  latestForProject(projectId: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE projectId = ? ORDER BY startedAt DESC LIMIT 1')
      .get(projectId) as SessionRow | undefined
  }

  latestEndedForProject(projectId: string): Session | undefined {
    return this.db
      .prepare(
        'SELECT * FROM sessions WHERE projectId = ? AND endedAt IS NOT NULL ORDER BY startedAt DESC LIMIT 1',
      )
      .get(projectId) as SessionRow | undefined
  }

  listUnended(): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE endedAt IS NULL').all() as SessionRow[]
  }

  /** Startup reconciliation: any session left open by a previous run is marked ended (FR-022). */
  reconcileAllEnded(reason: SessionEndReason): number {
    const result = this.db
      .prepare(
        `UPDATE sessions SET endedAt = ?, endReason = ?, status = CASE WHEN status = 'error' THEN 'error' ELSE 'done' END
         WHERE endedAt IS NULL`,
      )
      .run(nowIso(), reason)
    return result.changes
  }

  /** Session ids to keep events for: the current and previous session per project (FR-021a). */
  retainedSessionIds(perProject: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY startedAt DESC) AS rn
           FROM sessions
         ) WHERE rn <= ?`,
      )
      .all(perProject) as { id: string }[]
    return rows.map((r) => r.id)
  }
}

export class EventsRepo {
  constructor(private db: AppDatabase) {}

  insert(event: SessionEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, sessionId, seq, kind, payload, noiseKind, createdAt)
         VALUES (@id, @sessionId, @seq, @kind, @payload, @noiseKind, @createdAt)`,
      )
      .run({ ...event, payload: JSON.stringify(event.payload) })
  }

  /**
   * Contract-sanctioned in-place update (contracts/session-events.md): marker
   * and question status changes, tool result pairing, and final partial text.
   */
  updatePayload<K extends EventKind>(id: string, payload: EventPayloadMap[K]): void {
    this.db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id)
  }

  updateKindAndPayload<K extends EventKind>(id: string, kind: K, payload: EventPayloadMap[K]): void {
    this.db
      .prepare('UPDATE events SET kind = ?, payload = ? WHERE id = ?')
      .run(kind, JSON.stringify(payload), id)
  }

  setNoiseKind(id: string, noiseKind: string | null): void {
    this.db.prepare('UPDATE events SET noiseKind = ? WHERE id = ?').run(noiseKind, id)
  }

  maxSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM events WHERE sessionId = ?')
      .get(sessionId) as { maxSeq: number | null }
    return row.maxSeq ?? 0
  }

  /** Paged history, newest last (ipc-contract.md `sessions.events`). */
  page(sessionId: string, beforeSeq?: number, limit = 200): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events WHERE sessionId = ? AND (? IS NULL OR seq < ?)
           ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(sessionId, beforeSeq ?? null, beforeSeq ?? null, limit) as EventRow[]
    return rows.map(toEvent)
  }

  costSince(sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(payload, '$.totalCostUsd')), 0) AS total
         FROM events WHERE kind = 'result' AND createdAt >= ?`,
      )
      .get(sinceIso) as { total: number }
    return row.total
  }

  tokensSince(sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           COALESCE(json_extract(payload, '$.usage.inputTokens'), 0) +
           COALESCE(json_extract(payload, '$.usage.outputTokens'), 0)
         ), 0) AS total
         FROM events WHERE kind = 'result' AND createdAt >= ?`,
      )
      .get(sinceIso) as { total: number }
    return row.total
  }
}

export class RequestsRepo {
  constructor(private db: AppDatabase) {}

  insert(request: PermissionRequest): void {
    this.db
      .prepare(
        `INSERT INTO permission_requests
           (id, sessionId, projectId, type, toolName, title, explanation, detail, risk, status, createdAt, resolvedAt, deliveryFailed)
         VALUES
           (@id, @sessionId, @projectId, @type, @toolName, @title, @explanation, @detail, @risk, @status, @createdAt, @resolvedAt, @deliveryFailed)`,
      )
      .run({ ...request, deliveryFailed: request.deliveryFailed ? 1 : 0 })
  }

  byId(id: string): PermissionRequest | undefined {
    const row = this.db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined
    return row ? toRequest(row) : undefined
  }

  /** Oldest first within each project group (spec clarification: FIFO). */
  pending(): PermissionRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY projectId, createdAt")
      .all() as RequestRow[]
    return rows.map(toRequest)
  }

  pendingForProject(projectId: string): PermissionRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM permission_requests WHERE status = 'pending' AND projectId = ? ORDER BY createdAt")
      .all(projectId) as RequestRow[]
    return rows.map(toRequest)
  }

  resolve(id: string, status: DecisionOutcome, deliveryFailed = false): void {
    this.db
      .prepare('UPDATE permission_requests SET status = ?, resolvedAt = ?, deliveryFailed = ? WHERE id = ?')
      .run(status, nowIso(), deliveryFailed ? 1 : 0, id)
  }

  history(filter: { projectId?: string; before?: string; limit?: number }): DecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decision_history
         WHERE (? IS NULL OR projectId = ?) AND (? IS NULL OR resolvedAt < ?)
         ORDER BY resolvedAt DESC LIMIT ?`,
      )
      .all(
        filter.projectId ?? null,
        filter.projectId ?? null,
        filter.before ?? null,
        filter.before ?? null,
        filter.limit ?? 100,
      ) as RequestRow[]
    return rows.map(toRequest) as DecisionRecord[]
  }
}

export class StandingRulesRepo {
  constructor(private db: AppDatabase) {}

  insert(input: {
    projectId: string
    toolName: string
    matcher: PermissionRuleMatcher
    createdFromRequestId: string
  }): PermissionRule {
    const rule: PermissionRule = {
      id: newId(),
      projectId: input.projectId,
      toolName: input.toolName,
      matcher: input.matcher,
      createdFromRequestId: input.createdFromRequestId,
      createdAt: nowIso(),
      revokedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, projectId, toolName, matcher, createdFromRequestId, createdAt, revokedAt)
         VALUES (@id, @projectId, @toolName, @matcher, @createdFromRequestId, @createdAt, @revokedAt)`,
      )
      .run({ ...rule, matcher: JSON.stringify(rule.matcher) })
    return rule
  }

  listForProject(projectId: string, includeRevoked = false): PermissionRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM permission_rules WHERE projectId = ?
         ${includeRevoked ? '' : 'AND revokedAt IS NULL'} ORDER BY createdAt`,
      )
      .all(projectId) as (Omit<PermissionRule, 'matcher'> & { matcher: string })[]
    return rows.map((r) => ({ ...r, matcher: JSON.parse(r.matcher) }))
  }

  revoke(ruleId: string): void {
    this.db.prepare('UPDATE permission_rules SET revokedAt = ? WHERE id = ?').run(nowIso(), ruleId)
  }
}

export class RiskRulesRepo {
  constructor(private db: AppDatabase) {}

  list(): RiskClassificationRule[] {
    const rows = this.db.prepare('SELECT * FROM risk_rules ORDER BY position').all() as (Omit<
      RiskClassificationRule,
      'inputMatcher' | 'builtin'
    > & { inputMatcher: string | null; builtin: number })[]
    return rows.map((r) => ({
      ...r,
      inputMatcher: r.inputMatcher ? JSON.parse(r.inputMatcher) : null,
      builtin: r.builtin === 1,
    }))
  }

  replaceAll(rules: RiskClassificationRule[]): void {
    const insert = this.db.prepare(
      `INSERT INTO risk_rules (id, scope, position, toolMatcher, inputMatcher, risk, builtin)
       VALUES (@id, @scope, @position, @toolMatcher, @inputMatcher, @risk, @builtin)`,
    )
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM risk_rules').run()
      rules.forEach((rule, index) =>
        insert.run({
          ...rule,
          position: index,
          inputMatcher: rule.inputMatcher ? JSON.stringify(rule.inputMatcher) : null,
          builtin: rule.builtin ? 1 : 0,
        }),
      )
    })
    run()
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM risk_rules').get() as { n: number }).n
  }
}

export class SwallowRulesRepo {
  constructor(private db: AppDatabase) {}

  list(projectId?: string): SwallowRule[] {
    const rows = (
      projectId
        ? this.db
            .prepare(
              "SELECT * FROM swallow_rules WHERE scope = 'global' OR projectId = ? ORDER BY scope DESC, position",
            )
            .all(projectId)
        : this.db.prepare("SELECT * FROM swallow_rules ORDER BY scope DESC, position").all()
    ) as (Omit<SwallowRule, 'enabled'> & { enabled: number })[]
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }))
  }

  replaceAll(rules: SwallowRule[]): void {
    const insert = this.db.prepare(
      `INSERT INTO swallow_rules (id, scope, projectId, position, eventKindMatcher, pattern, noiseKind, enabled)
       VALUES (@id, @scope, @projectId, @position, @eventKindMatcher, @pattern, @noiseKind, @enabled)`,
    )
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM swallow_rules').run()
      rules.forEach((rule, index) => insert.run({ ...rule, position: index, enabled: rule.enabled ? 1 : 0 }))
    })
    run()
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM swallow_rules').get() as { n: number }).n
  }
}

export class SettingsRepo {
  constructor(private db: AppDatabase) {}

  get(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      | { value: string }
      | undefined
    if (!row) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }
  }

  set(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch }
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('settings', @value)
         ON CONFLICT(key) DO UPDATE SET value = @value`,
      )
      .run({ value: JSON.stringify(next) })
    return next
  }
}

export class DraftsRepo {
  constructor(private db: AppDatabase) {}

  insert(projectId: string, text: string): Draft {
    const draft: Draft = { id: newId(), projectId, text, createdAt: nowIso() }
    this.db
      .prepare('INSERT INTO drafts (id, projectId, text, createdAt) VALUES (@id, @projectId, @text, @createdAt)')
      .run(draft)
    return draft
  }

  listForProject(projectId: string): Draft[] {
    return this.db
      .prepare('SELECT * FROM drafts WHERE projectId = ? ORDER BY createdAt')
      .all(projectId) as Draft[]
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }
}

/** Per-project command history feeding terminal-style composer suggestions. */
export class CommandHistoryRepo {
  constructor(private db: AppDatabase) {}

  add(projectId: string, text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    this.db
      .prepare(
        'INSERT INTO command_history (id, projectId, text, createdAt) VALUES (@id, @projectId, @text, @createdAt)',
      )
      .run({ id: newId(), projectId, text: trimmed, createdAt: nowIso() })
  }

  /**
   * Distinct commands for a project, most recent occurrence first. Ordered by
   * the monotonic rowid rather than createdAt, which can collide within a
   * millisecond and misorder a repeated command.
   */
  recent(projectId: string, limit = 100): string[] {
    const rows = this.db
      .prepare(
        `SELECT text, MAX(rowid) AS r FROM command_history
         WHERE projectId = ? GROUP BY text ORDER BY r DESC LIMIT ?`,
      )
      .all(projectId, limit) as { text: string; r: number }[]
    return rows.map((row) => row.text)
  }
}

/** Planned task queue per project: prompts that auto-run in sequence (FR-023). */
export class TaskQueueRepo {
  constructor(private db: AppDatabase) {}

  add(projectId: string, text: string): QueuedTask {
    const trimmed = text.trim()
    const next = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM task_queue WHERE projectId = ?')
      .get(projectId) as { pos: number }
    const task: QueuedTask = {
      id: newId(),
      projectId,
      text: trimmed,
      position: next.pos,
      createdAt: nowIso(),
    }
    this.db
      .prepare(
        'INSERT INTO task_queue (id, projectId, text, position, createdAt) VALUES (@id, @projectId, @text, @position, @createdAt)',
      )
      .run(task)
    return task
  }

  listForProject(projectId: string): QueuedTask[] {
    return this.db
      .prepare('SELECT * FROM task_queue WHERE projectId = ? ORDER BY position')
      .all(projectId) as QueuedTask[]
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM task_queue WHERE id = ?').run(id)
  }

  /** Removes and returns the front-of-queue task for a project, or null if empty. */
  takeNext(projectId: string): QueuedTask | null {
    const take = this.db.transaction((): QueuedTask | null => {
      const row = this.db
        .prepare('SELECT * FROM task_queue WHERE projectId = ? ORDER BY position LIMIT 1')
        .get(projectId) as QueuedTask | undefined
      if (!row) return null
      this.db.prepare('DELETE FROM task_queue WHERE id = ?').run(row.id)
      return row
    })
    return take()
  }
}

/** Available slash commands / skills per project, for composer suggestions. */
export class ProjectCommandsRepo {
  constructor(private db: AppDatabase) {}

  set(projectId: string, commands: string[]): void {
    this.db
      .prepare(
        `INSERT INTO project_commands (projectId, commands, updatedAt) VALUES (@projectId, @commands, @updatedAt)
         ON CONFLICT(projectId) DO UPDATE SET commands = @commands, updatedAt = @updatedAt`,
      )
      .run({ projectId, commands: JSON.stringify(commands), updatedAt: nowIso() })
  }

  get(projectId: string): string[] {
    const row = this.db
      .prepare('SELECT commands FROM project_commands WHERE projectId = ?')
      .get(projectId) as { commands: string } | undefined
    return row ? (JSON.parse(row.commands) as string[]) : []
  }
}

export interface Repositories {
  projects: ProjectsRepo
  sessions: SessionsRepo
  events: EventsRepo
  requests: RequestsRepo
  standingRules: StandingRulesRepo
  riskRules: RiskRulesRepo
  swallowRules: SwallowRulesRepo
  settings: SettingsRepo
  drafts: DraftsRepo
  commandHistory: CommandHistoryRepo
  projectCommands: ProjectCommandsRepo
  taskQueue: TaskQueueRepo
}

export function createRepositories(db: AppDatabase): Repositories {
  return {
    projects: new ProjectsRepo(db),
    sessions: new SessionsRepo(db),
    events: new EventsRepo(db),
    requests: new RequestsRepo(db),
    standingRules: new StandingRulesRepo(db),
    riskRules: new RiskRulesRepo(db),
    swallowRules: new SwallowRulesRepo(db),
    settings: new SettingsRepo(db),
    drafts: new DraftsRepo(db),
    commandHistory: new CommandHistoryRepo(db),
    projectCommands: new ProjectCommandsRepo(db),
    taskQueue: new TaskQueueRepo(db),
  }
}
