import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const buildGate = vi.hoisted(() => {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release?.() }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

vi.mock('@main/sessions/wslc-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sessions/wslc-sandbox')>()
  return {
    ...actual,
    ensureSandboxImage: () => buildGate.promise,
    ensureSandboxVolumes: () => Promise.resolve(),
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
    onDiagramsChanged: () => {},
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
      const otherProject = repos.projects.insert({ name: 'b', path: 'C:\\other', source: 'manual' })
      const hosted = (manager as unknown as { hosted: Map<string, unknown> }).hosted
      hosted.set('already-running', {
        row: { id: 'already-running', projectId: otherProject.id, endedAt: null },
        containerised: true,
      })

      const first = manager.startSession(project.id, false, undefined, undefined, {
        containerised: true,
      })

      await expect(
        manager.startSession(project.id, false, undefined, undefined, { containerised: true }),
      ).rejects.toMatchObject({ code: 'SANDBOX_FULL' })

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
      expect(hostedContainers).toHaveLength(2) 
    } finally {
      rmSync(dir, { recursive: true, force: true })
      db.close()
    }
  })
})
