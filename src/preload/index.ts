// Preload bridge (T009): exposes the typed IPC contract as `window.switchboard`
// with contextIsolation on and nodeIntegration off. The renderer has no other
// capability (FR-021b).
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  InvokeMap,
  InvokeMethod,
  PushChannel,
  PushMap,
  SwitchboardApi,
  WireResult,
} from '@shared/ipc-types'
import { PUSH_CHANNELS } from '@shared/ipc-types'

// In-flight invoke tracking so the renderer can show a global loading spinner
// whenever anything is loading — one chokepoint covers every IPC call.
let pending = 0
const loadingListeners = new Set<(n: number) => void>()
function notifyLoading(): void {
  for (const listener of loadingListeners) listener(pending)
}

const api: SwitchboardApi = {
  async invoke<M extends InvokeMethod>(
    method: M,
    req: InvokeMap[M]['req'],
  ): Promise<InvokeMap[M]['res']> {
    pending += 1
    notifyLoading()
    try {
      const result = (await ipcRenderer.invoke('switchboard:invoke', method, req)) as WireResult<
        InvokeMap[M]['res']
      >
      if (result.ok) return result.value
      throw result.error
    } finally {
      pending -= 1
      notifyLoading()
    }
  },

  onLoading(listener: (pending: number) => void): () => void {
    loadingListeners.add(listener)
    listener(pending)
    return () => loadingListeners.delete(listener)
  },

  on<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void {
    if (!PUSH_CHANNELS.includes(channel)) {
      throw new Error(`Unknown push channel: ${channel}`)
    }
    // push.event arrives as transport-level batches; the contract surface
    // delivers one event per listener call (contracts/ipc-contract.md).
    const wrapped =
      channel === 'push.event'
        ? (_event: IpcRendererEvent, batch: PushMap[C][]) => {
            for (const item of batch) listener(item)
          }
        : (_event: IpcRendererEvent, payload: PushMap[C]) => listener(payload)
    ipcRenderer.on(channel, wrapped as (event: IpcRendererEvent, ...args: unknown[]) => void)
    return () => {
      ipcRenderer.removeListener(
        channel,
        wrapped as (event: IpcRendererEvent, ...args: unknown[]) => void,
      )
    }
  },

  pathForFile(file: unknown): string {
    return webUtils.getPathForFile(file as File)
  },
}

contextBridge.exposeInMainWorld('switchboard', api)
