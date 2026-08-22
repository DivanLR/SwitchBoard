// Diff tab (specs/003-diff-tab): the 'diff.list'/'diff.file' handlers'
// project-resolution and liveness gating. The git-read behaviour itself
// (porcelain parsing, untracked files, binary detection) has its own spec —
// tests/unit/git-diff-files.spec.ts — so only delegation is checked here.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WireResult } from '@shared/ipc-types'
import { INVOKE_CHANNEL } from '@shared/ipc-types'

const registered = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      registered.set(channel, listener)
    },
  },
  app: { getPath: () => 'C:\\tmp', isPackaged: false },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class {},
}))

vi.mock('@main/updater', () => ({
  initUpdater: () => {},
  check: async () => 'idle',
  installNow: async () => {},
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')
const { PermissionBroker } = await import('@main/inbox/permission-broker')
const { registerIpcHandlers } = await import('@main/ipc/handlers')

function fakeWindow() {
  return { webContents: { id: 7, mainFrame: { name: 'main' } } }
}

function setup() {
  registered.clear()
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
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
  const broker = new PermissionBroker(repos, manager, {
    onInboxChanged: () => {},
    onCountersChanged: () => {},
    onNeedsYou: () => {},
  })
  const window = fakeWindow()
  registerIpcHandlers({
    repos,
    manager,
    broker,
    getWindow: () => window as never,
    dbProjectId: 'db-project',
    // A temp path: this suite never imports a skill, and the handlers only read
    // this when one is imported.
    skillsStagingRoot: join(tmpdir(), 'switchboard-test-skills'),
  })

  const listener = registered.get(INVOKE_CHANNEL)
  if (!listener) throw new Error(`nothing registered on ${INVOKE_CHANNEL}`)
  const trustedEvent = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }
  const call = (method: string, req?: unknown) =>
    listener(trustedEvent, method, req) as Promise<WireResult<unknown>>

  /** Marks a project as having a live session, the way a real hosted entry
   *  would — without spinning up the Agent SDK. Only `row.projectId` and
   *  `projectPath` are read by the diff.* handlers' liveness check. */
  const goLive = (projectId: string, projectPath: string): void => {
    const hosted = (manager as unknown as { hosted: Map<string, unknown> }).hosted
    hosted.set(`session-${projectId}`, {
      row: { id: `session-${projectId}`, projectId },
      projectPath,
      seq: 0,
      live: new Map(),
    })
  }

  return { repos, call, goLive }
}

describe('diff.list', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('fails with NOT_FOUND for an unknown project', async () => {
    const result = await harness.call('diff.list', { projectId: 'nope' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('fails with NOT_LIVE when the project has no live session', async () => {
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const result = await harness.call('diff.list', { projectId: project.id })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_LIVE')
  })

  it('delegates to the real working tree once the project is live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-tab-ipc-'))
    try {
      execSync('git init', { cwd: dir, stdio: 'ignore' })
      writeFileSync(join(dir, 'new.txt'), 'hi\n')
      const project = harness.repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
      harness.goLive(project.id, dir)

      const result = await harness.call('diff.list', { projectId: project.id })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual({
        gitNotice: null,
        files: [{ path: 'new.txt', status: 'untracked', addedLines: 1, removedLines: 0, binary: false }],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('diff.file', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('fails with NOT_FOUND for an unknown project', async () => {
    const result = await harness.call('diff.file', { projectId: 'nope', path: 'a.txt' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('fails with NOT_LIVE when the project has no live session', async () => {
    const project = harness.repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const result = await harness.call('diff.file', { projectId: project.id, path: 'a.txt' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_LIVE')
  })

  it('resolves to null for a path with no current change once the project is live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-tab-ipc-'))
    try {
      execSync('git init', { cwd: dir, stdio: 'ignore' })
      const project = harness.repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
      harness.goLive(project.id, dir)

      const result = await harness.call('diff.file', { projectId: project.id, path: 'missing.txt' })
      expect(result).toEqual({ ok: true, value: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
