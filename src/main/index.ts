import { app, BrowserWindow, dialog, Menu, nativeImage, net, protocol, session, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, renameSync } from 'node:fs'
import { devRendererUrl, resolveBundlePath } from './bundle-path'
import { openDatabase } from './store/db'
import { createRepositories, type Repositories } from './store/repositories'
import { runRetention, scheduleRetention } from './store/retention'
import { SessionManager } from './sessions/session-manager'
import { PermissionBroker } from './inbox/permission-broker'
import { classifyNoise, defaultSwallowRules } from './stream/swallow-rules'
import { createNotifier } from './notifications'
import { followDeepLink, PROTOCOL_SCHEME } from './deep-link'
import { registerProject } from './projects/discovery'
import { computeCounters, registerIpcHandlers, RendererPush } from './ipc/handlers'
import { readDiagramList } from './diagrams/list'
import { stagingSkillsRoot } from './skills/install'
import { FlowSupervisor } from './flow/flow-supervisor'
import { initUpdater } from './updater'
import { PtyHost } from './terminal/pty-host'

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAE7SURBVDhPY2CgJYhP+6SRnP7eISXlvQG6HE4QH/+fIyX1Y3ty2ofvyWkf/6Ph5fFZXyTQ9cAByKbk1A/XsWhE4NQPz0GuQtcLtjk59eN9DA3Y8XsMlySnf5yOrnDxku//9+77+X/Xnp/oBvxPSv24HdV2ND8XlXz6/+vXfzjo6vmKYUh8+nsFsAFgv6NJnjv/G6zx0eM/EPrRn/8Z2WiuSHsfADYgKeVDBrJE/8SvYE0gF5RVfPr//PlfMH/Fyu+orkj92AD1/3sHmCDIFnQNyAaCvAZ3Qcr7BGgYvBeACeYWfPq//+BPDCeDvHT5ym8UA1ASWFLax/3IzkP3LzofFOVwzWBXgJIt9tSHHWNLTEmpHyKIMSQx7X0Bul44ALkkKe3DcXRNYIwrGWMDKSkfLcDRm/qxAWQjLo0AbJPd8XqLsGkAAAAASUVORK5CYII='

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let shutdownComplete = false

const APP_SCHEME = 'app'
const APP_ORIGIN = `${APP_SCHEME}://bundle`
const DEV_RENDERER_URL = devRendererUrl(app.isPackaged, process.env)

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])

Menu.setApplicationMenu(null)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('com.haefelesoftware.switchboard')
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
    minWidth: 1080,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (DEV_RENDERER_URL) {
    void mainWindow.loadURL(DEV_RENDERER_URL)
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

function registerAppProtocol(): void {
  const root = resolve(import.meta.dirname, '../renderer')
  protocol.handle(APP_SCHEME, async (request) => {
    const target = resolveBundlePath(root, new URL(request.url).pathname)
    if (!target) return new Response('Forbidden', { status: 403 })
    const file = await net.fetch(pathToFileURL(target).toString())
    const headers = new Headers(file.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    return new Response(file.body, { status: file.status, statusText: file.statusText, headers })
  })
}

function applyContentSecurityPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  if (DEV_RENDERER_URL) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    })
  })
}

