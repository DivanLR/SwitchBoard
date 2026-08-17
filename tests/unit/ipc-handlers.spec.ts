// The IPC boundary itself: the sender-trust check, the WireResult envelope, and
// error-code mapping. Every invoke in the app rides through this one callback, and
// until now its only exercise was the real-app suite, which the normal test run
// excludes — so a regression here reached a release without a red test.
//
// The individual handlers have their own specs (permission-broker, task-queue,
// folder-access, ...). What is tested here is the wrapper they all share.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcError, WireResult } from '@shared/ipc-types'
import { INVOKE_CHANNEL, isIpcErrorCode } from '@shared/ipc-types'

/** Captures the callback registered on the invoke channel. */
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

// handlers.ts imports the updater, which constructs electron-updater's NsisUpdater
// at module load and reads the real app's version. Mocked at the module boundary
// rather than reaching into electron-updater's internals.
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

/** The trusted window shape the sender check compares against. */
function fakeWindow() {
  const mainFrame = { name: 'main' }
  return { webContents: { id: 7, mainFrame } }
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
  })

  const listener = registered.get(INVOKE_CHANNEL)
  if (!listener) throw new Error(`nothing registered on ${INVOKE_CHANNEL}`)

  /** An event from the trusted window's top frame. */
  const trustedEvent = { sender: { id: 7 }, senderFrame: window.webContents.mainFrame }

  const call = (method: string, req?: unknown, event: unknown = trustedEvent) =>
    listener(event, method, req) as Promise<WireResult<unknown>>

  return { repos, call, window, trustedEvent }
}

describe('the invoke channel', () => {
  let harness: ReturnType<typeof setup>
  beforeEach(() => {
    harness = setup()
  })

  it('registers exactly one handler, on the shared channel constant', () => {
    expect([...registered.keys()]).toEqual([INVOKE_CHANNEL])
  })

  it('wraps a successful call in an ok envelope', async () => {
    const result = await harness.call('projects.list', undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ projects: [], counters: expect.any(Object) })
  })

  it('returns null rather than undefined for a void handler', async () => {
    const project = harness.repos.projects.insert({
      name: 'a',
      path: 'C:\\a',
      source: 'manual',
    })
    // projects.rename returns void; the envelope must still carry a cloneable value,
    // because undefined and "no value" are not the same thing across the bridge.
    const result = await harness.call('projects.rename', { projectId: project.id, name: 'b' })
    expect(result).toEqual({ ok: true, value: null })
  })

  it('maps a thrown IpcError to its own code, not INTERNAL', async () => {
    const result = await harness.call('projects.rename', { projectId: 'nope', name: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('maps an unexpected throw to INTERNAL and keeps the message', async () => {
    // A malformed request reaches the handler and fails on its own terms; the
    // envelope must still come back, never a rejected promise.
    const result = await harness.call('projects.rename', null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL')
    expect(result.error.message).toBeTruthy()
  })

  it('rejects an unknown method with NOT_FOUND instead of throwing', async () => {
    const result = await harness.call('does.not.exist', {})
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Unknown method does.not.exist' },
    } satisfies WireResult<never>)
  })
})

describe('isIpcErrorCode', () => {
  // The renderer switches on these codes, so one it does not recognise falls
  // through every branch and the developer is shown nothing at all. isIpcError
  // cannot catch that: across a wire it can only check that `code` is a string.
  it('accepts every real code', () => {
    for (const code of [
      'NOT_FOUND',
      'ALREADY_ACTIVE',
      'SESSION_ENDED',
      'CONFIRM_REQUIRED',
      'RULE_NOT_ALLOWED',
      'INVALID_PATH',
      'DUPLICATE',
      'INTERNAL',
    ]) {
      expect(isIpcErrorCode(code)).toBe(true)
    }
  })

  it('rejects a code that is not in the union', () => {
    expect(isIpcErrorCode('NOT_FOND')).toBe(false)
    expect(isIpcErrorCode('')).toBe(false)
  })

  it('rejects inherited object keys, which is why it uses Object.hasOwn', () => {
    // `'toString' in obj` is true for any object literal. A plain `in` check here
    // would have let these through as valid error codes.
    expect(isIpcErrorCode('toString')).toBe(false)
    expect(isIpcErrorCode('constructor')).toBe(false)
    expect(isIpcErrorCode('hasOwnProperty')).toBe(false)
  })

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 7, {}, ['NOT_FOUND']]) {
      expect(isIpcErrorCode(value)).toBe(false)
    }
  })
})

describe('the sender-trust check', () => {
  const untrusted = (error: IpcError): boolean =>
    error.code === 'INTERNAL' && error.message === 'Untrusted IPC sender'

  it('rejects another webContents', async () => {
    const { call, window } = setup()
    const result = await call('projects.list', undefined, {
      sender: { id: 99 },
      senderFrame: window.webContents.mainFrame,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })

  it('rejects a subframe of the trusted window', async () => {
    // The whole reason the frame is compared as well as the id: an iframe shares
    // its host's webContents id and would otherwise have passed.
    const { call } = setup()
    const result = await call('projects.list', undefined, {
      sender: { id: 7 },
      senderFrame: { name: 'child-iframe' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })

  it('rejects a disposed frame, failing closed', async () => {
    const { call } = setup()
    const result = await call('projects.list', undefined, { sender: { id: 7 }, senderFrame: null })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })

  it('rejects everything when there is no window at all', async () => {
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
    registerIpcHandlers({
      repos,
      manager,
      broker,
      getWindow: () => null,
      dbProjectId: 'db-project',
    })
    const listener = registered.get(INVOKE_CHANNEL)!
    const result = (await listener(
      { sender: { id: 7 }, senderFrame: { name: 'main' } },
      'projects.list',
      undefined,
    )) as WireResult<unknown>
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(untrusted(result.error)).toBe(true)
  })
})
