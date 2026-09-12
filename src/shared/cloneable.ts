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
