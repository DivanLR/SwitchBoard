// Electron app shell (T008): single-instance lock, tray-resident lifetime
// (window close hides, sessions keep running — FR-022a), application-exit
// confirmation and graceful shutdown (FR-022, T045), and composition of the
// store, session manager, permission broker, notifier, and IPC layer.
import { app, BrowserWindow, dialog, Menu, nativeImage, net, protocol, session, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, renameSync } from 'node:fs'
import { resolveBundlePath } from './bundle-path'
import { openDatabase } from './store/db'
import { createRepositories, type Repositories } from './store/repositories'
import { runRetention, scheduleRetention } from './store/retention'
import { SessionManager } from './sessions/session-manager'
import { PermissionBroker } from './inbox/permission-broker'
import { classifyNoise } from './stream/swallow-rules'
import { createNotifier } from './notifications'
import { parseDeepLink, PROTOCOL_SCHEME } from './deep-link'
import { registerProject } from './projects/discovery'
import { computeCounters, registerIpcHandlers, RendererPush } from './ipc/handlers'
import { initUpdater } from './updater'
import { completeApiRun } from './evals/api-runner'

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAE7SURBVDhPY2CgJYhP+6SRnP7eISXlvQG6HE4QH/+fIyX1Y3ty2ofvyWkf/6Ph5fFZXyTQ9cAByKbk1A/XsWhE4NQPz0GuQtcLtjk59eN9DA3Y8XsMlySnf5yOrnDxku//9+77+X/Xnp/oBvxPSv24HdV2ND8XlXz6/+vXfzjo6vmKYUh8+nsFsAFgv6NJnjv/G6zx0eM/EPrRn/8Z2WiuSHsfADYgKeVDBrJE/8SvYE0gF5RVfPr//PlfMH/Fyu+orkj92AD1/3sHmCDIFnQNyAaCvAZ3Qcr7BGgYvBeACeYWfPq//+BPDCeDvHT5ym8UA1ASWFLax/3IzkP3LzofFOVwzWBXgJIt9tSHHWNLTEmpHyKIMSQx7X0Bul44ALkkKe3DcXRNYIwrGWMDKSkfLcDRm/qxAWQjLo0AbJPd8XqLsGkAAAAASUVORK5CYII='

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let shutdownComplete = false

// The packaged UI is served from app://bundle/ rather than file:// (Electron
// checklist A18). A file:// document has an opaque origin, which makes "'self'"
// in the CSP mean something the app cannot state precisely and leaves the
// renderer sharing an origin with the rest of the disk. A scheme of our own
// gives the UI one real, bounded origin, and the handler below decides what may
// be read through it — nothing outside the bundle directory.
const APP_SCHEME = 'app'
const APP_ORIGIN = `${APP_SCHEME}://bundle`

/**
 * The renderer's locality rule (FR-021b), stated once.
 *
 * script-src stays strict ('self', no unsafe-inline/eval). style-src carries
 * 'unsafe-inline' because the renderer uses inline :style bindings (project
 * accent colour, stream zoom) and Vue injects scoped-style tags at runtime; that
 * permits styles only, never script.
 *
 * base-uri and form-action do NOT inherit from default-src, so they default
 * permissive unless stated. object-src is stated for the same reason of not
 * relying on inheritance. Defence in depth: the only v-html sink (MarkdownText)
 * escapes first and reintroduces a fixed, attribute-free tag set, so there is no
 * injection path today.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"

// Must run before the app is ready. `standard` gives the scheme a real origin so
// relative asset URLs and 'self' resolve; `secure` makes it a secure context,
// as the UI would be over https.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])

// No menu-driven UI. Dropped BEFORE the app is ready, which is the point: after
// ready the default template has already been built and its accelerators
// registered (Ctrl+R reload, Ctrl+Shift+I DevTools, zoom), so clearing it later
// only removed the bar. The tray context menu is separate and unaffected.
Menu.setApplicationMenu(null)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Must match electron-builder's appId: the NSIS shortcut is registered under
  // that AppUserModelID, and Windows resolves the taskbar icon and notification
  // branding by matching the running app's AUMID to the shortcut's.
  app.setAppUserModelId('com.haefelesoftware.switchboard')
  // switchboard:// protocol: notification Approve buttons activate through it.
  // Dev runs need the executable + entry args spelled out; packaged builds
  // register plainly (the installer also writes the registry entries).
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
  }
  void main()
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    // Must not be BELOW the renderer's own declared floor: `.panes` carries
    // min-width: 1080px (src/renderer/App.vue). At 960 the window let .panes
    // overflow the viewport by 120px with no document scrollbar, so the right of
    // the inbox — the pane the whole product exists for — was clipped and
    // unreachable. The height pair was already consistent (600 >= .panes' 560).
    minWidth: 1080,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    // Packaged builds take the icon from the exe resource; dev needs it set
    // explicitly or the taskbar shows the stock Electron icon.
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's default since v20. Re-enabled by emitting the preload as
      // CommonJS (see electron.vite.config.ts): the earlier ESM preload was the
      // only reason this was ever off.
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Security hardening (Electron checklist A13/A14): the app is a self-contained
  // SPA that never navigates or opens child windows. Deny both categorically so
  // a stray link or injected navigation cannot escape the app shell.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  // Closing the window hides to tray; sessions keep running (FR-022a).
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  tray = new Tray(icon)
  tray.setToolTip('Switchboard — sessions keep running here')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Switchboard', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', () => showWindow())
}

/**
 * Serve the built renderer over app://bundle/, and nothing else.
 *
 * The traversal guard is the whole point of preferring this to file://: the
 * requested path is resolved FIRST and then tested against the bundle directory,
 * because only a resolved path can be compared honestly — `/../../` and its
 * encoded spellings all collapse before the check rather than after it. The
 * separator matters too, or a sibling directory sharing the prefix (renderer-old)
 * would pass a bare startsWith.
 *
 * The CSP is attached here rather than left to the webRequest hook alone, and
 * that is load-bearing rather than belt-and-braces: with the header set only on
 * this response the policy is live (proven by the real-app suite), so this is
 * the mechanism actually carrying it. A policy that silently stopped applying is
 * exactly the kind of regression nobody notices, which is why the suite asserts
 * it directly instead of trusting that a hook fires for a custom scheme.
 */
