import { reactive } from 'vue'
import type { SessionEngine } from '@shared/domain'
import { invoke } from '@renderer/ipc'

type DataListener = (data: string) => void
type ExitListener = (exitCode: number) => void

const dataListeners = new Map<string, Set<DataListener>>()
const exitListeners = new Map<string, Set<ExitListener>>()
const state = reactive({
  open: new Set<string>(),
  signInFor: null as string | null,
})

const store = {
  state,

  requestSignIn(projectId: string): void {
    state.signInFor = projectId
  },

  endSignIn(): void {
    state.signInFor = null
  },

  applyData(push: { id: string; data: string }): void {
    for (const listener of dataListeners.get(push.id) ?? []) listener(push.data)
  },

  applyExit(push: { id: string; exitCode: number }): void {
    state.open.delete(push.id)
    for (const listener of exitListeners.get(push.id) ?? []) listener(push.exitCode)
  },

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
    resumeSessionId?: string
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
