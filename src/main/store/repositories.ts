import { randomUUID } from 'node:crypto'
import { transaction, type AppDatabase } from './db'
import type { DiagramPlan } from '@shared/diagram'
import type {
  CustomSkill,
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
  QueuedTask,
  SectionKind,
  Session,
  FlowItem,
  FlowLesson,
  FlowLessonEvidence,
  FlowRun,
  ScopedItem,
  SecurityReport,
  SecurityRun,
  SecurityScope,
  SuiteResult,
  SessionEndReason,
  SessionEngine,
  SessionEvent,
  SessionMode,
  SessionStatus,
  RiskLevel,
  Settings,
  VerifyReport,
  VerifyRun,
} from '@shared/domain'
import {
  DEFAULT_SESSION_ENGINE,
  DEFAULT_SESSION_MODE,
  DEFAULT_SETTINGS,
  emptyVerifyReport,
} from '@shared/domain'
import type { ApiCall, ApiEvalRun, ApiTarget } from '@shared/api-endpoints'
import type { RulePref, RuleKind } from '@main/inbox/rule-prefs'

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

interface ProjectRow {
  id: string
  name: string
  path: string
  source: ProjectSource
  createdAt: string
  archivedAt: string | null
  refs: string | null
  defaultSessionMode: SessionMode
  useContainers: number
}

function toProject(row: ProjectRow): Project {
  return {
    ...row,
    refs: row.refs ? (JSON.parse(row.refs) as ProjectRef[]) : [],
    useContainers: row.useContainers === 1,
  }
}

interface SessionRow {
  id: string
  projectId: string
  engine: SessionEngine | null
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
  bypassPermissions: number | null
  planMode: number | null
  label: string | null
  sectionKind: SectionKind | null
  derivedName: string | null
}

function toSession(row: SessionRow): Session
function toSession(row: SessionRow | undefined): Session | undefined
function toSession(row: SessionRow | undefined): Session | undefined {
  if (!row) return undefined
  return {
    ...row,
    engine: row.engine ?? DEFAULT_SESSION_ENGINE,
    bypassPermissions: row.bypassPermissions === 1,
    planMode: row.planMode === 1,
  }
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

class ProjectsRepo {
  constructor(private db: AppDatabase) {}

  insert(input: {
    name: string
    path: string
    source: ProjectSource
    defaultSessionMode?: SessionMode
  }): Project {
    const project: Project = {
      id: newId(),
      name: input.name,
      path: input.path,
      source: input.source,
      createdAt: nowIso(),
      archivedAt: null,
      refs: [],
      defaultSessionMode: input.defaultSessionMode ?? DEFAULT_SESSION_MODE,
      useContainers: false,
    }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, source, createdAt, archivedAt, defaultSessionMode, position)
         VALUES (@id, @name, @path, @source, @createdAt, @archivedAt, @defaultSessionMode,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM projects))`,
      )
      .run({
        id: project.id,
        name: project.name,
        path: project.path,
        source: project.source,
        createdAt: project.createdAt,
        archivedAt: project.archivedAt,
        defaultSessionMode: project.defaultSessionMode,
      })
    return project
  }

  setSessionMode(id: string, mode: SessionMode): void {
    this.db.prepare('UPDATE projects SET defaultSessionMode = ? WHERE id = ?').run(mode, id)
  }

  setUseContainers(id: string, on: boolean): void {
    this.db.prepare('UPDATE projects SET useContainers = ? WHERE id = ?').run(on ? 1 : 0, id)
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

  listArchived(): Project[] {
    return (
      this.db
        .prepare('SELECT * FROM projects WHERE archivedAt IS NOT NULL ORDER BY archivedAt DESC')
        .all() as ProjectRow[]
    ).map(toProject)
  }

  setRefs(id: string, refs: ProjectRef[]): void {
    this.db.prepare('UPDATE projects SET refs = ? WHERE id = ?').run(JSON.stringify(refs), id)
  }

  clearAllRefs(): void {
    this.db.prepare('UPDATE projects SET refs = NULL').run()
  }

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

  unarchive(id: string): void {
    this.db.prepare('UPDATE projects SET archivedAt = NULL WHERE id = ?').run(id)
  }

  setPath(id: string, path: string): void {
    this.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path, id)
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  }
}

class SessionsRepo {
  constructor(private db: AppDatabase) {}

  insert(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, projectId, engine, sdkSessionId, status, statusDetail, branch, diffAdds, diffDels, usageUtilization, usageResetsAt, usageLimitType, startedAt, endedAt, endReason, bypassPermissions, planMode)
         VALUES (@id, @projectId, @engine, @sdkSessionId, @status, @statusDetail, @branch, @diffAdds, @diffDels, @usageUtilization, @usageResetsAt, @usageLimitType, @startedAt, @endedAt, @endReason, @bypassPermissions, @planMode)`,
      )
      .run({
        id: session.id,
        projectId: session.projectId,
        engine: session.engine ?? DEFAULT_SESSION_ENGINE,
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
        planMode: session.planMode ? 1 : 0,
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
        | 'label'
        | 'sectionKind'
        | 'derivedName'
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

  latestEndedForProject(projectId: string, engine?: SessionEngine): Session | undefined {
    const row = engine
      ? this.db
          .prepare(
            'SELECT * FROM sessions WHERE projectId = ? AND endedAt IS NOT NULL AND COALESCE(engine, ?) = ? ORDER BY startedAt DESC LIMIT 1',
          )
          .get(projectId, DEFAULT_SESSION_ENGINE, engine)
      : this.db
          .prepare(
            'SELECT * FROM sessions WHERE projectId = ? AND endedAt IS NOT NULL ORDER BY startedAt DESC LIMIT 1',
          )
          .get(projectId)
    return toSession(row as SessionRow | undefined)
  }

  listUnended(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE endedAt IS NULL').all() as SessionRow[]).map(
      (row) => toSession(row),
    )
  }

  reconcileAllEnded(reason: SessionEndReason, note?: string): number {
    const result = this.db
      .prepare(
        `UPDATE sessions SET endedAt = ?, endReason = ?, statusDetail = COALESCE(statusDetail, ?),
           status = CASE WHEN status = 'error' THEN 'error' ELSE 'done' END
         WHERE endedAt IS NULL`,
      )
      .run(nowIso(), reason, note ?? null)
    return Number(result.changes)
  }

}

