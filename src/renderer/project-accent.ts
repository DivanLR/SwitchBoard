const PROJECT_ACCENTS = [
  'var(--blue)',
  'var(--amber)',
  'var(--purple)',
  'var(--green)',
  'var(--red)',
  'var(--teal)',
]

export function accentFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PROJECT_ACCENTS[hash % PROJECT_ACCENTS.length]
}

export function mcpStatusColor(status: string): string {
  const st = status.toLowerCase()
  if (st === 'connected') return 'var(--green)'
  if (st === 'failed' || st === 'error') return 'var(--red)'
  return 'var(--amber)'
}

export const GROUP_COLORS = [
  'var(--green)',
  'var(--purple)',
  'var(--blue)',
  'var(--amber)',
  'var(--teal)',
  'var(--red)',
]
