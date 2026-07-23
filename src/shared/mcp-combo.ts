// MCP server combinations: each set of active servers gets its own scan doc
// and history entry, keyed order-independently. Shared between the renderer
// (scan prompt + display) and main (doc paths + history rows).

/** Order-independent display key: "github + postgres — production". */
export function comboKey(servers: string[]): string {
  return [...servers].map((s) => s.trim()).sort().join(' + ')
}

/** Tiny deterministic hash (djb2) so names that sanitise identically (e.g.
 *  "postgres — production" vs "postgres production") never share a file. */
function hashOf(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Filesystem-safe slug for the combo's scan doc. Sorted so the same set of
 *  servers always lands on the same file; hash-suffixed so different names
 *  that sanitise identically cannot collide. */
export function comboSlug(servers: string[]): string {
  if (servers.length === 0) return 'none'
  const slug = [...servers]
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .sort()
    .join('+')
  return `${slug.slice(0, 110) || 'combo'}-${hashOf(comboKey(servers))}`
}

/** Project-relative path the scan agent writes and the app reads. */
export function comboDocRelPath(servers: string[]): string {
  return `.switchboard/scans/${comboSlug(servers)}.md`
}
