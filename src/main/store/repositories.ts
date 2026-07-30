// Typed repositories over the SQLite schema (data-model.md). All JSON columns
// are serialised here so the rest of the main process works with domain types.
import { randomUUID } from 'node:crypto'
import { transaction, type AppDatabase } from './db'
import type {
  DecisionOutcome,
  DecisionRecord,
  Draft,
  EvalRun,
  EvidenceItem,
  EventKind,
  EventPayloadMap,
  McpScan,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  PermissionRuleMatcher,
  Project,
  ProjectCommand,
  ProjectRef,
  ProjectSource,
  RiskClassificationRule,
  QueuedTask,
  Session,
  SessionEndReason,
  SessionEvent,
  SessionStatus,
  Settings,
  SwallowRule,
  VerifyReport,
  VerifyRun,
} from '@shared/domain'
import { DEFAULT_SETTINGS, emptyVerifyReport } from '@shared/domain'
import type { ApiCall, ApiEvalRun } from '@shared/api-endpoints'

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
  refs: string | null
}

function toProject(row: ProjectRow): Project {
  return { ...row, refs: row.refs ? (JSON.parse(row.refs) as ProjectRef[]) : [] }
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
  /** SQLite has no boolean type, so this arrives as 0/1 (or null pre-migration). */
  bypassPermissions: number | null
}