class EventsRepo {
  constructor(private db: AppDatabase) {}

  private pending: SessionEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null

  private static readonly FLUSH_INTERVAL_MS = 33

  insert(event: SessionEvent): void {
    this.pending.push(event)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), EventsRepo.FLUSH_INTERVAL_MS)
      this.flushTimer.unref()
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    const insert = this.db.prepare(
      `INSERT INTO events (id, sessionId, seq, kind, payload, noiseKind, createdAt)
       VALUES (@id, @sessionId, @seq, @kind, @payload, @noiseKind, @createdAt)`,
    )
    transaction(this.db, () => {
      for (const event of batch) {
        insert.run({ ...event, payload: JSON.stringify(event.payload) })
      }
    })
  }

  updatePayload<K extends EventKind>(id: string, payload: EventPayloadMap[K], kind?: K): void {
    this.flush()
    if (kind !== undefined) {
      this.db
        .prepare('UPDATE events SET kind = ?, payload = ? WHERE id = ?')
        .run(kind, JSON.stringify(payload), id)
    } else {
      this.db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id)
    }
  }

  setNoiseKind(id: string, noiseKind: string | null): void {
    this.flush()
    this.db.prepare('UPDATE events SET noiseKind = ? WHERE id = ?').run(noiseKind, id)
  }

  maxSeq(sessionId: string): number {
    this.flush()
    const row = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM events WHERE sessionId = ?')
      .get(sessionId) as { maxSeq: number | null }
    return row.maxSeq ?? 0
  }

  page(sessionId: string, beforeSeq?: number, limit = 200): SessionEvent[] {
    this.flush()
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
    this.flush()
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(payload, '$.totalCostUsd')), 0) AS total
         FROM events WHERE kind = 'result' AND createdAt >= ?`,
      )
      .get(sinceIso) as { total: number }
    return row.total
  }

  tokensSince(sinceIso: string): number {
    this.flush()
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

class RequestsRepo {
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

  deleteHistory(id: string): void {
    this.db.prepare("DELETE FROM permission_requests WHERE id = ? AND status != 'pending'").run(id)
  }

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

class StandingRulesRepo {
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

  restore(ruleId: string): void {
    this.db.prepare('UPDATE permission_rules SET revokedAt = NULL WHERE id = ?').run(ruleId)
  }
}

export class RulePrefsRepo {
  constructor(private db: AppDatabase) {}

  list(): RulePref[] {
    const rows = this.db
      .prepare('SELECT id, kind, disabled, risk, body, position FROM rule_prefs')
      .all() as (Omit<RulePref, 'disabled'> & { disabled: number })[]
    return rows.map((r) => ({ ...r, disabled: r.disabled === 1 }))
  }

  setDisabled(id: string, kind: RuleKind, disabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO rule_prefs (id, kind, disabled, risk, body, position, createdAt)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?)
         ON CONFLICT (id, kind) DO UPDATE SET disabled = excluded.disabled`,
      )
      .run(id, kind, disabled ? 1 : 0, nowIso())
  }

  setRisk(id: string, risk: RiskLevel | null): void {
    this.db
      .prepare(
        `INSERT INTO rule_prefs (id, kind, disabled, risk, body, position, createdAt)
         VALUES (?, 'risk', 0, ?, NULL, NULL, ?)
         ON CONFLICT (id, kind) DO UPDATE SET risk = excluded.risk`,
      )
      .run(id, risk, nowIso())
  }

  addCustom(kind: RuleKind, body: string): RulePref {
    const next =
      (
        this.db
          .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM rule_prefs WHERE kind = ?')
          .get(kind) as { p: number }
      ).p + 1
    const pref: RulePref = {
      id: newId(),
      kind,
      disabled: false,
      risk: null,
      body,
      position: next,
    }
    this.db
      .prepare(
        `INSERT INTO rule_prefs (id, kind, disabled, risk, body, position, createdAt)
         VALUES (?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(pref.id, kind, body, next, nowIso())
    return pref
  }

  remove(id: string, kind: RuleKind): void {
    this.db.prepare('DELETE FROM rule_prefs WHERE id = ? AND kind = ?').run(id, kind)
  }
}

class SettingsRepo {
  constructor(private db: AppDatabase) {}

  get(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      | { value: string }
      | undefined
    if (!row) return { ...DEFAULT_SETTINGS }
    const stored = JSON.parse(row.value) as Record<string, unknown>
    if (typeof stored.databaseMcpServer === 'string' && !stored.databaseMcpServers) {
      stored.databaseMcpServers = [stored.databaseMcpServer]
    }
    delete stored.databaseMcpServer
    if (!('mcpActiveServers' in stored) && Array.isArray(stored.databaseMcpServers)) {
      stored.mcpActiveServers = [...stored.databaseMcpServers]
    }
    if (!('intelligentModel' in stored)) {
      const work = typeof stored.workModel === 'string' ? stored.workModel : 'default'
      const plan = typeof stored.planModel === 'string' ? stored.planModel : 'default'
      stored.intelligentModel = work !== 'default' ? work : plan
    }
    delete stored.planModel
    delete stored.workModel
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

class DraftsRepo {
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

  update(id: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) {
      this.remove(id)
      return
    }
    this.db.prepare('UPDATE task_queue SET text = ? WHERE id = ?').run(trimmed, id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM task_queue WHERE id = ?').run(id)
  }

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
    return (JSON.parse(row.commands) as (string | ProjectCommand)[]).map((c) =>
      typeof c === 'string' ? { name: c } : c,
    )
  }
}

class McpScansRepo {
  constructor(private db: AppDatabase) {}

  listForProject(projectId: string): McpScan[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_scans WHERE projectId = ? ORDER BY scannedAt DESC')
      .all(projectId) as (Omit<McpScan, 'servers'> & { servers: string })[]
    return rows.map((r) => ({ ...r, servers: JSON.parse(r.servers) as string[] }))
  }

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

export class EvalsRepo {
  constructor(private db: AppDatabase) {}

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

function pruneToLast(
  db: AppDatabase,
  table: 'verify_runs' | 'api_runs' | 'security_runs' | 'flow_runs',
  projectId: string,
  keep: number,
): void {
  db.prepare(
    `DELETE FROM ${table} WHERE projectId = ? AND id NOT IN (
       SELECT id FROM ${table} WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC LIMIT ?
     )`,
  ).run(projectId, projectId, keep)
}

const VERIFY_HISTORY = 20

class VerifyRunsRepo {
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
    pruneToLast(this.db, 'verify_runs', input.projectId, VERIFY_HISTORY)
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

  reconcileRunning(note: string): number {
    const result = this.db
      .prepare(
        "UPDATE verify_runs SET status = 'inconclusive', note = ?, finishedAt = ? WHERE status = 'running'",
      )
      .run(note, nowIso())
    return Number(result.changes ?? 0)
  }

  reconcileStale(deadlineIso: string, note: string): string[] {
    const affected = this.db
      .prepare(
        "SELECT DISTINCT projectId FROM verify_runs WHERE status = 'running' AND startedAt < ?",
      )
      .all(deadlineIso) as { projectId: string }[]
    if (affected.length === 0) return []
    this.db
      .prepare(
        "UPDATE verify_runs SET status = 'inconclusive', note = ?, finishedAt = ? WHERE status = 'running' AND startedAt < ?",
      )
      .run(note, nowIso(), deadlineIso)
    return affected.map((row) => row.projectId)
  }

  runningFor(projectId: string): VerifyRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM verify_runs WHERE projectId = ? AND status = 'running' ORDER BY startedAt DESC, rowid DESC LIMIT 1",
      )
      .get(projectId) as VerifyRunRow | undefined
    return row ? hydrateVerifyRun(row) : null
  }

  finish(id: string, status: VerifyRun['status'], report: VerifyReport | null, note: string | null): void {
    this.db
      .prepare('UPDATE verify_runs SET status = ?, report = ?, note = ?, finishedAt = ? WHERE id = ?')
      .run(status, report ? JSON.stringify(report) : null, note, nowIso(), id)
  }

  noteSuite(id: string, result: SuiteResult): void {
    const run = this.byId(id)
    if (!run || run.status !== 'running') return
    const report = run.report ?? emptyVerifyReport()
    if (report.suites.some((s) => s.id === result.id)) return
    report.suites = [...report.suites, result]
    this.db.prepare('UPDATE verify_runs SET report = ? WHERE id = ?').run(JSON.stringify(report), id)
  }

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

const FLOW_HISTORY = 10

class FlowRunsRepo {
  constructor(private db: AppDatabase) {}

  start(input: {
    projectId: string
    featureId: string
    featureTitle: string
    sessionId: string | null
    concurrency: number
  }): FlowRun {
    const run: FlowRun = {
      id: newId(),
      projectId: input.projectId,
      featureId: input.featureId,
      featureTitle: input.featureTitle,
      status: 'scoping',
      sessionId: input.sessionId,
      risks: [],
      outOfScope: [],
      concurrency: input.concurrency,
      baseBranch: null,
      worktreeRoot: null,
      crosscheckRound: 0,
      concerns: [],
      note: null,
      startedAt: nowIso(),
      finishedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO flow_runs
           (id, projectId, featureId, featureTitle, status, sessionId, risks, outOfScope,
            concurrency, baseBranch, worktreeRoot, crosscheckRound, concerns, note, startedAt, finishedAt)
         VALUES (?, ?, ?, ?, 'scoping', ?, '[]', '[]', ?, NULL, NULL, 0, '[]', NULL, ?, NULL)`,
      )
      .run(
        run.id,
        run.projectId,
        run.featureId,
        run.featureTitle,
        run.sessionId,
        run.concurrency,
        run.startedAt,
      )
    pruneToLast(this.db, 'flow_runs', input.projectId, FLOW_HISTORY)
    return run
  }

  listForProject(projectId: string): FlowRun[] {
    return (
      this.db
        .prepare('SELECT * FROM flow_runs WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC')
        .all(projectId) as FlowRunRow[]
    ).map(hydrateFlowRun)
  }

  byId(id: string): FlowRun | null {
    const row = this.db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as
      | FlowRunRow
      | undefined
    return row ? hydrateFlowRun(row) : null
  }

  bySessionId(sessionId: string): FlowRun | null {
    const row = this.db.prepare('SELECT * FROM flow_runs WHERE sessionId = ?').get(sessionId) as
      | FlowRunRow
      | undefined
    return row ? hydrateFlowRun(row) : null
  }

  openFor(projectId: string): FlowRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM flow_runs WHERE projectId = ?
           AND status NOT IN ('done', 'failed', 'cancelled')
         ORDER BY startedAt DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId) as FlowRunRow | undefined
    return row ? hydrateFlowRun(row) : null
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        FlowRun,
        | 'status'
        | 'sessionId'
        | 'risks'
        | 'outOfScope'
        | 'concurrency'
        | 'baseBranch'
        | 'worktreeRoot'
        | 'crosscheckRound'
        | 'concerns'
        | 'note'
        | 'finishedAt'
      >
    >,
  ): void {
    const columns = (
      ['status', 'sessionId', 'concurrency', 'baseBranch', 'worktreeRoot', 'crosscheckRound', 'note', 'finishedAt'] as const
    ).filter((key) => patch[key] !== undefined)
    const json = (['risks', 'outOfScope', 'concerns'] as const).filter((key) => patch[key] !== undefined)
    if (columns.length === 0 && json.length === 0) return
    const sets = [...columns, ...json].map((key) => `${key} = ?`).join(', ')
    const values = [
      ...columns.map((key) => patch[key] ?? null),
      ...json.map((key) => JSON.stringify(patch[key])),
    ]
    this.db.prepare(`UPDATE flow_runs SET ${sets} WHERE id = ?`).run(...values, id)
  }

  finish(id: string, status: FlowRun['status'], note: string | null): void {
    this.db
      .prepare('UPDATE flow_runs SET status = ?, note = ?, finishedAt = ? WHERE id = ?')
      .run(status, note, nowIso(), id)
  }

  reconcileRunning(note: string): string[] {
    const affected = this.db
      .prepare(
        `SELECT DISTINCT projectId FROM flow_runs
         WHERE status IN ('scoping', 'publishing')`,
      )
      .all() as { projectId: string }[]
    if (affected.length === 0) return []
    this.db
      .prepare(
        `UPDATE flow_runs SET status = CASE status
           WHEN 'publishing' THEN 'publish_interrupted' ELSE 'failed' END,
           note = ?, finishedAt = CASE status WHEN 'publishing' THEN NULL ELSE ? END
         WHERE status IN ('scoping', 'publishing')`,
      )
      .run(note, nowIso())
    return affected.map((row) => row.projectId)
  }
}

