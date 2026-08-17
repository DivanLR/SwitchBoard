// T051 (real-session smoke): drives the REAL Agent SDK through the production
// SessionManager + PermissionBroker stack — session spawn, streaming events,
// canUseTool interception, decision delivery, and turn completion with cost
// figures. Opt-in because it spends real tokens and needs an authenticated
// Claude Code installation:
//
//   $env:REAL_SESSION = '1'; npx vitest run tests/unit/real-session.spec.ts
//
import { describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@shared/domain'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import { PermissionBroker } from '@main/inbox/permission-broker'

const enabled = process.env.REAL_SESSION === '1'

// vi.waitFor replaces a hand-rolled polling loop. Its callbacks must ASSERT
// rather than return a boolean: it retries only while the callback throws, and
// resolves with whatever it returns, so a bare false predicate would pass
// instantly and the test would never actually wait.
const WAIT = { timeout: 150_000, interval: 500 }

describe.runIf(enabled)('real Claude Code session (quickstart smoke)', () => {
  it(
    'streams events, intercepts a permission, delivers the approval, and completes the turn',
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'switchboard-smoke-'))
      execSync('git init', { cwd: projectDir })

      const db = openDatabase(':memory:')
      const repos = createRepositories(db)
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
        onEvalsChanged: () => {},
        onVerifyChanged: () => {},
        onDiagramsChanged: () => {},
        onApiRequests: () => {},
        onApiChanged: () => {},
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

      const session = await manager.startSession(project.id)
      manager.sendMessage(
        session.id,
        'Using the Bash tool, create a file with `echo hello > smoke.txt` and then delete it with `rm smoke.txt`. Then reply with the single word DONE.',
      )

      await vi.waitFor(() => expect(events.some((e) => e.kind === 'result')).toBe(true), WAIT)

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
      await vi.waitFor(
        () => expect(repos.sessions.byId(session.id)?.endedAt).not.toBeNull(),
        { timeout: 30_000, interval: 500 },
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
        onEvalsChanged: () => {},
        onVerifyChanged: () => {},
        onDiagramsChanged: () => {},
        onApiRequests: () => {},
        onApiChanged: () => {},
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

      const session = await manager.startSession(project.id)
      manager.sendMessage(
        session.id,
        'Use the AskUserQuestion tool to ask me one question: "Which colour do you prefer?" with exactly two options, Red and Blue. After I answer, reply with only the colour I chose.',
      )

      await vi.waitFor(() => expect(events.some((e) => e.kind === 'question')).toBe(true), WAIT)
      const question = events.find((e) => e.kind === 'question')
      const payload = question?.payload as { options: { label: string }[] }
      expect(payload.options.map((o) => o.label)).toContain('Blue')
      // Questions never become inbox items (FR-020).
      expect(repos.requests.pending()).toHaveLength(0)

      broker.answerQuestion(session.id, question!.id, 'Blue')
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'result')).toBe(true), WAIT)

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

describe.runIf(enabled)('a section dispatching to a session it just started', () => {
  it(
    'keeps the background session alive and gets its answer',
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'switchboard-bg-'))
      const db = openDatabase(':memory:')
      const repos = createRepositories(db)
      const project = repos.projects.insert({ name: 'bg-smoke', path: projectDir, source: 'manual' })

      const events: SessionEvent[] = []
      const manager = new SessionManager(repos, {
        onEvent: (event) => events.push(event),
        onSessionStatus: () => {},
        onCountersChanged: () => {},
        onSessionExit: () => {},
        onQueueChanged: () => {},
        onEvalsChanged: () => {},
        onVerifyChanged: () => {},
        onDiagramsChanged: () => {},
        onApiRequests: () => {},
        onApiChanged: () => {},
        onProjectCommands: () => {},
        gate: async () => ({ behavior: 'allow', updatedInput: {} }) as never,
      })

      const session = await manager.startSession(project.id, false, undefined, undefined, {
        background: true,
      })
      manager.sendMessage(session.id, 'Reply with the single word DRAWN and nothing else.')

      await vi.waitFor(() => expect(events.some((e) => e.kind === 'result')).toBe(true), WAIT)
      const said = events
        .filter((e) => e.kind === 'assistant_text')
        .map((e) => (e.payload as { text: string }).text)
        .join(' ')
      expect(said.toUpperCase()).toContain('DRAWN')

      await manager.stopSession(session.id)
      db.close()
    },
    180_000,
  )
})

describe.runIf(!enabled)('real Claude Code session (skipped)', () => {
  it('is opt-in: set REAL_SESSION=1 to run against a live session', () => {
    expect(enabled).toBe(false)
  })
})
