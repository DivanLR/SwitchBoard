// Electron app shell (T008): single-instance lock, tray-resident lifetime
// (window close hides, sessions keep running — FR-022a), application-exit
// confirmation and graceful shutdown (FR-022, T045), and composition of the
// store, session manager, permission broker, notifier, and IPC layer.
import { app, BrowserWindow, dialog, Menu, nativeImage, session, Tray } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './store/db'
import { createRepositories, type Repositories } from './store/repositories'
import { runRetention, scheduleRetention } from './store/retention'
import { SessionManager } from './sessions/session-manager'
import { PermissionBroker } from './inbox/permission-broker'
import { classifyNoise } from './stream/swallow-rules'
import { createNotifier } from './notifications'
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
  app.setAppUserModelId('com.switchboard.desktop')
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
  seedDefaultRules(repos)

  // Late-bound so the manager's gate can reference the broker (composition root).
  const late: { broker: PermissionBroker | null } = { broker: null }

  const pusher = new RendererPush(
    () => mainWindow,
    () => computeCounters(repos),
  )

  const manager = new SessionManager(repos, {
    onEvent: (event) => pusher.event(event),
    onSessionStatus: (push) => pusher.sessionStatus(push),
    onCountersChanged: () => pusher.countersChanged(),
    onSessionExit: (sessionId) => late.broker?.expireForSession(sessionId),
    onQueueChanged: (projectId) =>
      pusher.queueChanged({ projectId, items: repos.taskQueue.listForProject(projectId) }),
    onProjectCommands: (projectId, commands) => pusher.projectCommands({ projectId, commands }),
    gate: (context) => {
      if (!late.broker) throw new Error('Broker not initialised')
      return late.broker.handle(context)
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
    pushFocusRequest: (push) => pusher.focusRequest(push),
    notificationsEnabled: () => repos.settings.get().notificationsEnabled,
    projectName: (projectId) => repos.projects.byId(projectId)?.name ?? 'A project',
  })

  const broker = new PermissionBroker(repos, manager, {
    onInboxChanged: (push) => pusher.inboxChanged(push),
    onCountersChanged: () => pusher.countersChanged(),
    onNeedsYou: (context) => notify(context),
  })
  late.broker = broker

  let swallowRules: SwallowRule[] = repos.swallowRules.list()
  const refreshSwallowRules = (): void => {
    swallowRules = repos.swallowRules.list()
  }
  manager.setNoiseClassifier((event, projectId) => classifyNoise(swallowRules, event, projectId))

  registerIpcHandlers({ repos, manager, broker, refreshSwallowRules, getWindow: () => mainWindow })
  scheduleRetention(() => runRetention(db, repos))
  initUpdater({ onStatus: (status) => pusher.updateStatus(status) })

  createWindow()
  createTray()

  // The app stays resident in the tray when every window is closed (R2).
  app.on('window-all-closed', () => {})

  app.on('second-instance', () => showWindow())

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