function registerAppProtocol(): void {
  const root = resolve(import.meta.dirname, '../renderer')
  protocol.handle(APP_SCHEME, async (request) => {
    const target = resolveBundlePath(root, new URL(request.url).pathname)
    if (!target) return new Response('Forbidden', { status: 403 })
    const file = await net.fetch(pathToFileURL(target).toString())
    // A fetched Response carries immutable headers, so the policy goes on a copy.
    const headers = new Headers(file.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    return new Response(file.body, { status: file.status, statusText: file.statusText, headers })
  })
}

function applyContentSecurityPolicy(): void {
  // The app needs no web permissions (camera/mic/geolocation/notifications are
  // handled natively in the main process). Deny every renderer permission
  // request and pre-check (Electron checklist A5).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  // Locality hardening (FR-021b): the renderer may only load itself.
  // Dev mode is exempt so Vite HMR (inline styles, ws) keeps working.
  //
  // The protocol handler already stamps the same policy on everything it serves;
  // this covers the session as a whole, so a response that never went through
  // that handler is not left uncovered either.
  if (process.env.ELECTRON_RENDERER_URL) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    })
  })
}

/**
 * Open the store, and survive a corrupt file rather than dying silently.
 *
 * Before this, a database that failed to open threw out of main() before any
 * window existed: the app simply never appeared, with no message and nothing in
 * the UI to act on. A transcript store is not precious enough to be worth that,
 * so a genuinely unopenable file is set aside and a fresh one created.
 *
 * The old file is RENAMED, never deleted, so the developer can still recover it
 * or send it in. The second failure is not caught: if a brand-new database in a
 * writable directory also fails, the problem is the environment, not the data,
 * and pretending otherwise would hide it.
 */
