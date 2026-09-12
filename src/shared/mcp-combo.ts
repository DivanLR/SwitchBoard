export function comboKey(servers: string[]): string {
  return [...servers].map((s) => s.trim()).sort().join(' + ')
}

function hashOf(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export function comboSlug(servers: string[]): string {
  if (servers.length === 0) return 'none'
  const slug = [...servers]
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .sort()
    .join('+')
  return `${slug.slice(0, 110) || 'combo'}-${hashOf(comboKey(servers))}`
}

export function comboDocRelPath(servers: string[]): string {
  return `.switchboard/scans/${comboSlug(servers)}.md`
}
