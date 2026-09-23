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
    removeNodeModulesVolume: () => {},
  }
})

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

type Hosted = Map<
  string,
  { containerised: boolean; row: { endedAt: string | null }; session: { options: { mode: string } } }
>

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
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const hosted = (manager as unknown as { hosted: Hosted }).hosted
  return { db, repos, manager, project, dir, hosted }
}

describe('containerised admission does not race the image build', () => {
  it('refuses a second concurrent start once the first reserves the last slot', async () => {
    const { db, repos, manager, project, dir, hosted } = setup()
    try {
      const otherProject = repos.projects.insert({ name: 'b', path: 'C:\\other', source: 'manual' })
      ;(hosted as Map<string, unknown>).set('already-running', {
        row: { id: 'already-running', projectId: otherProject.id, endedAt: null },
        containerised: true,
      })

      const first = manager.startSession(project.id, false, undefined, { containerised: true })

      await expect(
        manager.startSession(project.id, false, undefined, { containerised: true }),
      ).rejects.toMatchObject({ code: 'SANDBOX_FULL' })

      buildGate.release()
      const session = await first
      expect(session.projectId).toBe(project.id)
      expect(session.endedAt).toBeNull()

      const reserved = (manager as unknown as { reservedContainerIds: Set<string> })
        .reservedContainerIds
      expect(reserved.size).toBe(0)

      const hostedContainers = [...hosted.values()].filter((e) => e.containerised && !e.row.endedAt)
      expect(hostedContainers).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      db.close()
    }
  })
})

describe('a session working outside the project folder', () => {
  it('never takes a container, and a bypass project gives it accept edits instead', async () => {
    const { db, repos, manager, project, dir, hosted } = setup()
    const worktree = mkdtempSync(join(tmpdir(), 'container-admission-worktree-'))
    try {
      buildGate.release()
      repos.projects.setSessionMode(project.id, 'bypass')
      repos.projects.setUseContainers(project.id, true)

      const session = await manager.startSession(project.id, false, 'bypass', {
        background: true,
        cwd: worktree,
        containerised: true,
      })

      expect(session.bypassPermissions).toBe(false)
      expect(hosted.get(session.id)?.containerised).toBe(false)
      expect(hosted.get(session.id)?.session.options.mode).toBe('acceptEdits')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
      db.close()
    }
  })

  it('still takes one when the explicit folder is the project folder itself', async () => {
    const { db, repos, manager, project, dir, hosted } = setup()
    try {
      buildGate.release()
      repos.projects.setSessionMode(project.id, 'bypass')

      const session = await manager.startSession(project.id, false, undefined, {
        background: true,
        cwd: join(dir, '.'),
      })

      expect(session.bypassPermissions).toBe(true)
      expect(hosted.get(session.id)?.containerised).toBe(true)
      expect(hosted.get(session.id)?.session.options.mode).toBe('bypass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      db.close()
    }
  })
})
