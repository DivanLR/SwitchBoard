// Resolving an app://bundle/ request to a file on disk. Kept free of Electron
// imports so the containment rule is unit-testable — the pathname arrives from
// the renderer, which makes this a trust boundary (same reasoning as deep-link.ts).
import { resolve, sep } from 'node:path'

/**
 * The file a bundle request names, or null when it points outside the bundle.
 *
 * Resolve FIRST, then compare. Only a resolved path can be judged honestly:
 * `..` segments, their percent-encoded spellings, and mixed separators all
 * collapse before the test rather than after it, so there is no spelling of
 * "escape the directory" left for the check to miss.
 *
 * The separator in the comparison is not incidental. A bare `startsWith(root)`
 * would also accept a sibling directory whose name merely begins with the same
 * characters — `renderer-backup` alongside `renderer` — which is a real way this
 * check is got wrong.
 */
export function resolveBundlePath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // A malformed escape sequence is not a path this bundle serves.
    return null
  }
  // A NUL byte truncates the name for some filesystem calls, so the path the
  // check approved would not be the path that got opened.
  if (decoded.includes('\0')) return null
  const target = resolve(root, `.${decoded}`)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}
