import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  InvokeMap,
  InvokeMethod,
  PushChannel,
  PushMap,
  SwitchboardApi,
  WireResult,
} from '@shared/ipc-types'
import { INVOKE_CHANNEL, PUSH_CHANNELS } from '@shared/ipc-types'

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
      const result = (await ipcRenderer.invoke(INVOKE_CHANNEL, method, req)) as WireResult<
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
    const wrapped =
      channel === 'push.event'
        ? (_event: IpcRendererEvent, batch: PushMap[C][]) => {
            for (const item of batch) {
              try {
                listener(item)
              } catch (err) {
                console.error(
                  'push.event listener threw for one item; the rest of the batch still applies',
                  err,
                )
              }
            }
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