class FlowItemsRepo {
  constructor(private db: AppDatabase) {}

  replaceForRun(runId: string, projectId: string, items: readonly ScopedItem[]): FlowItem[] {
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM flow_items WHERE runId = ? AND status = ?').run(runId, 'proposed')
      const insert = this.db.prepare(
        `INSERT INTO flow_items
           (id, runId, projectId, position, localId, title, body, acceptance, estimate, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 0)`,
      )
      items.forEach((item, index) => {
        insert.run(
          newId(),
          runId,
          projectId,
          index,
          item.localId,
          item.title,
          item.body,
          JSON.stringify(item.acceptance),
          item.estimate,
        )
      })
      return this.listForRun(runId)
    })
  }

  listForRun(runId: string): FlowItem[] {
    return (
      this.db
        .prepare('SELECT * FROM flow_items WHERE runId = ? ORDER BY position')
        .all(runId) as FlowItemRow[]
    ).map(hydrateFlowItem)
  }

  listForProject(projectId: string): FlowItem[] {
    return (
      this.db
        .prepare('SELECT * FROM flow_items WHERE projectId = ? ORDER BY runId, position')
        .all(projectId) as FlowItemRow[]
    ).map(hydrateFlowItem)
  }

  byId(id: string): FlowItem | null {
    const row = this.db.prepare('SELECT * FROM flow_items WHERE id = ?').get(id) as
      | FlowItemRow
      | undefined
    return row ? hydrateFlowItem(row) : null
  }

  bySessionId(sessionId: string): FlowItem | null {
    const row = this.db.prepare('SELECT * FROM flow_items WHERE sessionId = ?').get(sessionId) as
      | FlowItemRow
      | undefined
    return row ? hydrateFlowItem(row) : null
  }

  countActive(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM flow_items WHERE runId = ? AND status IN
           ('preparing', 'implementing', 'tech_review', 'revising', 'raising_pr', 'pr_interrupted')`,
      )
      .get(runId) as { n: number }
    return row.n
  }

  nextQueued(runId: string): FlowItem | null {
    const row = this.db
      .prepare("SELECT * FROM flow_items WHERE runId = ? AND status = 'queued' ORDER BY position LIMIT 1")
      .get(runId) as FlowItemRow | undefined
    return row ? hydrateFlowItem(row) : null
  }

  queuePublished(runId: string): number {
    const result = this.db
      .prepare("UPDATE flow_items SET status = 'queued' WHERE runId = ? AND status = 'published'")
      .run(runId)
    return Number(result.changes ?? 0)
  }

  byLocalId(runId: string, localId: string): FlowItem | null {
    const row = this.db
      .prepare('SELECT * FROM flow_items WHERE runId = ? AND localId = ?')
      .get(runId, localId) as FlowItemRow | undefined
    return row ? hydrateFlowItem(row) : null
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        FlowItem,
        | 'title'
        | 'body'
        | 'workItemId'
        | 'workItemUrl'
        | 'branch'
        | 'worktreePath'
        | 'sessionId'
        | 'status'
        | 'attempts'
        | 'prId'
        | 'prUrl'
        | 'note'
        | 'startedAt'
        | 'finishedAt'
      >
    >,
  ): void {
    const columns = (
      [
        'title',
        'body',
        'workItemId',
        'workItemUrl',
        'branch',
        'worktreePath',
        'sessionId',
        'status',
        'attempts',
        'prId',
        'prUrl',
        'note',
        'startedAt',
        'finishedAt',
      ] as const
    ).filter((key) => patch[key] !== undefined)
    if (columns.length === 0) return
    const sets = columns.map((key) => `${key} = ?`).join(', ')
    this.db
      .prepare(`UPDATE flow_items SET ${sets} WHERE id = ?`)
      .run(...columns.map((key) => patch[key] ?? null), id)
  }
}

interface FlowRunRow {
  id: string
  projectId: string
  featureId: string
  featureTitle: string
  status: FlowRun['status']
  sessionId: string | null
  risks: string
  outOfScope: string
  concurrency: number
  baseBranch: string | null
  worktreeRoot: string | null
  crosscheckRound: number
  concerns: string
  note: string | null
  startedAt: string
  finishedAt: string | null
}

interface FlowItemRow {
  id: string
  runId: string
  projectId: string
  position: number
  localId: string
  title: string
  body: string
  acceptance: string
  estimate: FlowItem['estimate']
  workItemId: string | null
  workItemUrl: string | null
  branch: string | null
  worktreePath: string | null
  sessionId: string | null
  status: FlowItem['status']
  attempts: number
  prId: string | null
  prUrl: string | null
  note: string | null
  startedAt: string | null
  finishedAt: string | null
}

function hydrateFlowRun(row: FlowRunRow): FlowRun {
  return {
    ...row,
    risks: parseJson<string[]>(row.risks) ?? [],
    outOfScope: parseJson<string[]>(row.outOfScope) ?? [],
    concerns: parseJson<string[]>(row.concerns) ?? [],
  }
}

class FlowLessonsRepo {
  constructor(private db: AppDatabase) {}

  listForProject(projectId: string): FlowLesson[] {
    return (
      this.db
        .prepare('SELECT * FROM flow_lessons WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC')
        .all(projectId) as FlowLessonRow[]
    ).map(hydrateFlowLesson)
  }

  rejectedRules(projectId: string): string[] {
    return (
      this.db
        .prepare("SELECT rule FROM flow_lessons WHERE projectId = ? AND status = 'rejected'")
        .all(projectId) as { rule: string }[]
    ).map((row) => row.rule)
  }

  propose(input: {
    projectId: string
    runId: string | null
    ruleId: string
    rule: string
    section: string | null
    evidence: FlowLessonEvidence[]
  }): FlowLesson | null {
    const existing = this.db
      .prepare('SELECT * FROM flow_lessons WHERE projectId = ? AND ruleId = ?')
      .get(input.projectId, input.ruleId) as FlowLessonRow | undefined
    if (existing) return null
    const lesson: FlowLesson = {
      id: newId(),
      projectId: input.projectId,
      runId: input.runId,
      ruleId: input.ruleId,
      rule: input.rule,
      section: input.section,
      evidence: input.evidence,
      status: 'proposed',
      reason: null,
      createdAt: nowIso(),
      decidedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO flow_lessons
           (id, projectId, runId, ruleId, rule, section, evidence, status, reason, createdAt, decidedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?, NULL)`,
      )
      .run(
        lesson.id,
        lesson.projectId,
        lesson.runId,
        lesson.ruleId,
        lesson.rule,
        lesson.section,
        JSON.stringify(lesson.evidence),
        lesson.createdAt,
      )
    return lesson
  }

  byId(id: string): FlowLesson | null {
    const row = this.db.prepare('SELECT * FROM flow_lessons WHERE id = ?').get(id) as
      | FlowLessonRow
      | undefined
    return row ? hydrateFlowLesson(row) : null
  }

  decide(id: string, status: 'accepted' | 'rejected', reason: string | null): void {
    this.db
      .prepare('UPDATE flow_lessons SET status = ?, reason = ?, decidedAt = ? WHERE id = ?')
      .run(status, reason, nowIso(), id)
  }
}

