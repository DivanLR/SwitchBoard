// Typed repositories over the SQLite schema (data-model.md). All JSON columns
// are serialised here so the rest of the main process works with domain types.
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
  SuiteResult,
  SessionEndReason,
  SessionEvent,
  SessionMode,
  SessionStatus,
  RiskLevel,
  Settings,
  VerifyReport,
  VerifyRun,
} from '@shared/domain'
import { DEFAULT_SESSION_MODE, DEFAULT_SETTINGS, emptyVerifyReport } from '@shared/domain'
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
  /** NOT NULL with a DEFAULT since migration 022, so this is never null. */
  defaultSessionMode: SessionMode
  /** SQLite has no boolean type: 0/1, NOT NULL since migration 026. */
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
  /** How the session STARTED, never where it is now — see Session.planMode. */
  planMode: number | null
  /** The developer's own name for this session; null until they type one. */
  label: string | null
  /** Which section opened this session, kept so the fact survives it ending
   *  (migration 028). Null for an ordinary conversation. */
  sectionKind: SectionKind | null
  /** The derived name, frozen on first resolution (migration 029). Null for a
   *  session whose name has never resolved — a plain conversation, or one whose
   *  branch has not been read yet. */
  derivedName: string | null
}

/** SessionRow is the raw shape; Session wants real booleans for the flags. */
function toSession(row: SessionRow): Session
function toSession(row: SessionRow | undefined): Session | undefined
function toSession(row: SessionRow | undefined): Session | undefined {
  if (!row) return undefined
  // inPlanMode is deliberately absent: it is the live mode, which no row holds.
  return {
    ...row,
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

export class ProjectsRepo {
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
      // Not a column in the INSERT below: migration 026's DEFAULT 0 supplies it,
      // and one source for the default beats two that can disagree.
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

  /** Takes effect on the project's next session; the SDK mode is fixed at spawn. */
  setSessionMode(id: string, mode: SessionMode): void {
    this.db.prepare('UPDATE projects SET defaultSessionMode = ? WHERE id = ?').run(mode, id)
  }

  /** Same rule as the mode above: read at spawn, so a live session keeps whatever
   *  it started in and this applies from the next one. */
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

  /** Repoints a project at another folder (discovery.repointProject, which does
   *  the validating: path is UNIQUE, so a clashing folder throws here). */
  setPath(id: string, path: string): void {
    this.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path, id)
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
        `INSERT INTO sessions (id, projectId, sdkSessionId, status, statusDetail, branch, diffAdds, diffDels, usageUtilization, usageResetsAt, usageLimitType, startedAt, endedAt, endReason, bypassPermissions, planMode)
         VALUES (@id, @projectId, @sdkSessionId, @status, @statusDetail, @branch, @diffAdds, @diffDels, @usageUtilization, @usageResetsAt, @usageLimitType, @startedAt, @endedAt, @endReason, @bypassPermissions, @planMode)`,
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
        // The start value only. A mid-session switch changes inPlanMode, which is
        // in-memory and never written, so this stays true of how it began.
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
  /**
   * Close every session a previous run left open (FR-022).
   *
   * `note` is written only where the row has none, and it exists because these
   * rows were the single largest source of the developer's own complaint that
   * "sessions just close with no message". Every row this touches belongs to a
   * session that was ALIVE when the application went away without closing it: a
   * crash, a kill, a power loss, or a graceful quit whose grace period expired.
   * The session did not close; Switchboard did. Saying nothing made those
   * indistinguishable from a session the developer had ended on purpose.
   *
   * Guarded with COALESCE rather than overwriting: a session that recorded its own
   * diagnosis before dying has the more useful answer of the two.
   */
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

export class EventsRepo {
  constructor(private db: AppDatabase) {}

  /**
   * Events awaiting their next flush to disk. Buffered rather than written on
   * the spot: at streaming rates (SessionManager's sink calls `insert` once per
   * emitted chunk) an auto-committed INSERT is its own WAL frame plus its own
   * WAL-index update, and db.ts's synchronous=NORMAL comment already names that
   * per-event cost. Grouping one burst into a single transaction is the real,
   * well-understood win at these rates.
   *
   * Never reordered — only pushed to and drained whole. Events are append-only
   * and ordered by per-session `seq` alone (never by timestamp), so the order
   * they land in this array IS the order they must reach the table in.
   */
  private pending: SessionEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null

  // Comparable to the renderer's own ~33ms batch-repaint interval, not copied
  // from it — short enough that "buffered" never reads as "delayed" to a human
  // watching the stream, long enough to actually coalesce a burst of chunks.
  private static readonly FLUSH_INTERVAL_MS = 33

  insert(event: SessionEvent): void {
    this.pending.push(event)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), EventsRepo.FLUSH_INTERVAL_MS)
      // A pending flush must never be a reason the process stays alive. The
      // guaranteed delivery path on a clean quit is the explicit flush() call
      // main/index.ts makes before db.close(), not this timer.
      this.flushTimer.unref()
    }
  }

  /**
   * Writes every buffered event in ONE transaction and empties the buffer.
   *
   * Called by the timer above, and — this is the part the whole design rests
   * on — at the top of every OTHER method below that reads or mutates the
   * events table. A buffered event a reader cannot yet see would be a
   * correctness bug wearing a performance win's costume, so nothing on this
   * repo may touch the table without flushing first. Idempotent: draining an
   * empty buffer is a no-op, so paying for the call on every path costs
   * nothing once a burst has already landed.
   *
   * What a crash between flushes costs: at most one FLUSH_INTERVAL_MS window
   * of events for whichever session was mid-burst. db.ts already spends this
   * exact budget once, calling this store's events "a transcript, not money"
   * to justify synchronous=NORMAL; batching the insert on top does not open a
   * second one.
   *
   * Public because retention.ts deletes from this table directly (raw SQL, own
   * file — see the reasoning below) and main/index.ts's composition root calls
   * this immediately before handing it the database, and again before
   * db.close() in the before-quit handler, so neither a scheduled sweep nor a
   * quit can observe or lose a buffered row.
   *
   * Retention safety, checked against store/retention.ts rather than assumed:
   * its DELETE only ever targets sessions OUTSIDE the most recent
   * SESSIONS_PER_PROJECT (2) per project — `sessionId NOT IN (... rn <= ?)`.
   * A buffered event can only belong to the session currently emitting it,
   * which is always that project's most recent (rn = 1) and therefore always
   * inside the keep-set. So even a retention pass that ran on a table with
   * unflushed rows could never delete one of them out from under this buffer —
   * the rows it deletes were never candidates for buffering by the time it
   * looks. The index.ts flush before each run exists anyway, because "could
   * never" should not be the only thing standing between a sweep and a live
   * buffer.
   */
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

  /**
   * Contract-sanctioned in-place update (contracts/session-events.md): marker
   * and question status changes, tool result pairing, and final partial text.
   */
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

  /** Paged history, newest last (ipc-contract.md `sessions.events`). */
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

/**
 * What the developer changed about the risk and noise rules.
 *
 * Holds the DIFFERENCE from the shipped defaults, never a copy of them: an empty
 * table means shipped behaviour, and editing a default in code reaches every
 * install that has not overridden that exact rule. main/inbox/rule-prefs.ts
 * explains why the obvious alternative failed here.
 */
export class RulePrefsRepo {
  constructor(private db: AppDatabase) {}

  /**
   * Columns listed rather than `SELECT *`: `createdAt` is kept for diagnostics but
   * is not part of a rule's meaning, and this list crosses IPC to the editor.
   */
  list(): RulePref[] {
    const rows = this.db
      .prepare('SELECT id, kind, disabled, risk, body, position FROM rule_prefs')
      .all() as (Omit<RulePref, 'disabled'> & { disabled: number })[]
    return rows.map((r) => ({ ...r, disabled: r.disabled === 1 }))
  }

  /**
   * Switches a rule off or back on.
   *
   * Upsert rather than insert-or-update at the call site: a shipped rule has no row
   * until the moment it is first touched, which is what keeps "untouched" and
   * "explicitly left alone" the same state.
   */
  setDisabled(id: string, kind: RuleKind, disabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO rule_prefs (id, kind, disabled, risk, body, position, createdAt)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?)
         ON CONFLICT (id, kind) DO UPDATE SET disabled = excluded.disabled`,
      )
      .run(id, kind, disabled ? 1 : 0, nowIso())
  }

  /** The risk level chosen instead of the shipped one; null restores the default. */
  setRisk(id: string, risk: RiskLevel | null): void {
    this.db
      .prepare(
        `INSERT INTO rule_prefs (id, kind, disabled, risk, body, position, createdAt)
         VALUES (?, 'risk', 0, ?, NULL, NULL, ?)
         ON CONFLICT (id, kind) DO UPDATE SET risk = excluded.risk`,
      )
      .run(id, risk, nowIso())
  }

  /** A rule the developer wrote. `body` is the whole rule as JSON. */
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

  /**
   * Forgets a row.
   *
   * For a rule the developer wrote this deletes it. For a shipped rule it clears
   * the override, which restores the default — the same operation, because a
   * missing row IS the default.
   */
  remove(id: string, kind: RuleKind): void {
    this.db.prepare('DELETE FROM rule_prefs WHERE id = ? AND kind = ?').run(id, kind)
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

  /**
   * Reword a task that has not run yet. Emptying it is a delete, because a queued
   * task with nothing in it would be sent to the session as an empty prompt.
   */
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
 * Keeps only the newest `keep` rows for one project, dropping the rest.
 *
 * Shared by verify_runs and api_runs, which held byte-identical copies of this
 * statement. `table` is a closed union rather than a string, so the interpolation
 * cannot become an injection point: only these two names type-check.
 *
 * Ties on `startedAt` (several runs inside the same millisecond) break on insert
 * order via `rowid` — `id` is a random UUID, so ordering by it would drop an
 * arbitrary run instead of the oldest.
 */
function pruneToLast(
  db: AppDatabase,
  table: 'verify_runs' | 'api_runs',
  projectId: string,
  keep: number,
): void {
  db.prepare(
    `DELETE FROM ${table} WHERE projectId = ? AND id NOT IN (
       SELECT id FROM ${table} WHERE projectId = ? ORDER BY startedAt DESC, rowid DESC LIMIT ?
     )`,
  ).run(projectId, projectId, keep)
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

  /**
   * The same repair, for a run that went stale while the app stayed up.
   *
   * `reconcileRunning` above only ever runs at launch, so the row it describes
   * sat there reading Running — with the Run button disabled behind it — until
   * the developer restarted the app. This is the sweep that closes it in place.
   * Returns the projects affected so the caller can push; the launch-time version
   * never needed that, because nothing is subscribed yet when it runs.
   */
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

  /**
   * One suite's outcome, recorded while the run is still going, so the picker can
   * mark each suite as it lands instead of staying blank until the whole run ends.
   *
   * Guarded on `status = 'running'` for the same reason `finish` writes a verdict
   * once: a progress line that arrives after the run settled must not reopen a
   * finished report or contradict the settled figures. First writer wins per suite
   * id — a suite states its result once, and a restatement later in the same turn
   * is narration, not a second run.
   */
  noteSuite(id: string, result: SuiteResult): void {
    const run = this.byId(id)
    if (!run || run.status !== 'running') return
    const report = run.report ?? emptyVerifyReport()
    if (report.suites.some((s) => s.id === result.id)) return
    report.suites = [...report.suites, result]
    this.db.prepare('UPDATE verify_runs SET report = ? WHERE id = ?').run(JSON.stringify(report), id)
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

  /** The in-flight sweep, matching VerifyRunsRepo.reconcileStale — see there for
   *  why a launch-only repair was not enough. */
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
    // Anything but the QA word is a local run: a row written before the column
    // existed went against the developer's own API, and an unreadable value must
    // never grant a run the treatment a deployed environment gets.
    target: row.target === 'qa' ? 'qa' : 'local',
    launched: row.launched === 1,
    calls: parseJson<ApiCall[]>(row.calls) ?? [],
  }
}

/**
 * What a diagram file cannot say about itself: who asked, and in what words.
 *
 * Deliberately not a store of diagrams. The files in docs/diagrams ARE the
 * diagrams, and they are committed with the code, so a row here is metadata that
 * may outlive its file (deleted from the repo) or never have one (the session
 * failed). Both cases are ordinary and neither is cleaned up: the list is built
 * from the folder, and a row with no file simply never joins.
 */
export class DiagramRequestsRepo {
  constructor(private db: AppDatabase) {}

  /** Recorded BEFORE the session is asked, so a crash mid-generation still
   *  leaves the reason the file appeared. Re-requesting the same name overwrites,
   *  because that is a regeneration of the same diagram. */
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

  /** The session the newest diagram was asked of, so a second request rejoins it
   *  rather than starting another. Null when this project has asked for none. */
  latestSessionFor(projectId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT sessionId FROM diagram_requests WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1',
      )
      .get(projectId) as { sessionId: string | null } | undefined
    return row?.sessionId ?? null
  }

  /** Keyed by file name, for joining onto whatever the folder actually holds. */
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
          // Stored JSON is only ever written by notePlan, but a row hand-edited or
          // written by an older build must not take the section down with it.
          plan: r.plan ? ((JSON.parse(r.plan) as DiagramPlan) ?? null) : null,
        },
      ]),
    )
  }

  /** The newest requested file for a project: the one currently being drawn. */
  latestFileFor(projectId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT file FROM diagram_requests WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1',
      )
      .get(projectId) as { file: string } | undefined
    return row?.file ?? null
  }

  /**
   * The plan the session stated before drawing. Matched on the file name the app
   * chose, which is the only handle the two sides share.
   *
   * Recorded against a row that already exists — `record` runs before the session
   * is asked — so a plan for an unknown file is dropped rather than inserted: it
   * would be a row with no request behind it.
   */
  notePlan(projectId: string, file: string, plan: DiagramPlan): void {
    this.db
      .prepare('UPDATE diagram_requests SET plan = ? WHERE projectId = ? AND file = ?')
      .run(JSON.stringify(plan), projectId, file)
  }
}

/**
 * The imported-skills registry. Rows only: the skill's files live on disk (see
 * main/skills/install.ts for why they are not in here).
 */
export class CustomSkillsRepo {
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

  /** Insert the results of one import. A name that already exists is rejected by
   *  the primary key rather than overwritten, which is the point of keying on it. */
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
    apiRuns: new ApiRunsRepo(db),
    diagramRequests: new DiagramRequestsRepo(db),
    customSkills: new CustomSkillsRepo(db),
  }
}
