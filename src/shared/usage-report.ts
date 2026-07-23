// Parses the Claude Code /usage response into a structured report so the
// stream can render meters and dotted lists instead of a wall of flowed prose.

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
  /** e.g. "Last 24h" */
  title: string
  /** e.g. "3833 requests · 32 sessions" */
  volume: string
  /** "77% of your usage came from…" behaviour lines. */
  behaviors: string[]
  /** "Top skills: a 3%, b 2%" rows. */
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

/** Structured /usage report, or null when the text is not one. */
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
    // Intro/asterisk-note prose before the first window ("What's contributing…").
    if (!current && limits.length > 0) notes.push(line)
  }

  if (limits.length === 0) return null
  return { limits, notes, windows }
}
