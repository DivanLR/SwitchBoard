// Permission broker (R3, FR-007/007a/009/012): implements the Agent SDK
// canUseTool flow for every session. Standing rules short-circuit as
// rule_approved history entries; everything else becomes a pending inbox item
// whose promise resolves when the developer decides. Plan approvals are inbox
// items shaped by FR-007a; AskUserQuestion routes to the stream, never the
// inbox (FR-020).
import { win32 } from 'node:path'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  isDangerousCommand,
  type PermissionRequest,
  type PermissionRule,
  type QuestionOption,
} from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import { classifyRisk } from './risk-rules'
import { deriveMatcher, evaluateStandingRules, isPathWithinProject, pathOf } from './standing-rules'

/** File tools auto-approved without a prompt when their target is inside the
 *  session's own project folder. */
const CWD_AUTO_APPROVE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit'])

export class BrokerError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'CONFIRM_REQUIRED' | 'RULE_NOT_ALLOWED',
    message: string,
  ) {
    super(message)
  }
}

interface PendingEntry {
  request: PermissionRequest
  sessionId: string
  markerEventId: string
  markerKind: 'permission_marker' | 'plan_marker'
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

interface PendingQuestion {
  eventId: string
  questionIndex: number
  answered: boolean
}

interface QuestionGroup {
  sessionId: string
  input: Record<string, unknown>
  questions: PendingQuestion[]
  answers: (string | null)[]
  resolve: (result: PermissionResult) => void
  settled: boolean
}

export interface BrokerCallbacks {
  onInboxChanged: (push: InboxChangedPush) => void
  onCountersChanged: () => void
  /** Desktop notification hook; fired when an item starts blocking (FR-013a). */
  onNeedsYou: (context: {
    projectId: string
    sessionId: string
    kind: 'permission' | 'plan' | 'question'
    requestId?: string
    eventId?: string
    title: string
  }) => void
}

interface CanUseToolContext {
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  options: {
    signal: AbortSignal
    title?: string
    description?: string
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * Short plain-language explanations for common shell commands (design ask:
 * "cd means accessing a specific folder"). First match wins.
 */
const COMMAND_EXPLANATIONS: [RegExp, string][] = [
  [/^cd(\s|$)/, 'Accesses a specific folder.'],
  [/^(ls|dir)\b/, 'Lists the files in a folder.'],
  [/^(cat|type|head|tail)\b/, 'Reads a file and shows its contents.'],
  [/^(rm|del|rd|rmdir|remove-item)\b/i, 'Deletes files or folders.'],
  [/^(mkdir|md)\b/, 'Creates a folder.'],
  [/^(cp|copy)\b/, 'Copies files.'],
  [/^(mv|move|ren)\b/, 'Moves or renames files.'],
  [/^git (status|log|diff|show|branch)\b/, 'Checks the repository state — read-only.'],
  [/^git (add|commit)\b/, 'Saves changes into the repository history.'],
  [/^git push\b/, 'Uploads commits to the remote repository.'],
  [/^git (pull|fetch)\b/, 'Downloads changes from the remote repository.'],
  [/^(npm|pnpm|yarn) i(nstall)?\b/, 'Installs project dependencies.'],
  [/^(npm|pnpm|yarn) (run|test|ci)\b/, 'Runs a project script or its tests.'],
  [/^(curl|wget|invoke-webrequest|iwr)\b/i, 'Talks to the internet — downloads or sends data.'],
  [/^(grep|rg|findstr|select-string)\b/i, 'Searches for text in files.'],
  [/^echo\b/, 'Prints text.'],
  [/^(node|npx|tsx|python|py|dotnet)\b/, 'Runs a program or script.'],
]

function explainCommand(command: string): string | null {
  const trimmed = command.trim()
  for (const [pattern, explanation] of COMMAND_EXPLANATIONS) {
    if (pattern.test(trimmed)) return explanation
  }
  return null
}

/**
 * Produces a clear, human-first title, a plain-language explanation of what the
 * action would do, and the underlying detail (exact command / file / input).
 * Titles are full (never truncated) — the inbox card wraps them.
 */
function describeTool(toolName: string, input: Record<string, unknown>): {
  title: string
  explanation: string
  detail: string
} {
  const command = str(input.command)
  const path = pathOf(input)
  const url = str(input.url)

  if (toolName === 'Bash' && command) {
    return {
      title: `Run a command: ${command}`,
      explanation:
        explainCommand(command) ?? 'Claude wants to run this shell command in the project folder.',
      detail: command,
    }
  }
  if (toolName === 'Write' && path) {
    return {
      title: `Create or overwrite ${win32.basename(path)}`,
      explanation: `Claude wants to write the file ${path}.`,
      detail: str(input.content) ? `${path}\n\n${String(input.content).slice(0, 4000)}` : path,
    }
  }
  if ((toolName === 'Edit' || toolName === 'NotebookEdit') && path) {
    const oldStr = str(input.old_string)
    const newStr = str(input.new_string)
    return {
      title: `Edit ${win32.basename(path)}`,
      explanation: `Claude wants to change the file ${path}.`,
      detail:
        oldStr && newStr
          ? `${path}\n\n- ${oldStr.slice(0, 1500)}\n+ ${newStr.slice(0, 1500)}`
          : path,
    }
  }
  if (toolName === 'Read' && path) {
    return {
      title: `Read ${win32.basename(path)}`,
      explanation: `Claude wants to read the file ${path}.`,
      detail: path,
    }
  }
  if ((toolName === 'WebFetch' || toolName === 'WebSearch') && (url || str(input.query))) {
    const target = url ?? str(input.query) ?? ''
    return {
      title: toolName === 'WebFetch' ? `Fetch a web page` : `Search the web`,
      explanation: `Claude wants to reach the internet: ${target}`,
      detail: target,
    }
  }
  return {
    title: `Use the ${toolName} tool`,
    explanation: `Claude wants to use the ${toolName} tool.`,
    detail: JSON.stringify(input, null, 2),
  }
}

export class PermissionBroker {
  private pending = new Map<string, PendingEntry>()
  /** question event id -> its group */
  private questions = new Map<string, QuestionGroup>()

  constructor(
    private repos: Repositories,
    private manager: SessionManager,
    private callbacks: BrokerCallbacks,
  ) {}

  /** The PermissionGate bound into every hosted session. */
  async handle(context: CanUseToolContext): Promise<PermissionResult> {
    if (context.toolName === 'AskUserQuestion') {
      return this.handleQuestion(context)
    }
    if (context.toolName === 'ExitPlanMode') {
      return this.handlePlanApproval(context)
    }
    return this.handleToolPermission(context)
  }

  private async handleToolPermission(context: CanUseToolContext): Promise<PermissionResult> {
    const session = this.repos.sessions.byId(context.sessionId)
    if (!session) return { behavior: 'deny', message: 'Session is not registered' }
    const projectId = session.projectId
    const project = this.repos.projects.byId(projectId)

    // A standing rule or an enabled risk-level auto-approval (Allowed list tab)
    // short-circuits, recorded as rule_approved (FR-009b); otherwise enqueue.
    const standing = evaluateStandingRules(
      this.repos.standingRules.listForProject(projectId),
      context.toolName,
      context.input,
    )
    // File tools targeting the session's OWN folder need no prompt — the session
    // already owns read/write inside its working directory.
    const withinOwnFolder =
      CWD_AUTO_APPROVE_TOOLS.has(context.toolName) &&
      project !== undefined &&
      isPathWithinProject(project.path, context.input)
    const described = describeTool(context.toolName, context.input)
    const { risk } = classifyRisk(this.repos.riskRules.list(), context.toolName, context.input)
    const settings = this.repos.settings.get()
    const autoApproved =
      Boolean(standing) ||
      withinOwnFolder ||
      (risk === 'low' && settings.autoApproveLow) ||
      (risk === 'medium' && settings.autoApproveMedium)

    const request: PermissionRequest = {
      id: newId(),
      sessionId: context.sessionId,
      projectId,
      type: 'tool_permission',
      toolName: context.toolName,
      title: context.options.title ?? described.title,
      explanation: context.options.description ?? described.explanation,
      detail: described.detail,
      risk,
      status: autoApproved ? 'rule_approved' : 'pending',
      createdAt: nowIso(),
      resolvedAt: autoApproved ? nowIso() : null,
      deliveryFailed: false,
    }
    if (!autoApproved) return this.enqueue(context, request, 'permission_marker')

    this.repos.requests.insert(request)
    this.appendMarker(context.sessionId, 'permission_marker', request)
    this.callbacks.onInboxChanged({ resolved: { requestId: request.id, status: 'rule_approved' } })
    this.callbacks.onCountersChanged()
    return { behavior: 'allow', updatedInput: context.input }
  }

  private async handlePlanApproval(context: CanUseToolContext): Promise<PermissionResult> {
    const session = this.repos.sessions.byId(context.sessionId)
    if (!session) return { behavior: 'deny', message: 'Session is not registered' }
    const planText =
      typeof context.input.plan === 'string' && context.input.plan.length > 0
        ? context.input.plan
        : (context.options.description ?? 'The session requests approval of its plan.')
    const request: PermissionRequest = {
      id: newId(),
      sessionId: context.sessionId,
      projectId: session.projectId,
      type: 'plan_approval',
      toolName: null,
      title: context.options.title ?? 'Plan approval',
      explanation:
        'The session finished planning and asks for approval before making changes (plan badge; single-click approval).',
      detail: planText,
      // Plan approvals carry a "plan" badge in the UI instead of a risk level;
      // stored low so the high-risk confirm step never applies (FR-007a).
      risk: 'low',
      status: 'pending',
      createdAt: nowIso(),
      resolvedAt: null,
      deliveryFailed: false,
    }
    return this.enqueue(context, request, 'plan_marker')
  }

  private enqueue(
    context: CanUseToolContext,
    request: PermissionRequest,
    markerKind: 'permission_marker' | 'plan_marker',
  ): Promise<PermissionResult> {
    this.repos.requests.insert(request)
    const markerEventId = this.appendMarker(context.sessionId, markerKind, request)
    this.manager.attentionRaised(context.sessionId)
    this.callbacks.onInboxChanged({ added: request })
    this.callbacks.onCountersChanged()
    this.callbacks.onNeedsYou({
      projectId: request.projectId,
      sessionId: context.sessionId,
      kind: request.type === 'plan_approval' ? 'plan' : 'permission',
      requestId: request.id,
      title: request.title,
    })

    return new Promise<PermissionResult>((resolve) => {
      const entry: PendingEntry = {
        request,
        sessionId: context.sessionId,
        markerEventId,
        markerKind,
        input: context.input,
        resolve,
      }
      this.pending.set(request.id, entry)
      context.options.signal.addEventListener(
        'abort',
        () => this.expireEntry(request.id, 'The session moved on before a decision was made'),
        { once: true },
      )
    })
  }

  private appendMarker(
    sessionId: string,
    kind: 'permission_marker' | 'plan_marker',
    request: PermissionRequest,
  ): string {
    try {
      const sink = this.manager.sinkFor(sessionId)
      if (kind === 'permission_marker') {
        return sink.append('permission_marker', {
          requestId: request.id,
          title: request.title,
          risk: request.risk,
          status: request.status,
          toolName: request.toolName,
        }).id
      }
      return sink.append('plan_marker', {
        requestId: request.id,
        title: request.title,
        status: request.status,
      }).id
    } catch {
      return ''
    }
  }

  private updateMarker(entry: PendingEntry, status: PermissionRequest['status']): void {
    if (!entry.markerEventId) return
    try {
      const sink = this.manager.sinkFor(entry.sessionId)
      if (entry.markerKind === 'permission_marker') {
        sink.update(
          entry.markerEventId,
          {
            requestId: entry.request.id,
            title: entry.request.title,
            risk: entry.request.risk,
            status,
          },
          { persist: true },
        )
      } else {
        sink.update(
          entry.markerEventId,
          { requestId: entry.request.id, title: entry.request.title, status },
          { persist: true },
        )
      }
    } catch {
      // Session already gone; the persisted row was updated by the repo call.
    }
  }

  /** Developer decision from the inbox (FR-009, FR-010). */
  decide(
    requestId: string,
    decision: 'approve' | 'deny',
    confirmHighRisk = false,
  ): { delivered: boolean } {
    const request = this.repos.requests.byId(requestId)
    if (!request) throw new BrokerError('NOT_FOUND', 'Permission request not found')
    if (request.status !== 'pending') {
      throw new BrokerError('NOT_FOUND', 'The request has already been decided')
    }
    if (
      decision === 'approve' &&
      request.risk === 'high' &&
      request.type === 'tool_permission' &&
      !confirmHighRisk
    ) {
      throw new BrokerError('CONFIRM_REQUIRED', 'High-risk approval requires explicit confirmation')
    }

    const entry = this.pending.get(requestId)
    if (!entry) {
      // Undeliverable: the originating session is gone (SC-004).
      this.repos.requests.resolve(requestId, 'expired', true)
      this.callbacks.onInboxChanged({
        resolved: { requestId, status: 'expired', deliveryFailed: true },
      })
      this.callbacks.onCountersChanged()
      return { delivered: false }
    }

    const status = decision === 'approve' ? 'approved' : 'denied'
    this.settleEntry(entry, status)
    if (decision === 'approve') {
      entry.resolve({ behavior: 'allow', updatedInput: entry.input })
    } else {
      entry.resolve({ behavior: 'deny', message: 'Denied by the developer in Switchboard' })
    }
    return { delivered: true }
  }

  /**
   * Saves a standing rule from a DECIDED Bash request (design: right-click a
   * command in history → always allow). The matcher is DERIVED server-side from
   * the recorded command (`detail` holds it verbatim for Bash), never taken
   * from the caller — a renderer must not be able to widen a rule beyond the
   * action shown. Any approved command is eligible EXCEPT the destructive set
   * (`isDangerousCommand`); the risk classifier's fail-safe-to-high must not bar
   * ordinary vetted commands. An overlapping active rule is reused instead of
   * stacking a duplicate.
   */
  alwaysAllow(requestId: string) {
    const request = this.repos.requests.byId(requestId)
    if (!request) throw new BrokerError('NOT_FOUND', 'Permission request not found')
    if (request.type === 'plan_approval') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Plan approvals never create standing rules')
    }
    if (request.status === 'pending') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Rules are created from decided history entries')
    }
    if (request.toolName !== 'Bash') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Only shell commands can be always-allowed from history')
    }
    if (isDangerousCommand(request.detail)) {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Destructive commands can never be auto-approved')
    }
    return this.insertRuleForBashCommand(request)
  }

