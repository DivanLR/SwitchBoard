// T027: broker lifecycle — pending -> decided/expired, standing-rule
// short-circuit, plan approvals, question routing (never the inbox), and
// undeliverable decisions (SC-004).
import { beforeEach, describe, expect, it } from 'vitest'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'
import { openDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso, type Repositories } from '@main/store/repositories'
import { PermissionBroker, BrokerError } from '@main/inbox/permission-broker'
import { defaultRiskRules } from '@main/inbox/risk-rules'
import type { SessionManager } from '@main/sessions/session-manager'
import type { EventSink } from '@main/sessions/message-mapper'

class FakeSink implements EventSink {
  seq = 0
  events: SessionEvent[] = []
  byId = new Map<string, SessionEvent>()

  append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
    this.seq += 1
    const event: SessionEvent = {
      id: `evt-${this.seq}`,
      sessionId: 's1',
      seq: this.seq,
      kind,
      payload,
      noiseKind: null,
      createdAt: nowIso(),
    }
    this.events.push(event)
    this.byId.set(event.id, event)
    return event as SessionEvent<K>
  }

  update<K extends EventKind>(eventId: string, payload: EventPayloadMap[K], options?: { kind?: K }): void {
    const event = this.byId.get(eventId)
    if (!event) return
    event.payload = payload
    if (options?.kind) event.kind = options.kind
  }
}

interface Harness {
  repos: Repositories
  broker: PermissionBroker
  sink: FakeSink
  sessionId: string
  projectId: string
  pushes: InboxChangedPush[]
  attention: { raised: number; cleared: number }
  gate: (toolName: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<PermissionResult>
}

function makeHarness(): Harness {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  repos.riskRules.replaceAll(defaultRiskRules())

  const project = repos.projects.insert({ name: 'alpha', path: 'C:\\proj\\alpha', source: 'manual' })
  const sessionId = newId()
  repos.sessions.insert({
    id: sessionId,
    projectId: project.id,
    sdkSessionId: null,
    status: 'working',
    statusDetail: null,
    branch: null,
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt: nowIso(),
    endedAt: null,
    endReason: null,
  })

  const sink = new FakeSink()
  const attention = { raised: 0, cleared: 0 }
  const manager = {
    sinkFor: () => sink,
    attentionRaised: () => {
      attention.raised += 1
    },
    attentionCleared: () => {
      attention.cleared += 1
    },
  } as unknown as SessionManager

  const pushes: InboxChangedPush[] = []
  const broker = new PermissionBroker(repos, manager, {
    onInboxChanged: (push) => pushes.push(push),
    onCountersChanged: () => {},
    onNeedsYou: () => {},
  })

  const gate: Harness['gate'] = (toolName, input, signal) =>
    broker.handle({
      sessionId,
      toolName,
      input,
      options: { signal: signal ?? new AbortController().signal },
    })

  return { repos, broker, sink, sessionId, projectId: project.id, pushes, attention, gate }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('PermissionBroker lifecycle', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  it('enqueues a pending item and resolves allow on approve', async () => {
    const promise = h.gate('Bash', { command: 'npm run build' })
    await settle()
    const pending = h.repos.requests.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].risk).toBe('medium')
    expect(h.attention.raised).toBe(1)

    const result = h.broker.decide(pending[0].id, 'approve')
    expect(result.delivered).toBe(true)
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm run build' },
    })
    expect(h.repos.requests.byId(pending[0].id)?.status).toBe('approved')
    expect(h.attention.cleared).toBe(1)