function openCorruptSafe(dbPath: string): ReturnType<typeof openDatabase> {
  try {
    return openDatabase(dbPath)
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const quarantined = `${dbPath}.corrupt-${stamp}`
    try {
      renameSync(dbPath, quarantined)
    } catch {
      // Cannot even move it, so there is nothing left to try but a clean open,
      // which will throw below and surface the real problem.
    }
    console.error(`[store] ${dbPath} could not be opened, moved to ${quarantined}:`, error)
    const db = openDatabase(dbPath)
    void dialog.showMessageBox({
      type: 'warning',
      message: 'Switchboard started with a new database.',
      detail: `The previous store could not be opened and was moved to:\n${quarantined}\n\nProjects and history from before now are not loaded. The old file was kept, not deleted.`,
      buttons: ['OK'],
    })
    return db
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  // Before any window: createWindow loads app://bundle/index.html straight away.
  if (!process.env.ELECTRON_RENDERER_URL) registerAppProtocol()
  applyContentSecurityPolicy()

  const db = openCorruptSafe(join(app.getPath('userData'), 'switchboard.db'))
  const repos: Repositories = createRepositories(db)
  // References are ephemeral: every launch starts with none (they persist only
  // within a run so they survive project switches, never across a restart).
  repos.projects.clearAllRefs()

  // Late-bound so the manager's gate can reference the broker (composition root).
  let broker: PermissionBroker | null = null

  const pusher = new RendererPush(
    () => mainWindow,
    () => computeCounters(repos),
  )

  const manager = new SessionManager(repos, {
    onEvent: (event) => pusher.event(event),
    onSessionStatus: (push) => pusher.push('push.sessionStatus', push),
    onCountersChanged: () => pusher.countersChanged(),
    onSessionExit: (sessionId) => broker?.expireForSession(sessionId),
    onQueueChanged: (projectId) =>
      pusher.push('push.queueChanged', { projectId, items: repos.taskQueue.listForProject(projectId) }),
    onEvalsChanged: (projectId) =>
      pusher.push('push.evalsChanged', { projectId, runs: repos.evals.listForProject(projectId) }),
    onVerifyChanged: (projectId) =>
      pusher.push('push.verifyChanged', { projectId, runs: repos.verifyRuns.listForProject(projectId) }),
    // The session has produced request data for an API eval set; the app makes
    // the calls and judges them itself from here on (api-runner.ts).
    onApiRequests: (projectId, runId, requests) =>
      void completeApiRun({
        repos,
        projectId,
        runId,
        requests,
        changed: (id) => pusher.push('push.apiChanged', { projectId: id, runs: repos.apiRuns.listForProject(id) }),
      }),
    onProjectCommands: (projectId, commands) => pusher.push('push.projectCommands', { projectId, commands }),
    gate: (context) => {
      if (!broker) throw new Error('Broker not initialised')
      return broker.handle(context)
    },
  })
  manager.reconcileOnStartup()
  // Warm the model list (one short-lived CLI query) so the settings picker is
  // populated the first time it opens, before any session has reported.
  void manager.models()

  const notify = createNotifier({
    isWindowActive: () =>
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      mainWindow.isFocused() &&
      !mainWindow.isMinimized(),
    showWindow,
    pushFocusRequest: (push) => pusher.push('push.focusRequest', push),
    notificationsEnabled: () => repos.settings.get().notificationsEnabled,
    projectName: (projectId) => repos.projects.byId(projectId)?.name ?? 'A project',
  })

  broker = new PermissionBroker(repos, manager, {
    onInboxChanged: (push) => pusher.push('push.inboxChanged', push),
    onCountersChanged: () => pusher.countersChanged(),
    onNeedsYou: (context) => notify(context),
  })

  // Read through the broker's rule set, not captured once: the developer can
  // switch a noise rule off while sessions are streaming, and it has to stop
  // hiding output immediately rather than after a restart. The set caches, so this
  // is a field read per event, not a query (see inbox/rule-set.ts).
  manager.setNoiseClassifier((event) => classifyNoise(broker.rules.swallowRules(), event))

  // Database MCP: a reserved project row gives it cwd/permissions/history
  // through the existing per-project machinery. ipc/handlers.ts marks it
  // `reserved` so the sidebar renders it as its own "Database" row rather than
  // a normal project. It starts on demand like any project (the DB view's start
  // button) — no launch auto-start and no MCP-server isolation.
  const dbProjectPath = join(app.getPath('userData'), 'database-mcp')
  mkdirSync(dbProjectPath, { recursive: true })
  const dbProject =
    repos.projects.byPath(dbProjectPath) ??
    registerProject(repos, { path: dbProjectPath, name: 'Database', source: 'manual' })

  // switchboard:// deep links from notification buttons. Approve routes through
  // the broker with confirmHighRisk — the toast already showed exactly what is
  // being approved, and a Windows toast has no second click to offer, so the
  // Approve button is the explicit confirmation. Expired/decided items still
  // fall back to opening the inbox on the item.
  const handleDeepLink = (url: string): void => {
    const link = parseDeepLink(url)
    if (!link) return
    if (link.verb === 'approve') {
      try {
        broker.decide(link.requestId, 'approve', true)
        return // approved in place; no need to raise the window
      } catch {
        // Expired, already decided, or high-risk (needs the in-app confirm).
      }
    }
    showWindow()
    pusher.push('push.focusRequest', { target: 'inbox', requestId: link.requestId })
  }
  const findDeepLinkUrl = (argv: string[]): string | undefined =>
    argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`))
  const deepLinkIn = (argv: string[]): void => {
    const url = findDeepLinkUrl(argv)
    if (url) handleDeepLink(url)
  }
  // Cold start via a notification button while the app was not running.
  deepLinkIn(process.argv)

  registerIpcHandlers({
    repos,
    manager,
    broker,
    getWindow: () => mainWindow,
    dbProjectId: dbProject.id,
  })
  scheduleRetention(() => runRetention(db))
  initUpdater({ onStatus: (status) => pusher.push('push.updateStatus', status) })

  createWindow()
  createTray()

  // The app stays resident in the tray when every window is closed (R2).
  app.on('window-all-closed', () => {})

  app.on('second-instance', (_event, argv) => {
    // A protocol activation launches a second instance carrying the URL.
    const url = findDeepLinkUrl(argv)
    if (url) {
      handleDeepLink(url)
      return
    }
    showWindow()
  })

  app.on('activate', () => showWindow())

  // Full application exit: warn when mid-task, then end sessions gracefully
  // so their context is resumable next launch (FR-022, T045).
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    quitting = true
    if (manager.anySessionMidTask()) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Quit and end sessions', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Sessions are mid-task',
        message: 'One or more sessions are still working.',
        detail:
          'Quitting ends every running session. Queued composer messages are kept as drafts and each conversation can be resumed on the next launch.',
      })
      if (choice === 1) {
        quitting = false
        return
      }
    }
    void manager.endAllForAppExit().finally(() => {
      shutdownComplete = true
      db.close()
      app.quit()
    })
  })
}