  /**
   * From a PENDING inbox item ("Always allow …"): inserts the standing rule then
   * approves the request via the normal `decide()` path (marker, push,
   * resolution — no duplicated settlement). Both calls are synchronous, so
   * rule-then-approve is atomic within the event loop.
   *
   * Two shapes:
   * - Bash: a flag-aware command-prefix rule. Refused for high risk (one click
   *   must not both widen future auto-approval AND skip the high-risk confirm a
   *   plain Approve requires) and for the destructive set.
   * - MCP tools (`mcp__…`): a `tool_only` rule allow-listing every future call
   *   to that exact tool for the project. These are high only by the risk
   *   classifier's fail-safe (no rule matches an MCP tool), so the gate is the
   *   developer's explicit confirm (`confirmHighRisk`), not a command check —
   *   there is no command to vet. ponytail: per-project like every standing
   *   rule; a narrower per-session scope would need a whole new mechanism.
   */
  approveAlways(
    requestId: string,
    confirmHighRisk = false,
  ): { delivered: boolean; rule: PermissionRule } {
    const request = this.repos.requests.byId(requestId)
    if (!request) throw new BrokerError('NOT_FOUND', 'Permission request not found')
    if (request.status !== 'pending') {
      throw new BrokerError('NOT_FOUND', 'The request has already been decided')
    }
    if (request.type !== 'tool_permission' || !request.toolName) {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Only pending tool permissions can be always-allowed')
    }

    if (request.toolName.startsWith('mcp__')) {
      if (request.risk === 'high' && !confirmHighRisk) {
        throw new BrokerError('CONFIRM_REQUIRED', 'Allowing every call to this tool requires confirmation')
      }
      const { rule } = this.insertRuleForMcpTool(request)
      // Already confirmed (or not high) — bypass decide()'s own high-risk gate.
      const { delivered } = this.decide(requestId, 'approve', true)
      return { delivered, rule }
    }

    if (request.toolName !== 'Bash') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Only shell or MCP tools can be always-allowed')
    }
    if (request.risk === 'high') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'High-risk commands require individual approval')
    }
    if (isDangerousCommand(request.detail)) {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Destructive commands can never be auto-approved')
    }
    const { rule } = this.insertRuleForBashCommand(request)
    const { delivered } = this.decide(requestId, 'approve')
    return { delivered, rule }
  }

  /** Dedupe-insert of a `tool_only` rule allow-listing an MCP tool by name. */
  private insertRuleForMcpTool(request: PermissionRequest): { rule: PermissionRule } {
    const toolName = request.toolName as string
    const existing = this.repos.standingRules
      .listForProject(request.projectId)
      .find((r) => r.toolName === toolName && r.matcher.kind === 'tool_only')
    if (existing) return { rule: existing }
    const rule = this.repos.standingRules.insert({
      projectId: request.projectId,
      toolName,
      matcher: { kind: 'tool_only' },
      createdFromRequestId: request.id,
    })
    return { rule }
  }

  /** Shared matcher-derivation + dedupe-insert for `alwaysAllow`/`approveAlways`. */
  private insertRuleForBashCommand(request: PermissionRequest): { rule: PermissionRule } {
    const matcher = deriveMatcher(request.detail)
    const base = matcher.value ?? ''
    if (base.length === 0) {
      throw new BrokerError('RULE_NOT_ALLOWED', 'The request has no command to allow')
    }
    const existing = this.repos.standingRules
      .listForProject(request.projectId)
      .find(
        (r) =>
          r.toolName === 'Bash' &&
          r.matcher.kind === 'command_prefix' &&
          (r.matcher.value ?? '').length > 0 &&
          ((r.matcher.value ?? '').startsWith(base) || base.startsWith(r.matcher.value ?? '')),
      )
    if (existing) return { rule: existing }
    const rule = this.repos.standingRules.insert({
      projectId: request.projectId,
      toolName: 'Bash',
      matcher,
      createdFromRequestId: request.id,
    })
    return { rule }
  }

  /**
   * Approves every pending item in one project group (FR-011). High-risk tool
   * permissions are skipped unless `includeHighRisk` is set — the UI passes it
   * only after an explicit "are you sure" confirm, so bulk approval never
   * silently clears a destructive action.
   */
  approveAllForProject(
    projectId: string,
    includeHighRisk = false,
  ): { approved: number; skippedHighRisk: number } {
    const pending = this.repos.requests.pendingForProject(projectId)
    let approved = 0
    let skippedHighRisk = 0
    for (const request of pending) {
      const isHighRisk = request.risk === 'high' && request.type === 'tool_permission'
      if (isHighRisk && !includeHighRisk) {
        skippedHighRisk += 1
        continue
      }
      // decide() re-checks the high-risk gate, so pass the confirm through.
      this.decide(request.id, 'approve', isHighRisk)
      approved += 1
    }
    return { approved, skippedHighRisk }
  }

  /** Session death or app exit: cancel its pending items out of the inbox. */
  expireForSession(sessionId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.sessionId !== sessionId) continue
      this.expireEntry(requestId, 'The session ended before a decision was made')
    }
    for (const [eventId, group] of [...this.questions]) {
      if (group.sessionId !== sessionId) continue
      this.questions.delete(eventId)
      if (!group.settled) {
        group.settled = true
        group.resolve({ behavior: 'deny', message: 'The session ended before the question was answered' })
      }
    }
  }

  private expireEntry(requestId: string, reason: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.settleEntry(entry, 'expired')
    entry.resolve({ behavior: 'deny', message: reason })
  }

  private settleEntry(entry: PendingEntry, status: 'approved' | 'denied' | 'expired'): void {
    this.pending.delete(entry.request.id)
    this.repos.requests.resolve(entry.request.id, status)
    this.updateMarker(entry, status)
    this.manager.attentionCleared(entry.sessionId)
    this.callbacks.onInboxChanged({ resolved: { requestId: entry.request.id, status } })
    this.callbacks.onCountersChanged()
  }

  // --- Questions (FR-020): stream-only, clickable choices ---

  private async handleQuestion(context: CanUseToolContext): Promise<PermissionResult> {
    const rawQuestions = Array.isArray(context.input.questions)
      ? (context.input.questions as {
          question?: string
          header?: string
          options?: { label?: string; description?: string }[]
        }[])
      : []
    if (rawQuestions.length === 0) {
      return { behavior: 'allow', updatedInput: context.input }
    }

    let sink
    try {
      sink = this.manager.sinkFor(context.sessionId)
    } catch {
      return { behavior: 'deny', message: 'Session is no longer active' }
    }

    const session = this.repos.sessions.byId(context.sessionId)
    return new Promise<PermissionResult>((resolve) => {
      const group: QuestionGroup = {
        sessionId: context.sessionId,
        input: context.input,
        questions: [],
        answers: rawQuestions.map(() => null),
        resolve,
        settled: false,
      }
      rawQuestions.forEach((raw, index) => {
        const options: QuestionOption[] = (raw.options ?? [])
          .filter((o) => typeof o.label === 'string')
          .map((o) => ({ label: o.label as string, description: o.description }))
        const event = sink.append('question', {
          text: raw.question ?? 'The session has a question',
          options,
          answered: false,
        })
        group.questions.push({
          eventId: event.id,
          questionIndex: index,
          answered: false,
        })
        this.questions.set(event.id, group)
        this.manager.attentionRaised(context.sessionId)
        this.callbacks.onNeedsYou({
          projectId: session?.projectId ?? '',
          sessionId: context.sessionId,
          kind: 'question',
          eventId: event.id,
          title: raw.question ?? 'Question',
        })
      })
      context.options.signal.addEventListener(
        'abort',
        () => {
          if (group.settled) return
          group.settled = true
          for (const q of group.questions) {
            if (!q.answered) this.manager.attentionCleared(context.sessionId)
            this.questions.delete(q.eventId)
          }
          resolve({ behavior: 'deny', message: 'The question was cancelled' })
        },
        { once: true },
      )
    })
  }

  /** Click on a choice in the stream (FR-020). */
  answerQuestion(sessionId: string, eventId: string, choice: string): void {
    const group = this.questions.get(eventId)
    if (!group || group.sessionId !== sessionId) {
      throw new BrokerError('NOT_FOUND', 'Question not found')
    }
    const question = group.questions.find((q) => q.eventId === eventId)
    if (!question || question.answered) {
      throw new BrokerError('NOT_FOUND', 'The question has already been answered')
    }
    question.answered = true
    group.answers[question.questionIndex] = choice
    this.questions.delete(eventId)
    this.manager.attentionCleared(sessionId)

    try {
      const sink = this.manager.sinkFor(sessionId)
      const rawQuestions = group.input.questions as { question?: string; options?: unknown[] }[]
      const raw = rawQuestions[question.questionIndex]
      sink.update(
        eventId,
        {
          text: raw?.question ?? 'Question',
          options: ((raw?.options ?? []) as { label?: string; description?: string }[]).map((o) => ({
            label: o.label ?? '',
            description: o.description,
          })),
          answered: true,
          answer: choice,
        },
        { persist: true },
      )
    } catch {
      // Session ended mid-answer; the resolution below still settles the group.
    }

    if (!group.settled && group.questions.every((q) => q.answered)) {
      group.settled = true
      group.resolve(buildQuestionResult(group.input, group.answers))
    }
  }
}

/**
 * Shapes the AskUserQuestion allow result per the Agent SDK user-input
 * contract (code.claude.com/docs/en/agent-sdk/user-input, verified against
 * SDK 0.3.215): pass `questions` through unchanged and return an `answers`
 * object mapping each question's `question` text to the selected option's
 * `label`.
 */
function buildQuestionResult(
  input: Record<string, unknown>,
  answers: (string | null)[],
): PermissionResult {
  const questions = (input.questions ?? []) as { question?: string }[]
  const answerMap: Record<string, string> = {}
  questions.forEach((q, index) => {
    if (typeof q.question === 'string') {
      answerMap[q.question] = answers[index] ?? ''
    }
  })
  return { behavior: 'allow', updatedInput: { questions: input.questions, answers: answerMap } }
}