interface FlowLessonRow {
  id: string
  projectId: string
  runId: string | null
  ruleId: string
  rule: string
  section: string | null
  evidence: string
  status: FlowLesson['status']
  reason: string | null
  createdAt: string
  decidedAt: string | null
}

function hydrateFlowLesson(row: FlowLessonRow): FlowLesson {
  return {
    ...row,
    evidence: parseJson<FlowLessonEvidence[]>(row.evidence) ?? [],
  }
}

function hydrateFlowItem(row: FlowItemRow): FlowItem {
  return {
    ...row,
    acceptance: parseJson<string[]>(row.acceptance) ?? [],
  }
}

const SECURITY_HISTORY = 20

class SecurityRunsRepo {
  constructor(private db: AppDatabase) {}

  start(input: {
    projectId: string
    sessionId: string | null
    scope: SecurityScope
    branch: string | null
    outputDir: string
  }): SecurityRun {
    const run: SecurityRun = {
      id: newId(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      scope: input.scope,
      branch: input.branch,
      status: 'running',
      report: null,
      note: null,
      outputDir: input.outputDir,
      startedAt: nowIso(),
      finishedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO security_runs
           (id, projectId, sessionId, scope, branch, status, report, note, outputDir, startedAt, finishedAt)
         VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        run.id,
        run.projectId,
        run.sessionId,
        run.scope,
        run.branch,
        run.outputDir,
        run.startedAt,
      )
    pruneToLast(this.db, 'security_runs', input.projectId, SECURITY_HISTORY)
    return run
  }

  listForProject(projectId: string): SecurityRun[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM security_runs WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC',
        )
        .all(projectId) as SecurityRunRow[]
    ).map(hydrateSecurityRun)
  }

  byId(id: string): SecurityRun | null {
    const row = this.db.prepare('SELECT * FROM security_runs WHERE id = ?').get(id) as
      | SecurityRunRow
      | undefined
    return row ? hydrateSecurityRun(row) : null
  }

  runningFor(projectId: string): SecurityRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM security_runs WHERE projectId = ? AND status = 'running' ORDER BY startedAt DESC, rowid DESC LIMIT 1",
      )
      .get(projectId) as SecurityRunRow | undefined
    return row ? hydrateSecurityRun(row) : null
  }

  finish(
    id: string,
    status: SecurityRun['status'],
    report: SecurityReport | null,
    note: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE security_runs SET status = ?, report = ?, note = ?, finishedAt = ? WHERE id = ?',
      )
      .run(status, report ? JSON.stringify(report) : null, note, nowIso(), id)
  }

  reconcileRunning(note: string): number {
    const result = this.db
      .prepare(
        "UPDATE security_runs SET status = 'failed', note = ?, finishedAt = ? WHERE status = 'running'",
      )
      .run(note, nowIso())
    return Number(result.changes ?? 0)
  }
}

