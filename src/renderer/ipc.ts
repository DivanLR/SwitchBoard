import type { InvokeMap, InvokeMethod } from '@shared/ipc-types'
import { toCloneable } from '@shared/cloneable'

export { errorMessage } from '@shared/ipc-types'

export function invoke<M extends InvokeMethod>(
  method: M,
  req: InvokeMap[M]['req'],
): Promise<InvokeMap[M]['res']> {
  return window.switchboard.invoke(method, toCloneable(req))
}
