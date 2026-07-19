// T051 (real-session smoke): drives the REAL Agent SDK through the production
// SessionManager + PermissionBroker stack — session spawn, streaming events,
// canUseTool interception, decision delivery, and turn completion with cost
// figures. Opt-in because it spends real tokens and needs an authenticated
// Claude Code installation:
//
//   $env:REAL_SESSION = '1'; npx vitest run tests/unit/real-session.spec.ts
//
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@shared/domain'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import { PermissionBroker } from '@main/inbox/permission-broker'
import { defaultRiskRules } from '@main/inbox/risk-rules'

const enabled = process.env.REAL_SESSION === '1'

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe.runIf(enabled)('real Claude Code session (quickstart smoke)', () => {
  it(
    'streams events, intercepts a permission, delivers the approval, and completes the turn',
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'switchboard-smoke-'))
      execSync('git init', { cwd: projectDir })

      const db = openDatabase(':memory:')
      const repos = createRepositories(db)
      repos.riskRules.replaceAll(defaultRiskRules())
      const project = repos.projects.insert({ name: 'smoke', path: projectDir, source: 'manual' })

      const events: SessionEvent[] = []
      const approvedRequests: string[] = []
      const late: { broker: PermissionBroker | null } = { broker: null }

      const manager = new SessionManager(repos, {
        onEvent: (event) => events.push(event),
        onSessionStatus: () => {},
        onCountersChanged: () => {},
        onSessionExit: (sessionId) => late.broker?.expireForSession(sessionId),
        onQueueChanged: () => {},
        onProjectCommands: () => {},
        gate: (context) => {
          if (!late.broker) throw new Error('broker missing')
          return late.broker.handle(context)
        },
      })

      const broker = new PermissionBroker(repos, manager, {
        onInboxChanged: (push) => {
          // The smoke test plays the developer: approve whatever arrives.
          if (push.added) {
            approvedRequests.push(push.added.id)
            setTimeout(() => broker.decide(push.added!.id, 'approve', true), 100)
          }
        },
        onCountersChanged: () => {},
        onNeedsYou: () => {},
      })
      late.broker = broker

      const session = manager.startSession(project.id)
      manager.sendMessage(
        session.id,
        'Using the Bash tool, create a file with `echo hello > smoke.txt` and then delete it with `rm smoke.txt`. Then reply with the single word DONE.',
      )

      await waitFor(() => events.some((e) => e.kind === 'result'), 150_000, 'a result event')

      const kinds = new Set(events.map((e) => e.kind))
      expect(kinds.has('prompt')).toBe(true)
      expect(kinds.has('result')).toBe(true)
      // The permission interception round-tripped through the broker.
      expect(approvedRequests.length).toBeGreaterThan(0)
      expect(kinds.has('permission_marker')).toBe(true)
      expect(kinds.has('tool_activity')).toBe(true)
      const decisions = repos.requests.history({})
      expect(decisions.some((d) => d.status === 'approved')).toBe(true)
      // Cost figures come from the SDK result message (R11).
      const result = events.find((e) => e.kind === 'result')
      expect((result?.payload as { totalCostUsd: number }).totalCostUsd).toBeGreaterThanOrEqual(0)

      await manager.stopSession(session.id)
      await waitFor(
        () => repos.sessions.byId(session.id)?.endedAt !== null,
        30_000,
        'session end reconciliation',
      )
      db.close()
    },
    180_000,
  )
})

describe.runIf(enabled)('real AskUserQuestion routing (T021 watch item)', () => {
  it(
    'renders a question as a stream event and delivers the clicked answer',
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'switchboard-question-'))
      const db = openDatabase(':memory:')
      const repos = createRepositories(db)
      repos.riskRules.replaceAll(defaultRiskRules())
      const project = repos.projects.insert({ name: 'q-smoke', path: projectDir, source: 'manual' })

      const events: SessionEvent[] = []
      const late: { broker: PermissionBroker | null } = { broker: null }
      const manager = new SessionManager(repos, {
        onEvent: (event) => {
          const index = events.findIndex((e) => e.id === event.id)
          if (index === -1) events.push(event)
          else events[index] = event
        },
        onSessionStatus: () => {},
        onCountersChanged: () => {},
        onSessionExit: (sessionId) => late.broker?.expireForSession(sessionId),
        onQueueChanged: () => {},
        onProjectCommands: () => {},
        gate: (context) => {
          if (!late.broker) throw new Error('broker missing')
          return late.broker.handle(context)
        },
      })
      const broker = new PermissionBroker(repos, manager, {
        onInboxChanged: (push) => {
          if (push.added) setTimeout(() => broker.decide(push.added!.id, 'approve', true), 100)
        },
        onCountersChanged: () => {},
        onNeedsYou: () => {},
      })
      late.broker = broker

      const session = manager.startSession(project.id)
      manager.sendMessage(
        session.id,
        'Use the AskUserQuestion tool to ask me one question: "Which colour do you prefer?" with exactly two options, Red and Blue. After I answer, reply with only the colour I chose.',
      )

      await waitFor(() => events.some((e) => e.kind === 'question'), 150_000, 'a question event')
      const question = events.find((e) => e.kind === 'question')
      const payload = question?.payload as { options: { label: string }[] }
      expect(payload.options.map((o) => o.label)).toContain('Blue')
      // Questions never become inbox items (FR-020).
      expect(repos.requests.pending()).toHaveLength(0)

      broker.answerQuestion(session.id, question!.id, 'Blue')
      await waitFor(() => events.some((e) => e.kind === 'result'), 150_000, 'the turn result')

      const answered = events.find((e) => e.id === question!.id)?.payload as { answered: boolean }
      expect(answered.answered).toBe(true)
      // The model saw the chosen answer if its final text names the colour.
      const texts = events
        .filter((e) => e.kind === 'assistant_text' || e.kind === 'summary')
        .map((e) => (e.payload as { text: string }).text)
        .join(' ')
      expect(texts.toLowerCase()).toContain('blue')

      await manager.stopSession(session.id)
      db.close()
    },
    240_000,
  )
})

describe.runIf(!enabled)('real Claude Code session (skipped)', () => {
  it('is opt-in: set REAL_SESSION=1 to run against a live session', () => {
    expect(enabled).toBe(false)
  })
})