interface SecurityRunRow {
  id: string
  projectId: string
  sessionId: string | null
  scope: SecurityScope
  branch: string | null
  status: SecurityRun['status']
  report: string | null
  note: string | null
  outputDir: string
  startedAt: string
  finishedAt: string | null
}

function hydrateSecurityRun(row: SecurityRunRow): SecurityRun {
  return {
    ...row,
    report: row.report ? parseJson<SecurityReport>(row.report) : null,
  }
}

const API_HISTORY = 20

class ApiRunsRepo {
  constructor(private db: AppDatabase) {}

  reconcileRunning(note: string): number {
    const result = this.db
      .prepare(
        "UPDATE api_runs SET status = 'error', note = ?, finishedAt = ? WHERE status = 'running'",
      )
      .run(note, nowIso())
    return Number(result.changes ?? 0)
  }

  reconcileStale(deadlineIso: string, note: string): string[] {
    const affected = this.db
      .prepare("SELECT DISTINCT projectId FROM api_runs WHERE status = 'running' AND startedAt < ?")
      .all(deadlineIso) as { projectId: string }[]
    if (affected.length === 0) return []
    this.db
      .prepare(
        "UPDATE api_runs SET status = 'error', note = ?, finishedAt = ? WHERE status = 'running' AND startedAt < ?",
      )
      .run(note, nowIso(), deadlineIso)
    return affected.map((row) => row.projectId)
  }

