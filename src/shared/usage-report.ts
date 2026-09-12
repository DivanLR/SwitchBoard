export interface UsageLimit {
  label: string
  pct: number
  resets: string
}

export interface UsageTop {
  label: string
  items: string[]
}

export interface UsageWindow {
  title: string
  volume: string
  behaviors: string[]
  tops: UsageTop[]
}

export interface UsageReport {
  limits: UsageLimit[]
  notes: string[]
  windows: UsageWindow[]
}

const LIMIT = /^Current ([^:]+):\s*(\d+)% used\s*·\s*resets\s*(.+)$/
const WINDOW = /^(Last \d+\w*)\s*·\s*(.+)$/
const TOP = /^Top ([\w ]+):\s*(.+)$/
const BEHAVIOR = /^\d+% of your usage/

export function parseUsageReport(text: string): UsageReport | null {
  if (!/Current session:\s*\d+% used/.test(text)) return null
  const limits: UsageLimit[] = []
  const notes: string[] = []
  const windows: UsageWindow[] = []
  let current: UsageWindow | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const limit = LIMIT.exec(line)
    if (limit) {
      limits.push({ label: `Current ${limit[1]}`, pct: Number(limit[2]), resets: limit[3] })
      continue
    }
    const win = WINDOW.exec(line)
    if (win) {
      current = { title: win[1], volume: win[2], behaviors: [], tops: [] }
      windows.push(current)
      continue
    }
    const top = TOP.exec(line)
    if (top && current) {
      current.tops.push({ label: `Top ${top[1]}`, items: top[2].split(/,\s+/) })
      continue
    }
    if (BEHAVIOR.test(line) && current) {
      current.behaviors.push(line)
      continue
    }
    if (!current && limits.length > 0) notes.push(line)
  }

  if (limits.length === 0) return null
  return { limits, notes, windows }
}