    const marker = h.sink.events.find((e) => e.kind === 'permission_marker')
    expect((marker?.payload as { status: string }).status).toBe('approved')
  })

  it('resolves deny with a message on deny', async () => {
    const promise = h.gate('Bash', { command: 'npm test' })
    await settle()
    const [pending] = h.repos.requests.pending()
    h.broker.decide(pending.id, 'deny')
    const result = await promise
    expect(result.behavior).toBe('deny')
    expect(h.repos.requests.byId(pending.id)?.status).toBe('denied')
  })

  it('requires explicit confirmation to approve high risk (FR-010)', async () => {
    void h.gate('Bash', { command: 'rm -rf dist' })
    await settle()
    const [pending] = h.repos.requests.pending()
    expect(pending.risk).toBe('high')
    expect(() => h.broker.decide(pending.id, 'approve')).toThrow(BrokerError)
    expect(h.repos.requests.byId(pending.id)?.status).toBe('pending')
    expect(h.broker.decide(pending.id, 'approve', true).delivered).toBe(true)
  })

  it('short-circuits standing rules as rule_approved without a pending item (FR-009b)', async () => {
    void h.gate('Bash', { command: 'git status' })
    await settle()
    const [first] = h.repos.requests.pending()
    h.broker.alwaysAllow(first.id, { kind: 'command_prefix', value: 'git status' })

    const result = await h.gate('Bash', { command: 'git status --short' })
    expect(result.behavior).toBe('allow')
    expect(h.repos.requests.pending()).toHaveLength(0)
    const history = h.repos.requests.history({})
    expect(history.some((d) => d.status === 'rule_approved')).toBe(true)
  })

  it('derives a folder-scoped matcher for file tools (never unscoped tool_only)', async () => {
    void h.gate('Write', { file_path: 'C:\\proj\\src\\a.ts' })
    await settle()
    const [req] = h.repos.requests.pending()
    // Even if the caller tries to widen it, the server derives from the input.
    h.broker.alwaysAllow(req.id, { kind: 'tool_only' })

    const rule = h.repos.standingRules.listForProject(h.projectId).at(-1)!
    expect(rule.matcher.kind).toBe('path_glob')

    // A write inside the same folder auto-approves; one elsewhere does not.
    const inside = await h.gate('Write', { file_path: 'C:\\proj\\src\\b.ts' })
    expect(inside.behavior).toBe('allow')
    void h.gate('Write', { file_path: 'C:\\elsewhere\\c.ts' })
    await settle()
    expect(h.repos.requests.pending().some((r) => r.detail.includes('elsewhere'))).toBe(true)
  })

  it('refuses standing rules for high risk and plan approvals (FR-009a/007a)', async () => {
    void h.gate('Bash', { command: 'rm -rf /' })
    await settle()
    const [high] = h.repos.requests.pending()
    expect(() => h.broker.alwaysAllow(high.id, { kind: 'tool_only' })).toThrow(BrokerError)
    h.broker.decide(high.id, 'deny')

    void h.gate('ExitPlanMode', { plan: 'The plan text' })
    await settle()
    const [plan] = h.repos.requests.pending()
    expect(plan.type).toBe('plan_approval')
    expect(() => h.broker.alwaysAllow(plan.id, { kind: 'tool_only' })).toThrow(BrokerError)
  })

  it('shapes plan approvals as single-click inbox items with the plan as detail (FR-007a)', async () => {
    const promise = h.gate('ExitPlanMode', { plan: '1. Do things\n2. Verify' })
    await settle()
    const [plan] = h.repos.requests.pending()
    expect(plan.detail).toContain('1. Do things')
    // Single click: no confirm step even though it is a blocking decision.
    expect(h.broker.decide(plan.id, 'approve').delivered).toBe(true)
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' })
    const marker = h.sink.events.find((e) => e.kind === 'plan_marker')
    expect(marker).toBeDefined()
  })

  it('approve-all approves pending non-high items only (FR-011)', async () => {
    void h.gate('Bash', { command: 'git status' }) // low
    void h.gate('Edit', { file_path: 'a.ts' }) // medium
    void h.gate('Bash', { command: 'rm -rf x' }) // high
    await settle()
    const outcome = h.broker.approveAllForProject(h.projectId)
    expect(outcome.approved).toBe(2)
    expect(outcome.skippedHighRisk).toBe(1)
    expect(h.repos.requests.pending()).toHaveLength(1)
  })

  it('expires items when the abort signal fires (session moved on)', async () => {
    const controller = new AbortController()
    const promise = h.gate('Bash', { command: 'npm test' }, controller.signal)
    await settle()
    const [pending] = h.repos.requests.pending()
    controller.abort()
    await settle()
    expect(h.repos.requests.byId(pending.id)?.status).toBe('expired')
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('expires all pending items for a dead session and surfaces undeliverable decisions (SC-004)', async () => {
    void h.gate('Bash', { command: 'npm test' })
    await settle()
    const [pending] = h.repos.requests.pending()
    h.broker.expireForSession(h.sessionId)
    expect(h.repos.requests.byId(pending.id)?.status).toBe('expired')

    // Deciding after expiry reports NOT_FOUND (already decided).
    expect(() => h.broker.decide(pending.id, 'approve')).toThrow(BrokerError)
  })

  it('marks decisions on vanished sessions as expired with deliveryFailed (SC-004)', async () => {
    void h.gate('Bash', { command: 'npm test' })
    await settle()
    const [pending] = h.repos.requests.pending()
    // Simulate a restart: the broker lost its in-memory pending entry.
    const fresh = new PermissionBroker(
      h.repos,
      {
        sinkFor: () => h.sink,
        attentionRaised: () => {},
        attentionCleared: () => {},
      } as unknown as SessionManager,
      { onInboxChanged: () => {}, onCountersChanged: () => {}, onNeedsYou: () => {} },
    )
    const outcome = fresh.decide(pending.id, 'approve')
    expect(outcome.delivered).toBe(false)
    const row = h.repos.requests.byId(pending.id)
    expect(row?.status).toBe('expired')
    expect(row?.deliveryFailed).toBe(true)
  })

  it('routes AskUserQuestion to the stream, never the inbox (FR-020)', async () => {
    const promise = h.gate('AskUserQuestion', {
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'Fast', description: 'quick' },
            { label: 'Thorough', description: 'slow' },
          ],
        },
      ],
    })
    await settle()
    expect(h.repos.requests.pending()).toHaveLength(0)
    const question = h.sink.events.find((e) => e.kind === 'question')
    expect(question).toBeDefined()
    expect(h.attention.raised).toBe(1)

    h.broker.answerQuestion(h.sessionId, question!.id, 'Fast')
    const result = await promise
    expect(result.behavior).toBe('allow')
    const answered = h.sink.byId.get(question!.id)?.payload as { answered: boolean; answer: string }
    expect(answered.answered).toBe(true)
    expect(answered.answer).toBe('Fast')

    // Second answer attempt is rejected.
    expect(() => h.broker.answerQuestion(h.sessionId, question!.id, 'Thorough')).toThrow(BrokerError)
  })

  it('pushes inboxChanged for added and resolved items', async () => {
    void h.gate('Bash', { command: 'npm test' })
    await settle()
    const [pending] = h.repos.requests.pending()
    h.broker.decide(pending.id, 'deny')
    expect(h.pushes.some((p) => p.added?.id === pending.id)).toBe(true)
    expect(h.pushes.some((p) => p.resolved?.requestId === pending.id && p.resolved.status === 'denied')).toBe(
      true,
    )
  })
})