  start(input: {
    projectId: string
    baseUrl: string
    target: ApiTarget
    sessionId: string | null
  }): ApiEvalRun {
    const run: ApiEvalRun = {
      id: newId(),
      projectId: input.projectId,
      baseUrl: input.baseUrl,
      target: input.target,
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
           (id, projectId, baseUrl, target, launched, sessionId, status, note, calls, startedAt, finishedAt)
         VALUES (?, ?, ?, ?, 0, ?, 'running', NULL, '[]', ?, NULL)`,
      )
      .run(run.id, run.projectId, run.baseUrl, run.target, run.sessionId, run.startedAt)
    pruneToLast(this.db, 'api_runs', input.projectId, API_HISTORY)
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
  target: string | null
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
    target: row.target === 'qa' ? 'qa' : 'local',
    launched: row.launched === 1,
    calls: parseJson<ApiCall[]>(row.calls) ?? [],
  }
}

export class DiagramRequestsRepo {
  constructor(private db: AppDatabase) {}

  record(projectId: string, file: string, description: string, sessionId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO diagram_requests (projectId, file, sessionId, description, createdAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (projectId, file) DO UPDATE SET
           sessionId = excluded.sessionId,
           description = excluded.description,
           createdAt = excluded.createdAt`,
      )
      .run(projectId, file, sessionId, description, nowIso())
  }

