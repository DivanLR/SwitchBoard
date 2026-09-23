import { win32 } from 'node:path'
import type { PermissionResult } from '@main/sessions/session'
import {
  isDangerousCommand,
  type PermissionRequest,
  type PermissionRule,
  type QuestionOption,
} from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import { classifyRisk, defaultRiskRules } from './risk-rules'
import { deriveMatcher, evaluateStandingRules, isPathWithinProject, pathOf } from './standing-rules'

const CWD_AUTO_APPROVE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit'])

const RISK_RULES = defaultRiskRules()

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

interface BrokerCallbacks {
  onInboxChanged: (push: InboxChangedPush) => void
  onCountersChanged: () => void
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
      explanation: 'Claude wants to run this shell command in the project folder.',
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
    detail: JSON.stringify(input, null, 2).slice(0, 4000),
  }
}

export class PermissionBroker {
  private pending = new Map<string, PendingEntry>()
  private questions = new Map<string, QuestionGroup>()

  constructor(
    private repos: Repositories,
    private manager: SessionManager,
    private callbacks: BrokerCallbacks,
  ) {}

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

    const standing = evaluateStandingRules(
      this.repos.standingRules.listForProject(projectId),
      context.toolName,
      context.input,
    )
    const withinOwnFolder =
      CWD_AUTO_APPROVE_TOOLS.has(context.toolName) &&
      project !== undefined &&
      [project.path, ...this.manager.sessionFolders(context.sessionId)].some((folder) =>
        isPathWithinProject(folder, context.input),
      )
    const described = describeTool(context.toolName, context.input)
    const risk = classifyRisk(RISK_RULES, context.toolName, context.input)
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
    }
  }

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
      if (request.type === 'plan_approval') this.manager.planExited(request.sessionId)
    } else {
      entry.resolve({ behavior: 'deny', message: 'Denied by the developer in Switchboard' })
    }
    return { delivered: true }
  }

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
      this.decide(request.id, 'approve', isHighRisk)
      approved += 1
    }
    return { approved, skippedHighRisk }
  }

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
    }

    if (!group.settled && group.questions.every((q) => q.answered)) {
      group.settled = true
      group.resolve(buildQuestionResult(group.input, group.answers))
    }
  }
}

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
