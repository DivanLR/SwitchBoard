// /usage response parsing into meters + dotted-list windows.
import { describe, expect, it } from 'vitest'
import { parseUsageReport } from '@shared/usage-report'

const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 69% used · resets Jul 23, 12:19am (Africa/Johannesburg)
Current week (all models): 43% used · resets Jul 27, 6:59pm (Africa/Johannesburg)
Current week (Fable): 27% used · resets Jul 27, 6:59pm (Africa/Johannesburg)

What's contributing to your limits usage? Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 3833 requests · 32 sessions
77% of your usage came from subagent-heavy sessions
74% of your usage was at >150k context
Top skills: /speckit-clarify 3%, /run 3%, /agent-browser:agent-browser 3%, /claude-api 1%
Top subagents: workflow-subagent 3%, general-purpose 3%, Explore 2%
Top MCP servers: plugin:context7:context7 2%, oracle-sqlcl 1%

Last 7d · 13145 requests · 108 sessions
82% of your usage was at >150k context
54% of your usage came from sessions active for 8+ hours
Top plugins: speckit 3%, ponytail 3%, dotnet-claude-kit 1%, +4 more`

describe('parseUsageReport', () => {
  it('parses limits, notes, and windows from the real /usage shape', () => {
    const r = parseUsageReport(USAGE)
    expect(r).not.toBeNull()
    expect(r!.limits).toEqual([
      { label: 'Current session', pct: 69, resets: 'Jul 23, 12:19am (Africa/Johannesburg)' },
      { label: 'Current week (all models)', pct: 43, resets: 'Jul 27, 6:59pm (Africa/Johannesburg)' },
      { label: 'Current week (Fable)', pct: 27, resets: 'Jul 27, 6:59pm (Africa/Johannesburg)' },
    ])
    expect(r!.notes.join(' ')).toContain("What's contributing")
    expect(r!.windows).toHaveLength(2)
    const day = r!.windows[0]
    expect(day.title).toBe('Last 24h')
    expect(day.volume).toBe('3833 requests · 32 sessions')
    expect(day.behaviors).toHaveLength(2)
    expect(day.tops.map((t) => t.label)).toEqual(['Top skills', 'Top subagents', 'Top MCP servers'])
    expect(day.tops[0].items[0]).toBe('/speckit-clarify 3%')
    const week = r!.windows[1]
    expect(week.tops[0].items).toContain('+4 more')
  })

  it('returns null for ordinary messages', () => {
    expect(parseUsageReport('Implemented the feature across 3 files.')).toBeNull()
    expect(parseUsageReport('The current session is going well.')).toBeNull()
  })
})
