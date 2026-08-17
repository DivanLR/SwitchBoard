// Two containerised starts landing in the gap between refuseWhenContainersFull's
// synchronous count and ensureSandboxImage's image build (which can take MINUTES
// on a first run) used to both pass the same admission check and together
// oversubscribe MAX_CONTAINERS — the exact crash the cap exists to prevent (see
// session-manager.ts's startSession doc and reservedContainerIds). This pins the
// fix: the first start's reservation must make a second concurrent one refuse
// before either of them ever touches Docker.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Held open until the test releases it, so a real "docker build" can never
// finish inside this test's window — reproducing the slow first-build gap the
// real bug lived in without actually spawning Docker.
const buildGate = vi.hoisted(() => {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release?.() }
})

// The run loop itself is never exercised here (this test only cares whether
// startSession's synchronous admission check and reservation behave under
// concurrency), so the mock query() just has to satisfy what HostedSession.start()
// calls without awaiting: supportedCommands()/supportedModels() (session-manager.ts
// always wires onModels), and an async-iterable that never yields — nothing here
// ever awaits the run loop draining.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

vi.mock('@main/sessions/docker-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sessions/docker-sandbox')>()
  return {
    ...actual,
    // The one call in startSession that actually reaches Docker. Held open so
    // the test can land a second concurrent start in the exact window the real
    // bug lived in.
    ensureSandboxImage: () => buildGate.promise,
  }
})

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'container-admission-'))
  const project = repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onApiRequests: () => {},
    onApiChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  return { db, repos, manager, project, dir }
}

describe('containerised admission does not race the image build', () => {
  it('refuses a second concurrent start once the first reserves the last slot', async () => {
    const { db, repos, manager, project, dir } = setup()
    try {
      // Occupies the FIRST of MAX_CONTAINERS (2) slots, the same private-map
      // technique tests/unit/ipc-diff.spec.ts's goLive uses to fake a hosted
      // entry without spinning up the SDK. A DIFFERENT project's session,
      // deliberately: startSession's own maybeDrainQueue looks up "the live
      // entry for this project" and would otherwise find this stub first (Map
      // iteration order) instead of the real session being started below.
      const otherProject = repos.projects.insert({ name: 'b', path: 'C:\\other', source: 'manual' })
      const hosted = (manager as unknown as { hosted: Map<string, unknown> }).hosted
      hosted.set('already-running', {
        row: { id: 'already-running', projectId: otherProject.id, endedAt: null },
        containerised: true,
      })

      // Passes the synchronous check (1 hosted < 2), reserves the LAST slot,
      // then suspends on ensureSandboxImage — buildGate is not released yet.
      const first = manager.startSession(project.id, false, undefined, undefined, {
        containerised: true,
      })

      // Lands in that exact window. With the reservation in place this must see
      // 1 hosted + 1 reserved = 2 and refuse, never reaching ensureSandboxImage.
      await expect(
        manager.startSession(project.id, false, undefined, undefined, { containerised: true }),
      ).rejects.toMatchObject({ code: 'SANDBOX_FULL' })

      // Letting the first "build" finish proves the reservation is released
      // rather than leaked: the session starts normally and the slot frees up.
      buildGate.release()
      const session = await first
      expect(session.projectId).toBe(project.id)
      expect(session.endedAt).toBeNull()

      const reserved = (manager as unknown as { reservedContainerIds: Set<string> }).reservedContainerIds
      expect(reserved.size).toBe(0)

      const hostedContainers = [...hosted.values()].filter(
        (e) => (e as { containerised: boolean; row: { endedAt: string | null } }).containerised &&
          !(e as { row: { endedAt: string | null } }).row.endedAt,
      )
      expect(hostedContainers).toHaveLength(2) // the cap was reached, never exceeded
    } finally {
      rmSync(dir, { recursive: true, force: true })
      db.close()
    }
  })
})
