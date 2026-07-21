// App auto-update state (GitHub releases). Subscribes to push.updateStatus and
// exposes check/install actions.
import { defineStore } from 'pinia'
import type { UpdateStatus } from '@shared/ipc-types'

export const useUpdatesStore = defineStore('updates', {
  state: (): { status: UpdateStatus } => ({ status: { state: 'idle' } }),

  getters: {
    // A newer release exists (download not yet started).
    available: (s) => s.status.state === 'available',
    // The banner stays up through the whole download/install flow.
    active: (s) => ['available', 'downloading', 'ready'].includes(s.status.state),
    downloading: (s) => s.status.state === 'downloading',
    ready: (s) => s.status.state === 'ready',
    percent: (s) => s.status.percent ?? 0,
    busy: (s) => s.status.state === 'checking',
  },

  actions: {
    apply(status: UpdateStatus): void {
      this.status = status
    },
    async check(): Promise<void> {
      await window.switchboard.invoke('updates.check', undefined)
    },
    /** Downloads the installer inside the app and launches it (the app quits so
     *  the installer can replace files). Falls back to the browser if no asset. */
    async install(): Promise<void> {
      await window.switchboard.invoke('updates.install', undefined)
    },
  },
})
