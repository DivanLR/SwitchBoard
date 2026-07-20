// GitHub-releases auto-update via electron-updater. On startup (packaged builds
// only) it checks the configured GitHub repo for a newer release, downloads it
// in the background, and signals the renderer so the user can restart to apply.
// electron-builder writes the feed URL into app-update.yml from the `publish`
// config, so no URL is hard-coded here.
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/ipc-types'

const { autoUpdater } = electronUpdater

export interface UpdaterDeps {
  onStatus: (status: UpdateStatus) => void
}

let deps: UpdaterDeps | null = null

export function initUpdater(d: UpdaterDeps): void {
  deps = d
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Releases are published as GitHub pre-releases; without this the updater
  // silently skips every one of them and always reports "no update".
  autoUpdater.allowPrerelease = true

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => emit({ state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    emit({ state: 'downloading', percent: Math.round(p.percent) }),
  )
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => emit({ state: 'error', message: err?.message ?? String(err) }))

  // Only meaningful in a packaged build with an update feed.
  if (app.isPackaged) void check()
}

function emit(status: UpdateStatus): void {
  deps?.onStatus(status)
}

export async function check(): Promise<UpdateStatus['state']> {
  if (!app.isPackaged) {
    emit({ state: 'none' })
    return 'none'
  }
  try {
    await autoUpdater.checkForUpdates()
    return 'checking'
  } catch (err) {
    emit({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    return 'error'
  }
}

/** Quit and install a downloaded update (no-op if none is ready). */
export function installNow(): void {
  autoUpdater.quitAndInstall()
}