function openCorruptSafe(dbPath: string): ReturnType<typeof openDatabase> {
  try {
    return openDatabase(dbPath)
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const quarantined = `${dbPath}.corrupt-${stamp}`
    try {
      renameSync(dbPath, quarantined)
    } catch {
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
  if (!DEV_RENDERER_URL) registerAppProtocol()
  applyContentSecurityPolicy()

  const db = openCorruptSafe(join(app.getPath('userData'), 'switchboard.db'))
  const repos: Repositories = createRepositories(db)
  repos.projects.clearAllRefs()

  let broker: PermissionBroker | null = null

  const pusher = new RendererPush(
    () => mainWindow,
    () => computeCounters(repos),
  )

  const ptyHost = new PtyHost({
    onData: (id, data) => pusher.terminalData(id, data),
    onExit: (id, exitCode) => pusher.push('push.terminalExit', { id, exitCode }),
  })

  const manager = new SessionManager(repos, {
    onEvent: (event) => pusher.event(event),
    onSessionStatus: (push) => pusher.push('push.sessionStatus', push),
    onCountersChanged: () => pusher.countersChanged(),
    onSessionExit: (sessionId) => broker?.expireForSession(sessionId),
    onQueueChanged: (projectId) =>
      pusher.push('push.queueChanged', { projectId, items: repos.taskQueue.listForProject(projectId) }),
    onVerifyChanged: (projectId) =>
      pusher.push('push.verifyChanged', { projectId, runs: repos.verifyRuns.listForProject(projectId) }),
    onDiagramsChanged: (projectId) => {
      const project = repos.projects.byId(projectId)
      if (!project) return
      void readDiagramList(project.path, repos.diagramRequests.forProject(projectId))
        .then((entries) => pusher.push('push.diagramsChanged', { projectId, entries }))
        .catch(() => {})
    },
    onProjectCommands: (projectId, commands) => pusher.push('push.projectCommands', { projectId, commands }),
    gate: (context) => {
      if (!broker) throw new Error('Broker not initialised')
      return broker.handle(context)
    },
  })
  manager.reconcileOnStartup()
  manager.startWatchdog()
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

  const swallowRules = defaultSwallowRules()
  manager.setNoiseClassifier((event) => classifyNoise(swallowRules, event))

  const dbProjectPath = join(app.getPath('userData'), 'database-mcp')
  mkdirSync(dbProjectPath, { recursive: true })
  const dbProject =
    repos.projects.byPath(dbProjectPath) ??
    registerProject(repos, { path: dbProjectPath, name: 'Database', source: 'manual' })

  const handleDeepLink = (url: string): void =>
    followDeepLink(url, broker, (requestId) => {
      showWindow()
      pusher.push('push.focusRequest', { target: 'inbox', requestId })
    })
  const findDeepLinkUrl = (argv: string[]): string | undefined =>
    argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`))
  const deepLinkIn = (argv: string[]): void => {
    const url = findDeepLinkUrl(argv)
    if (url) handleDeepLink(url)
  }
  deepLinkIn(process.argv)

  const flow = new FlowSupervisor(repos, manager, {
    onFlowChanged: (projectId) =>
      pusher.push('push.flowChanged', {
        projectId,
        runs: repos.flowRuns.listForProject(projectId),
        stages: repos.flowStages.listForProject(projectId),
      }),
  })
  manager.setFlowHooks({
    onMarker: (sessionId, marker) => flow.onFlowMarker(sessionId, marker),
    onSessionEnded: (sessionId, reason) => flow.onSessionEnded(sessionId, reason),
    onVerifyReport: (sessionId, report) => flow.onVerifyReport(sessionId, report),
    onTurnEnded: (sessionId, error) => flow.onTurnEnded(sessionId, error),
  })
  flow.reconcileOnStartup()

  registerIpcHandlers({
    repos,
    manager,
    broker,
    flow,
    getWindow: () => mainWindow,
    dbProjectId: dbProject.id,
    skillsStagingRoot: stagingSkillsRoot(app.getPath('userData')),
    ptyHost,
  })
  scheduleRetention(() => {
    repos.events.flush()
    runRetention(db)
  })
  initUpdater({ onStatus: (status) => pusher.push('push.updateStatus', status) })

  createWindow()
  createTray()

  app.on('window-all-closed', () => {})

  app.on('second-instance', (_event, argv) => {
    const url = findDeepLinkUrl(argv)
    if (url) {
      handleDeepLink(url)
      return
    }
    showWindow()
  })

  app.on('activate', () => showWindow())

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
    ptyHost.closeAll()
    void manager.endAllForAppExit().finally(() => {
      shutdownComplete = true
      repos.events.flush()
      db.close()
      app.quit()
    })
  })
}
