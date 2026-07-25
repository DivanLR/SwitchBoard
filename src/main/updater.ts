// App auto-update through electron-updater, reading the GitHub release feed
// electron-builder's `publish:` block already describes. The IPC contract is
// unchanged: check reports whether a newer release exists, install downloads it
// (reporting progress) and then quits so the installer can replace files.
//
// Integrity: electron-updater verifies the downloaded installer against the
// SHA-512 recorded in the release's `latest.yml`, so a release MUST attach that
// file next to the installer (see electron-builder.yml). Without it the feed
// cannot be read and a check reports an error rather than a silent no-op.
import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/ipc-types'

// electron-updater is CommonJS and the main bundle is ESM, so Node cannot detect
// `autoUpdater` as a named export: it has to come off the default import. A named
// import type-checks and then fails at runtime in the packaged app.
const { autoUpdater } = electronUpdater

const RELEASES_PAGE = 'https://github.com/DivanLR/SwitchBoard/releases/latest'

let emit: (status: UpdateStatus) => void = () => {}
/** Set once a check finds a release; gates install and names it in the status. */
let availableVersion: string | null = null

export function initUpdater(deps: { onStatus: (status: UpdateStatus) => void }): void {
  emit = deps.onStatus
  // Check and download are separate steps: the banner offers the download, the
  // developer chooses when to take it.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version
    emit({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    availableVersion = null
    emit({ state: 'none' })
  })
  autoUpdater.on('download-progress', (progress) => {
    emit({
      state: 'downloading',
      version: availableVersion ?? undefined,
      percent: Math.min(100, Math.round(progress.percent)),
    })
  })
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (error) => emit({ state: 'error', message: error.message }))
  // Check once on startup in packaged builds; dev builds check only on demand
  // (an unpackaged app has no update feed to read).
  if (app.isPackaged) void check()
}

export async function check(): Promise<UpdateStatus['state']> {
  if (!app.isPackaged) {
    emit({ state: 'none' })
    return 'none'
  }
  try {
    await autoUpdater.checkForUpdates()
    // The update-available / update-not-available events are the authoritative
    // signal (the result carries the feed's latest version either way).
    return availableVersion ? 'available' : 'none'
  } catch {
    // The 'error' event already reported the detail to the renderer.
    return 'error'
  }
}

/**
 * Downloads the update (progress arrives through the events above) and restarts
 * into the installer. Falls back to the release page when the feed or the
 * download is unusable, so the developer is never left with a dead button.
 */
export async function installNow(): Promise<void> {
  if (!availableVersion) {
    await shell.openExternal(RELEASES_PAGE)
    return
  }
  try {
    await autoUpdater.downloadUpdate()
    // Detaches the installer and quits so the running files can be replaced.
    autoUpdater.quitAndInstall()
  } catch (error) {
    emit({
      state: 'error',
      message:
        error instanceof Error
          ? `${error.message}; opened the release page instead.`
          : 'The update could not be downloaded; opened the release page instead.',
    })
    await shell.openExternal(RELEASES_PAGE)
  }
}
