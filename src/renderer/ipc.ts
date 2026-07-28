import type { InvokeMap, InvokeMethod } from '@shared/ipc-types'
import { toCloneable } from '@shared/cloneable'

// Re-exported so the door and the words for what came back through it are imported
// from one place; the function itself lives with the IpcError shape it unwraps.
export { errorMessage } from '@shared/ipc-types'

/**
 * The renderer's single door to the main process.
 *
 * Every store and view calls THIS rather than `window.switchboard.invoke`
 * directly, and an ESLint rule (`no-restricted-syntax` in eslint.config.mjs)
 * enforces it. The reason is a failure mode that gives no useful diagnostic:
 * contextBridge structured-clones each argument as it crosses from the renderer's
 * isolated world into the preload's, structuredClone rejects a Proxy, and Vue
 * wraps everything reachable through `ref()`/`reactive()` in one. A request built
 * from reactive state therefore failed with "An object could not be cloned",
 * naming neither the field nor the call.
 *
 * Two things were tried first and do not work, which is why this module exists:
 *   - Sanitising inside the PRELOAD is too late. contextBridge has already
 *     attempted the clone before the preload's function body runs.
 *   - Wrapping the global in place is impossible. `window.switchboard` is exposed
 *     frozen, non-writable and non-configurable, so it cannot be reassigned.
 *
 * The renderer side of the boundary is the only place a fix can sit.
 */
export function invoke<M extends InvokeMethod>(
  method: M,
  req: InvokeMap[M]['req'],
): Promise<InvokeMap[M]['res']> {
  return window.switchboard.invoke(method, toCloneable(req))
}

