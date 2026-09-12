// The real terminal's transport half: the only place the Terminal tab talks to
// the main process (stores are the sole callers of `invoke`).
//
// Deliberately thin. There is no state worth caching here — the bytes belong to
// the xterm instance in the component, which is the thing that actually knows
// how to interpret them — so this store owns the calls and the subscription, and
// hands the data straight to whoever is listening.
import { reactive } from 'vue'
import type { SessionEngine } from '@shared/domain'
import { invoke } from '@renderer/ipc'

type DataListener = (data: string) => void
type ExitListener = (exitCode: number) => void

const dataListeners = new Map<string, Set<DataListener>>()
const exitListeners = new Map<string, Set<ExitListener>>()
const state = reactive({
  /** Terminals this window has opened, so the tab knows whether it is resuming. */
  open: new Set<string>(),
})

const store = {
  state,

  /** Output arriving from the main process, routed to whoever is showing that
   *  terminal. Called by App.vue, which owns every push subscription. */
  applyData(push: { id: string; data: string }): void {
    for (const listener of dataListeners.get(push.id) ?? []) listener(push.data)
  },

  applyExit(push: { id: string; exitCode: number }): void {
    state.open.delete(push.id)
    for (const listener of exitListeners.get(push.id) ?? []) listener(push.exitCode)
  },

  /** Subscribe to one terminal's output. Returns the unsubscribe. */
  onData(id: string, listener: DataListener): () => void {
    const set = dataListeners.get(id) ?? new Set<DataListener>()
    dataListeners.set(id, set)
    set.add(listener)
    return () => set.delete(listener)
  },

  onExit(id: string, listener: ExitListener): () => void {
    const set = exitListeners.get(id) ?? new Set<ExitListener>()
    exitListeners.set(id, set)
    set.add(listener)
    return () => set.delete(listener)
  },

  async open(input: {
    id: string
    cwd: string
    cols: number
    rows: number
    engine: SessionEngine | 'shell'
  }): Promise<{ scrollback: string; reused: boolean }> {
    const result = await invoke('terminal.open', input)
    state.open.add(input.id)
    return result
  },

  async write(id: string, data: string): Promise<void> {
    await invoke('terminal.write', { id, data })
  },

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await invoke('terminal.resize', { id, cols, rows })
  },

  async close(id: string): Promise<void> {
    await invoke('terminal.close', { id })
    state.open.delete(id)
  },
}

export const useTerminalStore = (): typeof store => store