  latestSessionFor(projectId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT sessionId FROM diagram_requests WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1',
      )
      .get(projectId) as { sessionId: string | null } | undefined
    return row?.sessionId ?? null
  }

  forProject(
    projectId: string,
  ): Map<string, { sessionId: string | null; description: string; plan: DiagramPlan | null }> {
    const rows = this.db
      .prepare('SELECT file, sessionId, description, plan FROM diagram_requests WHERE projectId = ?')
      .all(projectId) as {
      file: string
      sessionId: string | null
      description: string
      plan: string | null
    }[]
    return new Map(
      rows.map((r) => [
        r.file,
        {
          sessionId: r.sessionId,
          description: r.description,
          plan: r.plan ? ((JSON.parse(r.plan) as DiagramPlan) ?? null) : null,
        },
      ]),
    )
  }

  latestFileFor(projectId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT file FROM diagram_requests WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1',
      )
      .get(projectId) as { file: string } | undefined
    return row?.file ?? null
  }

  notePlan(projectId: string, file: string, plan: DiagramPlan): void {
    this.db
      .prepare('UPDATE diagram_requests SET plan = ? WHERE projectId = ? AND file = ?')
      .run(JSON.stringify(plan), projectId, file)
  }
}

class CustomSkillsRepo {
  constructor(private db: AppDatabase) {}

