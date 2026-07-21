// Electron app shell (T008): single-instance lock, tray-resident lifetime
// (window close hides, sessions keep running — FR-022a), application-exit
// confirmation and graceful shutdown (FR-022, T045), and composition of the
// store, session manager, permission broker, notifier, and IPC layer.
import { app, BrowserWindow, dialog, Menu, nativeImage, session, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openDatabase } from './store/db'
import { createRepositories, type Repositories } from './store/repositories'
import { runRetention, scheduleRetention } from './store/retention'
import { SessionManager } from './sessions/session-manager'
import { PermissionBroker } from './inbox/permission-broker'
import { classifyNoise } from './stream/swallow-rules'
import { createNotifier } from './notifications'
import { parseDeepLink, PROTOCOL_SCHEME } from './deep-link'
import { registerProject } from './projects/discovery'
import { computeCounters, registerIpcHandlers, RendererPush, seedDefaultRules } from './ipc/handlers'
import { initUpdater } from './updater'
import type { SwallowRule } from '@shared/domain'

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAE7SURBVDhPY2CgJYhP+6SRnP7eISXlvQG6HE4QH/+fIyX1Y3ty2ofvyWkf/6Ph5fFZXyTQ9cAByKbk1A/XsWhE4NQPz0GuQtcLtjk59eN9DA3Y8XsMlySnf5yOrnDxku//9+77+X/Xnp/oBvxPSv24HdV2ND8XlXz6/+vXfzjo6vmKYUh8+nsFsAFgv6NJnjv/G6zx0eM/EPrRn/8Z2WiuSHsfADYgKeVDBrJE/8SvYE0gF5RVfPr//PlfMH/Fyu+orkj92AD1/3sHmCDIFnQNyAaCvAZ3Qcr7BGgYvBeACeYWfPq//+BPDCeDvHT5ym8UA1ASWFLax/3IzkP3LzofFOVwzWBXgJIt9tSHHWNLTEmpHyKIMSQx7X0Bul44ALkkKe3DcXRNYIwrGWMDKSkfLcDRm/qxAWQjLo0AbJPd8XqLsGkAAAAASUVORK5CYII='

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let shutdownComplete = false

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
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    // Packaged builds take the icon from the exe resource; dev needs it set
    // explicitly or the taskbar shows the stock Electron icon.
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
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

function applyContentSecurityPolicy(): void {
  // The app needs no web permissions (camera/mic/geolocation/notifications are
  // handled natively in the main process). Deny every renderer permission
  // request and pre-check (Electron checklist A5).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  // Locality hardening (FR-021b): the renderer may only load itself.
  // Dev mode is exempt so Vite HMR (inline styles, ws) keeps working.
  if (process.env.ELECTRON_RENDERER_URL) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'",
        ],
      },
    })
  })
}

async function main(): Promise<void> {
  await app.whenReady()
  applyContentSecurityPolicy()

  const db = openDatabase(join(app.getPath('userData'), 'switchboard.db'))
  const repos: Repositories = createRepositories(db)
  // References are ephemeral: every launch starts with none (they persist only
  // within a run so they survive project switches, never across a restart).
  repos.projects.clearAllRefs()
  seedDefaultRules(repos)

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
    onProjectCommands: (projectId, commands) => pusher.push('push.projectCommands', { projectId, commands }),
    gate: (context) => {
      if (!broker) throw new Error('Broker not initialised')
      return broker.handle(context)
    },
  })
  manager.reconcileOnStartup()

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

  let swallowRules: SwallowRule[] = repos.swallowRules.list()
  const refreshSwallowRules = (): void => {
    swallowRules = repos.swallowRules.list()
  }
  manager.setNoiseClassifier((event, projectId) => classifyNoise(swallowRules, event, projectId))

  // Database MCP (global, project-less session): a reserved project row gives
  // it cwd/permissions/history through the existing per-project machinery.
  // ipc/handlers.ts marks it `reserved` so the sidebar never lists it as a
  // normal project; Sidebar.vue renders it as the single "Database" row.
  const dbProjectPath = join(app.getPath('userData'), 'database-mcp')
  mkdirSync(dbProjectPath, { recursive: true })
  const dbProject =
    repos.projects.byPath(dbProjectPath) ??
    registerProject(repos, { path: dbProjectPath, name: 'Database', source: 'manual' })

  // Auto-start only when a database MCP is designated. Any startup failure (a
  // missing Claude executable, an already-active session) throws a
  // SessionManagerError that is caught and ignored — the "Database" row's
  // manual start button covers retry.
  const startupSettings = repos.settings.get()
  if (startupSettings.databaseMcpServer) {
    const denied = (startupSettings.knownMcpServers ?? []).filter(
      (name) => name !== startupSettings.databaseMcpServer,
    )
    try {
      manager.startSession(dbProject.id, true, false, denied)
    } catch {
      // Non-fatal; see comment above.
    }
  }

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
    refreshSwallowRules,
    getWindow: () => mainWindow,
    dbProjectId: dbProject.id,
  })
  scheduleRetention(() => runRetention(db, repos))
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