/** SessionRow is the raw shape; Session wants a real boolean for the flag. */
function toSession(row: SessionRow): Session
function toSession(row: SessionRow | undefined): Session | undefined
function toSession(row: SessionRow | undefined): Session | undefined {
  if (!row) return undefined
  return { ...row, bypassPermissions: row.bypassPermissions === 1 }
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
      refs: [],
    }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, source, createdAt, archivedAt, position)
         VALUES (@id, @name, @path, @source, @createdAt, @archivedAt,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM projects))`,
      )
      .run({
        id: project.id,
        name: project.name,
        path: project.path,
        source: project.source,
        createdAt: project.createdAt,
        archivedAt: project.archivedAt,
      })
    return project
  }

  byId(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row ? toProject(row) : undefined
  }

  byPath(path: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined
    return row ? toProject(row) : undefined
  }

  listActive(): Project[] {
    return (
      this.db
        .prepare('SELECT * FROM projects WHERE archivedAt IS NULL ORDER BY position, createdAt')
        .all() as ProjectRow[]
    ).map(toProject)
  }

  setRefs(id: string, refs: ProjectRef[]): void {
    this.db.prepare('UPDATE projects SET refs = ? WHERE id = ?').run(JSON.stringify(refs), id)
  }

  /** Clears every project's references. Called once at startup so references are
   *  ephemeral — a fresh app launch always starts with no refs (they survive
   *  project switches within a run, but never across a restart). */
  clearAllRefs(): void {
    this.db.prepare('UPDATE projects SET refs = NULL').run()
  }

  /** Reorders an active project to `toIndex` in the sidebar (drag / move up-down). */
  move(id: string, toIndex: number): void {
    transaction(this.db, () => {
      const ids = (
        this.db
          .prepare('SELECT id FROM projects WHERE archivedAt IS NULL ORDER BY position, createdAt')
          .all() as { id: string }[]
      ).map((r) => r.id)
      const from = ids.indexOf(id)
      if (from === -1) return
      ids.splice(from, 1)
      ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id)
      const set = this.db.prepare('UPDATE projects SET position = ? WHERE id = ?')
      ids.forEach((pid, index) => set.run(index, pid))
    })
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
        `INSERT INTO sessions (id, projectId, sdkSessionId, status, statusDetail, branch, diffAdds, diffDels, usageUtilization, usageResetsAt, usageLimitType, startedAt, endedAt, endReason, bypassPermissions)
         VALUES (@id, @projectId, @sdkSessionId, @status, @statusDetail, @branch, @diffAdds, @diffDels, @usageUtilization, @usageResetsAt, @usageLimitType, @startedAt, @endedAt, @endReason, @bypassPermissions)`,
      )
      // SQLite takes no booleans, and the in-memory Session carries non-scalar
      // extras (mcpServers, backgroundTasks) that are not columns — so bind the
      // column set explicitly rather than handing over the whole object.
      .run({
        id: session.id,
        projectId: session.projectId,
        sdkSessionId: session.sdkSessionId,
        status: session.status,
        statusDetail: session.statusDetail,
        branch: session.branch,
        diffAdds: session.diffAdds,
        diffDels: session.diffDels,
        usageUtilization: session.usageUtilization,
        usageResetsAt: session.usageResetsAt,
        usageLimitType: session.usageLimitType,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        endReason: session.endReason,
        bypassPermissions: session.bypassPermissions ? 1 : 0,
      })
  }

  byId(id: string): Session | undefined {
    return toSession(
      this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined,
    )
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
    return toSession(
      this.db
        .prepare('SELECT * FROM sessions WHERE projectId = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1')
        .get(projectId) as SessionRow | undefined,
    )
  }

  latestForProject(projectId: string): Session | undefined {
    return toSession(
      this.db
        .prepare('SELECT * FROM sessions WHERE projectId = ? ORDER BY startedAt DESC LIMIT 1')
        .get(projectId) as SessionRow | undefined,
    )
  }

  latestEndedForProject(projectId: string): Session | undefined {
    return toSession(
      this.db
        .prepare(
          'SELECT * FROM sessions WHERE projectId = ? AND endedAt IS NOT NULL ORDER BY startedAt DESC LIMIT 1',
        )
        .get(projectId) as SessionRow | undefined,
    )
  }

  listUnended(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE endedAt IS NULL').all() as SessionRow[]).map(
      (row) => toSession(row),
    )
  }

  /** Startup reconciliation: any session left open by a previous run is marked ended (FR-022). */
  reconcileAllEnded(reason: SessionEndReason): number {
    const result = this.db
      .prepare(
        `UPDATE sessions SET endedAt = ?, endReason = ?, status = CASE WHEN status = 'error' THEN 'error' ELSE 'done' END
         WHERE endedAt IS NULL`,
      )
      .run(nowIso(), reason)
    return Number(result.changes)
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
  updatePayload<K extends EventKind>(id: string, payload: EventPayloadMap[K], kind?: K): void {
    if (kind !== undefined) {
      this.db
        .prepare('UPDATE events SET kind = ?, payload = ? WHERE id = ?')
        .run(kind, JSON.stringify(payload), id)
    } else {
      this.db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id)
    }
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
    // Total processed tokens = fresh input + output + BOTH cache tiers. On
    // Claude Code turns the cache tiers dominate (inputTokens is only the
    // uncached remainder), so omitting them made "Tokens today" undercount by
    // orders of magnitude. Cache keys are snake_case (spread from the raw SDK
    // usage), the input/output keys are the camelCase ones usageOf maps.
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           COALESCE(json_extract(payload, '$.usage.inputTokens'), 0) +
           COALESCE(json_extract(payload, '$.usage.outputTokens'), 0) +
           COALESCE(json_extract(payload, '$.usage.cache_read_input_tokens'), 0) +
           COALESCE(json_extract(payload, '$.usage.cache_creation_input_tokens'), 0)
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

  /** Removes one decided entry from history; pending rows are never touched. */
  deleteHistory(id: string): void {
    this.db.prepare("DELETE FROM permission_requests WHERE id = ? AND status != 'pending'").run(id)
  }

  /** Clears all decided history across projects; pending rows stay. */
  clearHistory(): void {
    this.db.prepare("DELETE FROM permission_requests WHERE status != 'pending'").run()
  }

  history(filter: { projectId?: string; limit?: number }): DecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM permission_requests
         WHERE status != 'pending' AND (? IS NULL OR projectId = ?)
         ORDER BY resolvedAt DESC LIMIT ?`,
      )
      .all(filter.projectId ?? null, filter.projectId ?? null, filter.limit ?? 100) as RequestRow[]
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

  /** Re-activates a revoked rule (Allowed list tab: Ask → Auto). */
  restore(ruleId: string): void {
    this.db.prepare('UPDATE permission_rules SET revokedAt = NULL WHERE id = ?').run(ruleId)
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

  /**
   * Seed the defaults, once. Not `replaceAll`: risk rules have no editing UI and
   * therefore no IPC surface (see shared/ipc-types.ts), so nothing ever replaced
   * or reordered them and the DELETE-then-reinsert existed for a flow that does
   * not exist. The guard lives here rather than at each call site.
   *
   * Still transactional: a half-written seed would leave count() > 0, so it would
   * never re-seed and the classifier would run on partial rules forever.
   */
  seedIfEmpty(rules: RiskClassificationRule[]): void {
    if (this.count() > 0) return
    const insert = this.db.prepare(
      `INSERT INTO risk_rules (id, scope, position, toolMatcher, inputMatcher, risk, builtin)
       VALUES (@id, @scope, @position, @toolMatcher, @inputMatcher, @risk, @builtin)`,
    )
    transaction(this.db, () =>
      rules.forEach((rule, index) =>
        insert.run({
          ...rule,
          position: index,
          inputMatcher: rule.inputMatcher ? JSON.stringify(rule.inputMatcher) : null,
          builtin: rule.builtin ? 1 : 0,
        }),
      ),
    )
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

  /** Seed the defaults, once. Same reasoning as RiskRulesRepo.seedIfEmpty. */
  seedIfEmpty(rules: SwallowRule[]): void {
    if (this.count() > 0) return
    const insert = this.db.prepare(
      `INSERT INTO swallow_rules (id, scope, projectId, position, eventKindMatcher, pattern, noiseKind, enabled)
       VALUES (@id, @scope, @projectId, @position, @eventKindMatcher, @pattern, @noiseKind, @enabled)`,
    )
    transaction(this.db, () =>
      rules.forEach((rule, index) => insert.run({ ...rule, position: index, enabled: rule.enabled ? 1 : 0 })),
    )
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
    const stored = JSON.parse(row.value) as Record<string, unknown>
    // Migrate the legacy single-server designation to the multi-server list.
    if (typeof stored.databaseMcpServer === 'string' && !stored.databaseMcpServers) {
      stored.databaseMcpServers = [stored.databaseMcpServer]
    }
    delete stored.databaseMcpServer
    // Migrate to the roster/active split: before mcpActiveServers existed, the
    // roster WAS the active combination — seed it so an upgrade keeps working.
    if (!('mcpActiveServers' in stored) && Array.isArray(stored.databaseMcpServers)) {
      stored.mcpActiveServers = [...stored.databaseMcpServers]
    }
    // Migrate plan/work models to the intelligent/worker split: the chosen
    // implementation model (or failing that the planning model) becomes the
    // intelligent model; the worker default comes from DEFAULT_SETTINGS.
    if (!('intelligentModel' in stored)) {
      const work = typeof stored.workModel === 'string' ? stored.workModel : 'default'
      const plan = typeof stored.planModel === 'string' ? stored.planModel : 'default'
      stored.intelligentModel = work !== 'default' ? work : plan
    }
    delete stored.planModel
    delete stored.workModel
    // Dropped setting: a "limit" that only recoloured the spend readout.
    delete stored.dailySpendLimit
    return { ...DEFAULT_SETTINGS, ...stored }
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
    return transaction(this.db, (): QueuedTask | null => {
      const row = this.db
        .prepare('SELECT * FROM task_queue WHERE projectId = ? ORDER BY position LIMIT 1')
        .get(projectId) as QueuedTask | undefined
      if (!row) return null
      this.db.prepare('DELETE FROM task_queue WHERE id = ?').run(row.id)
      return row
    })
  }
}

/** Available slash commands / skills per project, for composer suggestions. */
export class ProjectCommandsRepo {
  constructor(private db: AppDatabase) {}

  set(projectId: string, commands: ProjectCommand[]): void {
    this.db
      .prepare(
        `INSERT INTO project_commands (projectId, commands, updatedAt) VALUES (@projectId, @commands, @updatedAt)
         ON CONFLICT(projectId) DO UPDATE SET commands = @commands, updatedAt = @updatedAt`,
      )
      .run({ projectId, commands: JSON.stringify(commands), updatedAt: nowIso() })
  }

  get(projectId: string): ProjectCommand[] {
    const row = this.db
      .prepare('SELECT commands FROM project_commands WHERE projectId = ?')
      .get(projectId) as { commands: string } | undefined
    if (!row) return []
    // Rows written before descriptions existed hold plain name strings.
    return (JSON.parse(row.commands) as (string | ProjectCommand)[]).map((c) =>
      typeof c === 'string' ? { name: c } : c,
    )
  }
}

export class McpScansRepo {
  constructor(private db: AppDatabase) {}

  /** All scanned combinations for a project, newest first. */
  listForProject(projectId: string): McpScan[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_scans WHERE projectId = ? ORDER BY scannedAt DESC')
      .all(projectId) as (Omit<McpScan, 'servers'> & { servers: string })[]
    return rows.map((r) => ({ ...r, servers: JSON.parse(r.servers) as string[] }))
  }

  /** Record (or refresh) a completed scan for a combination. `scannedAt`
   *  should be when the doc was actually written (its mtime), so a re-scan
   *  that produced nothing does not pass itself off as fresh. */
  upsert(projectId: string, key: string, servers: string[], scannedAt = nowIso()): McpScan {
    this.db
      .prepare(
        `INSERT INTO mcp_scans (id, projectId, comboKey, servers, scannedAt)
         VALUES (@id, @projectId, @comboKey, @servers, @scannedAt)
         ON CONFLICT(projectId, comboKey) DO UPDATE SET servers = @servers, scannedAt = @scannedAt`,
      )
      .run({ id: newId(), projectId, comboKey: key, servers: JSON.stringify(servers), scannedAt })
    const row = this.db
      .prepare('SELECT * FROM mcp_scans WHERE projectId = ? AND comboKey = ?')
      .get(projectId, key) as Omit<McpScan, 'servers'> & { servers: string }
    return { ...row, servers: JSON.parse(row.servers) as string[] }
  }
}

/**
 * Acceptance lines for the eval loop (FR-086..FR-092). One row per small change:
 * the observable sentence, its check, and the developer's verdict + rating.
 */
export class EvalsRepo {
  constructor(private db: AppDatabase) {}

  /** A project's acceptance lines, newest first (FR-090). Ties on `createdAt`
   *  (two lines added inside the same millisecond) break on insert order —
   *  `id` is a random UUID, so ordering by it would be arbitrary. */
  listForProject(projectId: string): EvalRun[] {
    return this.db
      .prepare('SELECT * FROM eval_runs WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC')
      .all(projectId) as EvalRun[]
  }

  add(projectId: string, acceptance: string, checkCmd?: string | null): EvalRun {
    const run: EvalRun = {
      id: newId(),
      projectId,
      acceptance: acceptance.trim(),
      checkCmd: checkCmd?.trim() || null,
      checkStatus: 'not_run',
      verdict: 'pending',
      rating: null,
      note: null,
      attempts: 1,
      judge: null,
      createdAt: nowIso(),
    }
    this.db
      .prepare(
        `INSERT INTO eval_runs
           (id, projectId, acceptance, checkCmd, checkStatus, verdict, rating, note, attempts, judge, createdAt)
         VALUES (@id, @projectId, @acceptance, @checkCmd, @checkStatus, @verdict, @rating, @note, @attempts, @judge, @createdAt)`,
      )
      .run(run)
    return run
  }

  byId(id: string): EvalRun | null {
    return (this.db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as EvalRun) ?? null
  }

  /** Record what the developer saw: check outcome, verdict, rating, note. Only
   *  the keys present are written, so rating survives a later verdict change. */
  update(
    id: string,
    patch: Partial<
      Pick<EvalRun, 'checkCmd' | 'checkStatus' | 'verdict' | 'rating' | 'note' | 'attempts' | 'judge'>
    >,
  ): EvalRun | null {
    const columns = (
      ['checkCmd', 'checkStatus', 'verdict', 'rating', 'note', 'attempts', 'judge'] as const
    ).filter((key) => patch[key] !== undefined)
    if (columns.length > 0) {
      this.db
        .prepare(`UPDATE eval_runs SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
        .run({ id, ...Object.fromEntries(columns.map((c) => [c, patch[c] ?? null])) })
    }
    return (this.db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as EvalRun) ?? null
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM eval_runs WHERE id = ?').run(id)
  }
}

/**
 * Verification runs. History is bounded by count per project (FR-043): the last
 * VERIFY_HISTORY runs survive, older ones are dropped oldest-first on insert.
 *
 * ponytail: pruning on insert, not a scheduled job — a project gains a run only
 * by starting one, so there is no moment where the table grows unattended.
 */
const VERIFY_HISTORY = 20

export class VerifyRunsRepo {
  constructor(private db: AppDatabase) {}

  start(input: {
    projectId: string
    stackId: string
    sessionId: string | null
    branch: string | null
    requested: string[]
  }): VerifyRun {
    const run: VerifyRun = {
      id: newId(),
      projectId: input.projectId,
      stackId: input.stackId,
      sessionId: input.sessionId,
      branch: input.branch,
      requested: input.requested,
      status: 'running',
      report: null,
      note: null,
      startedAt: nowIso(),
      finishedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO verify_runs
           (id, projectId, stackId, sessionId, branch, requested, status, report, note, startedAt, finishedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)`,
      )
      .run(
        run.id,
        run.projectId,
        run.stackId,
        run.sessionId,
        run.branch,
        JSON.stringify(run.requested),
        run.startedAt,
      )
    this.db
      .prepare(
        // Ties on `startedAt` (several runs inside the same millisecond) break on
        // insert order — `id` is a random UUID, so ordering by it would drop an
        // arbitrary run instead of the oldest.
        `DELETE FROM verify_runs WHERE projectId = ? AND id NOT IN (
           SELECT id FROM verify_runs WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(input.projectId, input.projectId, VERIFY_HISTORY)
    return run
  }

  listForProject(projectId: string): VerifyRun[] {
    return (
      this.db
        .prepare('SELECT * FROM verify_runs WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC')
        .all(projectId) as VerifyRunRow[]
    ).map(hydrateVerifyRun)
  }

  byId(id: string): VerifyRun | null {
    const row = this.db.prepare('SELECT * FROM verify_runs WHERE id = ?').get(id) as
      | VerifyRunRow
      | undefined
    return row ? hydrateVerifyRun(row) : null
  }

  /**
   * Close any run left mid-flight by a previous launch (FR-022).
   *
   * A run is closed by the session's turn ending. A container killed by SIGKILL,
   * an app that was killed, or a machine that slept never produces that turn end,
   * and the row then reads as a live run for ever: the Tests section shows Running
   * and will not start another. Inconclusive rather than failed, because nothing is
   * known about what the suites did, and this product never reports an unmeasured
   * outcome as a result.
   */
  reconcileRunning(note: string): number {
    const result = this.db
      .prepare(
        "UPDATE verify_runs SET status = 'inconclusive', note = ?, finishedAt = ? WHERE status = 'running'",
      )
      .run(note, nowIso())
    return Number(result.changes ?? 0)
  }

  /** The run a result belongs to when the session reports one: the newest still
   *  running, so a late report can never overwrite a finished run's figures. */
  runningFor(projectId: string): VerifyRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM verify_runs WHERE projectId = ? AND status = 'running' ORDER BY startedAt DESC, rowid DESC LIMIT 1",
      )
      .get(projectId) as VerifyRunRow | undefined
    return row ? hydrateVerifyRun(row) : null
  }

  /** Record what the session reported. `note` states why an inconclusive run
   *  proved nothing (FR-047); the run is never left as running. */
  finish(id: string, status: VerifyRun['status'], report: VerifyReport | null, note: string | null): void {
    this.db
      .prepare('UPDATE verify_runs SET status = ?, report = ?, note = ?, finishedAt = ? WHERE id = ?')
      .run(status, report ? JSON.stringify(report) : null, note, nowIso(), id)
  }

  /** Evidence is captured after the fact and attaches to the run it proves
   *  (FR-059), without touching its verdict or its figures. */
  attachEvidence(id: string, evidence: EvidenceItem[]): void {
    const run = this.byId(id)
    if (!run) return
    const report = run.report ?? emptyVerifyReport()
    report.evidence = [...report.evidence, ...evidence]
    this.db.prepare('UPDATE verify_runs SET report = ? WHERE id = ?').run(JSON.stringify(report), id)
  }
}

interface VerifyRunRow {
  id: string
  projectId: string
  stackId: string
  sessionId: string | null
  branch: string | null
  requested: string
  status: VerifyRun['status']
  report: string | null
  note: string | null
  startedAt: string
  finishedAt: string | null
}

function hydrateVerifyRun(row: VerifyRunRow): VerifyRun {
  return {
    ...row,
    requested: parseJson<string[]>(row.requested) ?? [],
    report: row.report ? parseJson<VerifyReport>(row.report) : null,
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * API eval sets. Same count-bounded history as verification runs, and for the
 * same reason: a run exists only because the developer started one, so pruning
 * on insert needs no scheduled job.
 */
const API_HISTORY = 20

export class ApiRunsRepo {
  constructor(private db: AppDatabase) {}

  /** Same orphan as verify_runs, same cause: 'error' is this table's terminal word
   *  for a run that proved nothing, and it has no 'inconclusive'. */
  reconcileRunning(note: string): number {
    const result = this.db
      .prepare(
        "UPDATE api_runs SET status = 'error', note = ?, finishedAt = ? WHERE status = 'running'",
      )
      .run(note, nowIso())
    return Number(result.changes ?? 0)
  }

  start(input: { projectId: string; baseUrl: string; sessionId: string | null }): ApiEvalRun {
    const run: ApiEvalRun = {
      id: newId(),
      projectId: input.projectId,
      baseUrl: input.baseUrl,
      launched: false,
      sessionId: input.sessionId,
      status: 'running',
      note: null,
      calls: [],
      startedAt: nowIso(),
      finishedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO api_runs
           (id, projectId, baseUrl, launched, sessionId, status, note, calls, startedAt, finishedAt)
         VALUES (?, ?, ?, 0, ?, 'running', NULL, '[]', ?, NULL)`,
      )
      .run(run.id, run.projectId, run.baseUrl, run.sessionId, run.startedAt)
    this.db
      .prepare(
        `DELETE FROM api_runs WHERE projectId = ? AND id NOT IN (
           SELECT id FROM api_runs WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(input.projectId, input.projectId, API_HISTORY)
    return run
  }

  listForProject(projectId: string): ApiEvalRun[] {
    return (
      this.db
        .prepare('SELECT * FROM api_runs WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC')
        .all(projectId) as ApiRunRow[]
    ).map(hydrateApiRun)
  }

  byId(id: string): ApiEvalRun | null {
    const row = this.db.prepare('SELECT * FROM api_runs WHERE id = ?').get(id) as
      | ApiRunRow
      | undefined
    return row ? hydrateApiRun(row) : null
  }

  /** Record what the app actually sent and received. A run is never left running. */
  finish(
    id: string,
    status: ApiEvalRun['status'],
    calls: ApiCall[],
    note: string | null,
    launched: boolean,
  ): void {
    this.db
      .prepare(
        'UPDATE api_runs SET status = ?, calls = ?, note = ?, launched = ?, finishedAt = ? WHERE id = ?',
      )
      .run(status, JSON.stringify(calls), note, launched ? 1 : 0, nowIso(), id)
  }
}

interface ApiRunRow {
  id: string
  projectId: string
  baseUrl: string
  launched: number
  sessionId: string | null
  status: ApiEvalRun['status']
  note: string | null
  calls: string
  startedAt: string
  finishedAt: string | null
}

function hydrateApiRun(row: ApiRunRow): ApiEvalRun {
  return {
    ...row,
    launched: row.launched === 1,
    calls: parseJson<ApiCall[]>(row.calls) ?? [],
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
  mcpScans: McpScansRepo
  evals: EvalsRepo
  verifyRuns: VerifyRunsRepo
  apiRuns: ApiRunsRepo
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
    mcpScans: new McpScansRepo(db),
    evals: new EvalsRepo(db),
    verifyRuns: new VerifyRunsRepo(db),
    apiRuns: new ApiRunsRepo(db),
  }
}
