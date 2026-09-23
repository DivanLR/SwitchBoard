import type { PtyHost } from '@main/terminal/pty-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WireResult } from '@shared/ipc-types'
import { INVOKE_CHANNEL } from '@shared/ipc-types'
import { DIAGRAMS_DIR } from '@shared/diagram'

const registered = new Map<string, (...args: unknown[]) => unknown>()

const openPath = vi.fn(async (_target: string) => '')

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      registered.set(channel, listener)
    },
  },
  app: { getPath: () => 'C:\\tmp', isPackaged: false },
  shell: { openPath: (target: string) => openPath(target) },
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
  const mainFrame = { name: 'main' }
  return { webContents: { id: 7, mainFrame } }
}

function setup() {
  registered.clear()
  openPath.mockClear()
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},    onDiagramsChanged: () => {},
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
    skillsStagingRoot: join(tmpdir(), 'switchboard-test-skills'),    flow: { reconcileOnStartup: () => {} } as never,
    ptyHost: { open: () => ({ scrollback: '', reused: false }), write: () => {}, resize: () => {}, close: () => {}, closeAll: () => {} } as unknown as PtyHost,
  })

  const listener = registered.get(INVOKE_CHANNEL)
  if (!listener) throw new Error(`nothing registered on ${INVOKE_CHANNEL}`)

  const trustedEvent = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }
  const call = (method: string, req?: unknown) =>
    listener(trustedEvent, method, req) as Promise<WireResult<unknown>>

  return { repos, call }
}

describe('diagramPath, the guard behind diagrams.open and diagrams.read', () => {
  let harness: ReturnType<typeof setup>
  const dirs: string[] = []

  beforeEach(() => {
    harness = setup()
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function projectWithDiagram(file: string, html: string) {
    const root = mkdtempSync(join(tmpdir(), 'diagram-path-'))
    dirs.push(root)
    mkdirSync(join(root, 'docs', 'diagrams'), { recursive: true })
    writeFileSync(join(root, 'docs', 'diagrams', file), html, 'utf8')
    return harness.repos.projects.insert({ name: 'p', path: root, source: 'manual' })
  }

  it('reads back a plain file name that sits directly inside docs/diagrams', async () => {
    const project = projectWithDiagram('auth-flow.html', '<svg>ok</svg>')
    const result = await harness.call('diagrams.read', { projectId: project.id, file: 'auth-flow.html' })
    expect(result).toEqual({ ok: true, value: { html: '<svg>ok</svg>' } })
  })

  it('opens a plain file name at the exact path resolved inside the diagrams folder', async () => {
    const project = projectWithDiagram('auth-flow.html', '<svg>ok</svg>')
    const result = await harness.call('diagrams.open', { projectId: project.id, file: 'auth-flow.html' })
    expect(result).toEqual({ ok: true, value: null })
    expect(openPath).toHaveBeenCalledWith(resolve(project.path, DIAGRAMS_DIR, 'auth-flow.html'))
  })

  it('gives NOT_FOUND for an unknown project, before it ever looks at the file name', async () => {
    const result = await harness.call('diagrams.open', { projectId: 'no-such-project', file: 'auth-flow.html' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each([
    ['a forward slash', 'sub/evil.html'],
    ['a backslash', 'sub\\evil.html'],
    ['a parent segment', '../evil.html'],
    ['an absolute Windows path', 'C:\\Windows\\System32\\evil.html'],
  ])('refuses a file name containing %s with INVALID_PATH', async (_label, file) => {
    const project = harness.repos.projects.insert({ name: 'p', path: 'C:\\fake\\project', source: 'manual' })
    const result = await harness.call('diagrams.open', { projectId: project.id, file })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_PATH')
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each([
    ['a batch file', 'run.bat'],
    ['a shortcut', 'evil.lnk'],
    ['a name with no extension', 'README'],
  ])('refuses to open %s, because only an HTML drawing is ever opened', async (_label, file) => {
    const project = projectWithDiagram(file, '@echo off')
    const result = await harness.call('diagrams.open', { projectId: project.id, file })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_PATH')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('refuses to read back a file that is not an HTML drawing', async () => {
    const project = projectWithDiagram('notes.txt', 'private notes')
    const result = await harness.call('diagrams.read', { projectId: project.id, file: 'notes.txt' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_PATH')
  })

  it('refuses a bare name with none of those characters that still resolves outside the diagrams folder', async () => {
    const project = harness.repos.projects.insert({ name: 'p', path: 'C:\\fake\\project', source: 'manual' })
    const result = await harness.call('diagrams.open', { projectId: project.id, file: 'D:evil.html' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_PATH')
    expect(openPath).not.toHaveBeenCalled()
  })
})
