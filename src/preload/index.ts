// Preload bridge (T009): exposes the typed IPC contract as `window.switchboard`
// with contextIsolation on and nodeIntegration off. The renderer has no other
// capability (FR-021b).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  InvokeMap,
  InvokeMethod,
  PushChannel,
  PushMap,
  SwitchboardApi,
  WireResult,
} from '@shared/ipc-types'
import { PUSH_CHANNELS } from '@shared/ipc-types'

const api: SwitchboardApi = {
  async invoke<M extends InvokeMethod>(
    method: M,
    req: InvokeMap[M]['req'],
  ): Promise<InvokeMap[M]['res']> {
    const result = (await ipcRenderer.invoke('switchboard:invoke', method, req)) as WireResult<
      InvokeMap[M]['res']
    >
    if (result.ok) return result.value
    throw result.error
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
}

contextBridge.exposeInMainWorld('switchboard', api)