  list(): CustomSkill[] {
    return (
      this.db
        .prepare('SELECT * FROM custom_skills ORDER BY name')
        .all() as (Omit<CustomSkill, 'enabled'> & { enabled: number })[]
    ).map((row) => ({ ...row, enabled: row.enabled === 1 }))
  }

  names(): Set<string> {
    return new Set(this.list().map((skill) => skill.name))
  }

  insertMany(skills: readonly CustomSkill[]): void {
    const insert = this.db.prepare(
      `INSERT INTO custom_skills (name, description, sourceUrl, sourcePath, enabled, fileCount, importedAt)
       VALUES (@name, @description, @sourceUrl, @sourcePath, @enabled, @fileCount, @importedAt)`,
    )
    for (const skill of skills) {
      insert.run({
        name: skill.name,
        description: skill.description,
        sourceUrl: skill.sourceUrl,
        sourcePath: skill.sourcePath,
        enabled: skill.enabled ? 1 : 0,
        fileCount: skill.fileCount,
        importedAt: skill.importedAt,
      })
    }
  }

  setEnabled(name: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE custom_skills SET enabled = ? WHERE name = ?')
      .run(enabled ? 1 : 0, name)
  }

  remove(name: string): void {
    this.db.prepare('DELETE FROM custom_skills WHERE name = ?').run(name)
  }

  byName(name: string): CustomSkill | undefined {
    return this.list().find((skill) => skill.name === name)
  }
}

export interface Repositories {
  projects: ProjectsRepo
  sessions: SessionsRepo
  events: EventsRepo
  requests: RequestsRepo
  standingRules: StandingRulesRepo
  rulePrefs: RulePrefsRepo
  settings: SettingsRepo
  drafts: DraftsRepo
  commandHistory: CommandHistoryRepo
  projectCommands: ProjectCommandsRepo
  taskQueue: TaskQueueRepo
  mcpScans: McpScansRepo
  evals: EvalsRepo
  verifyRuns: VerifyRunsRepo
  securityRuns: SecurityRunsRepo
  flowRuns: FlowRunsRepo
  flowItems: FlowItemsRepo
  flowLessons: FlowLessonsRepo
  apiRuns: ApiRunsRepo
  diagramRequests: DiagramRequestsRepo
  customSkills: CustomSkillsRepo
}

export function createRepositories(db: AppDatabase): Repositories {
  return {
    projects: new ProjectsRepo(db),
    sessions: new SessionsRepo(db),
    events: new EventsRepo(db),
    requests: new RequestsRepo(db),
    standingRules: new StandingRulesRepo(db),
    rulePrefs: new RulePrefsRepo(db),
    settings: new SettingsRepo(db),
    drafts: new DraftsRepo(db),
    commandHistory: new CommandHistoryRepo(db),
    projectCommands: new ProjectCommandsRepo(db),
    taskQueue: new TaskQueueRepo(db),
    mcpScans: new McpScansRepo(db),
    evals: new EvalsRepo(db),
    verifyRuns: new VerifyRunsRepo(db),
    securityRuns: new SecurityRunsRepo(db),
    flowRuns: new FlowRunsRepo(db),
    flowItems: new FlowItemsRepo(db),
    flowLessons: new FlowLessonsRepo(db),
    apiRuns: new ApiRunsRepo(db),
    diagramRequests: new DiagramRequestsRepo(db),
    customSkills: new CustomSkillsRepo(db),
  }
}
