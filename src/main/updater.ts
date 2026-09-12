import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/ipc-types'

const { autoUpdater } = electronUpdater

const RELEASES_PAGE = 'https://github.com/DivanLR/SwitchBoard/releases/latest'

let emit: (status: UpdateStatus) => void = () => {}
let availableVersion: string | null = null

export function initUpdater(deps: { onStatus: (status: UpdateStatus) => void }): void {
  emit = deps.onStatus
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
  if (app.isPackaged) void check()
}

export async function check(): Promise<UpdateStatus['state']> {
  if (!app.isPackaged) {
    emit({ state: 'none' })
    return 'none'
  }
  try {
    await autoUpdater.checkForUpdates()
    return availableVersion ? 'available' : 'none'
  } catch {
    return 'error'
  }
}

export async function installNow(): Promise<void> {
  if (!availableVersion) {
    await shell.openExternal(RELEASES_PAGE)
    return
  }
  try {
    await autoUpdater.downloadUpdate()
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
