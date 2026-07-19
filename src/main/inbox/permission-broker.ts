// Permission broker (R3, FR-007/007a/009/012): implements the Agent SDK
// canUseTool flow for every session. Standing rules short-circuit as
// rule_approved history entries; everything else becomes a pending inbox item
// whose promise resolves when the developer decides. Plan approvals are inbox
// items shaped by FR-007a; AskUserQuestion routes to the stream, never the
// inbox (FR-020).
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest, PermissionRuleMatcher, QuestionOption } from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import { classifyRisk } from './risk-rules'
import { evaluateStandingRules } from './standing-rules'

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
  sessionId: string
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
    decisionReason?: string
    toolUseID?: string
  }
}

function describeTool(toolName: string, input: Record<string, unknown>): {
  title: string
  explanation: string
  detail: string
} {
  const command = typeof input.command === 'string' ? input.command : null
  const path =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null
  if (toolName === 'Bash' && command) {
    return {
      title: `Run: ${command.length > 60 ? `${command.slice(0, 60)}…` : command}`,
      explanation: 'The session wants to run a shell command in the project folder.',
      detail: command,
    }
  }
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') && path) {
    return {
      title: `${toolName === 'Write' ? 'Write' : 'Edit'} ${path}`,
      explanation: 'The session wants to modify a file in the project.',
      detail: JSON.stringify(input, null, 2),
    }
  }
  if (toolName === 'Read' && path) {
    return {
      title: `Read ${path}`,
      explanation: 'The session wants to read a file.',
      detail: path,
    }
  }
  return {
    title: `${toolName}`,
    explanation: `The session wants to use the ${toolName} tool.`,
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

    // 1. Standing rules short-circuit, recorded as rule_approved (FR-009b).
    const standing = evaluateStandingRules(
      this.repos.standingRules.listForProject(projectId),
      context.toolName,
      context.input,
    )
    const described = describeTool(context.toolName, context.input)
    const title = context.options.title ?? described.title
    const explanation = context.options.description ?? described.explanation

    if (standing) {
      const request: PermissionRequest = {
        id: newId(),
        sessionId: context.sessionId,
        projectId,
        type: 'tool_permission',
        toolName: context.toolName,
        title,
        explanation,
        detail: described.detail,
        risk: classifyRisk(this.repos.riskRules.list(), context.toolName, context.input).risk,
        status: 'rule_approved',
        createdAt: nowIso(),
        resolvedAt: nowIso(),
        deliveryFailed: false,
      }
      this.repos.requests.insert(request)
      this.appendMarker(context.sessionId, 'permission_marker', request)
      this.callbacks.onInboxChanged({ resolved: { requestId: request.id, status: 'rule_approved' } })
      this.callbacks.onCountersChanged()
      return { behavior: 'allow', updatedInput: context.input }
    }

    // 2. Classify and enqueue.
    const { risk } = classifyRisk(this.repos.riskRules.list(), context.toolName, context.input)
    const request: PermissionRequest = {
      id: newId(),
      sessionId: context.sessionId,
      projectId,
      type: 'tool_permission',
      toolName: context.toolName,
      title,
      explanation,
      detail: described.detail,
      risk,
      status: 'pending',
      createdAt: nowIso(),
      resolvedAt: null,
      deliveryFailed: false,
    }
    return this.enqueue(context, request, 'permission_marker')
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

  /** Approves and saves a standing rule (FR-009a); low or medium risk tools only. */
  alwaysAllow(requestId: string, matcher: PermissionRuleMatcher) {
    const request = this.repos.requests.byId(requestId)
    if (!request) throw new BrokerError('NOT_FOUND', 'Permission request not found')
    if (request.type === 'plan_approval') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'Plan approvals never create standing rules')
    }
    if (request.risk === 'high') {
      throw new BrokerError('RULE_NOT_ALLOWED', 'High-risk actions are not eligible for standing rules')
    }
    if (request.status !== 'pending') {
      throw new BrokerError('NOT_FOUND', 'The request has already been decided')
    }
    const rule = this.repos.standingRules.insert({
      projectId: request.projectId,
      toolName: request.toolName ?? '',
      matcher,
      createdFromRequestId: request.id,
    })
    const decision = this.decide(requestId, 'approve')
    return { rule, delivered: decision.delivered }
  }

  /** Approves every pending non-high item in one project group (FR-011). */
  approveAllForProject(projectId: string): { approved: number; skippedHighRisk: number } {
    const pending = this.repos.requests.pendingForProject(projectId)
    let approved = 0
    let skippedHighRisk = 0
    for (const request of pending) {
      if (request.risk === 'high' && request.type === 'tool_permission') {
        skippedHighRisk += 1
        continue
      }
      this.decide(request.id, 'approve')
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
          sessionId: context.sessionId,
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

  pendingCount(): number {
    return this.repos.requests.pending().length
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
