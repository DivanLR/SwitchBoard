import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron'
import { resolve } from 'node:path'
import { PtyHost } from '../../src/main/terminal/pty-host'
import { INVOKE_CHANNEL } from '../../src/shared/ipc-types'

await app.whenReady()
session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false))
session.defaultSession.setPermissionCheckHandler(() => false)
const window = new BrowserWindow({
  width: 1000,
  height: 700,
  webPreferences: {
    preload: resolve('out/preload/index.cjs'),
    contextIsolation: true,
    sandbox: true,
  },
})
const host = new PtyHost({
  onData: (id, data) => window.webContents.send('push.terminalData', { id, data }),
  onExit: (id, exitCode) => window.webContents.send('push.terminalExit', { id, exitCode }),
})
ipcMain.handle(INVOKE_CHANNEL, (_event, method, req) => {
  try {
    let value: unknown
    switch (method) {
      case 'terminal.open': value = host.open({ ...req, cwd: process.cwd() }); break
      case 'terminal.write': value = host.write(req.id, req.data); break
      case 'terminal.resize': value = host.resize(req.id, req.cols, req.rows); break
      case 'terminal.close': value = host.close(req.id); break
      case 'clipboard.read': value = { text: clipboard.readText() }; break
      case 'clipboard.write': value = clipboard.writeText(req.text); break
      default: throw new Error(`Unsupported fixture method: ${method}`)
    }
    return { ok: true, value: value ?? null }
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL', message: String(error) } }
  }
})
app.on('before-quit', () => host.closeAll())
await window.loadURL(`http://localhost:5199/@fs/${resolve('tests/fixtures/terminal-native.html').replaceAll('\\', '/')}`)
