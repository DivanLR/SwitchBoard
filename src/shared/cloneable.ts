/**
 * Rebuild a value as plain, structured-cloneable data.
 *
 * Electron serialises IPC arguments with structuredClone, and structuredClone
 * rejects a Proxy outright. Vue wraps every array and object reached through
 * `ref()` or `reactive()` in a Proxy, so any request assembled from reactive
 * state died at the contextBridge boundary with "An object could not be cloned",
 * an error naming neither the offending field nor the call that sent it. That is
 * what broke the Tests section's Run verification, which passed the reactive
 * array of selected suite ids straight through.
 *
 * Vue's proxies forward `get` and `ownKeys` faithfully, so a recursive copy reads
 * straight through them. Only arrays and plain objects are rebuilt: Dates, Maps,
 * Sets and ArrayBuffers already clone natively, and anything carrying a custom
 * prototype is returned untouched rather than silently flattened, which would
 * change what the main process receives.
 *
 * Pure and DOM-free on purpose, so it lives in shared/ and can be unit-tested in
 * a plain node environment. The renderer-side wrapper that applies it is
 * src/renderer/ipc.ts.
 */
export function toCloneable<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date || value instanceof ArrayBuffer) return value
  if (value instanceof Map || value instanceof Set) return value
  const existing = seen.get(value as object)
  if (existing !== undefined) return existing as T
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value as object, copy)
    for (const item of value) copy.push(toCloneable(item, seen))
    return copy as T
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const copy: Record<string, unknown> = {}
  seen.set(value as object, copy)
  for (const [key, item] of Object.entries(value)) copy[key] = toCloneable(item, seen)
  return copy as T
}
