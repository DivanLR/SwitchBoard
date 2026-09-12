import { describe, expect, it } from 'vitest'
import { handoff, sessionsReport, type InterSessionDeps } from '@main/sessions/inter-session'

const deps = (
  from: string,
  opts: { running?: string[]; startFails?: string; queued?: Record<string, number> } = {},
): { deps: InterSessionDeps; sent: { id: string; text: string }[]; started: string[] } => {
  const sent: { id: string; text: string }[] = []
  const started: string[] = []
  const running = new Set(opts.running ?? [])
  const projects = [
    { id: 'p1', name: 'Switchboard' },
    { id: 'p2', name: 'Ledger API' },
  ]
  return {
    sent,
    started,
    deps: {
      from,
      projects: () => projects,
      enqueue: (id, text) => sent.push({ id, text }),
      isRunning: (id) => running.has(id),
      start: async (id) => {
        if (opts.startFails === id) throw new Error('Docker is not running')
        started.push(id)
        running.add(id)
      },
      overview: () =>
        projects.map((p) => ({
          name: p.name,
          running: running.has(p.id),
          status: running.has(p.id) ? ('working' as const) : undefined,
          queued: opts.queued?.[p.id] ?? 0,
        })),
    },
  }
}

describe('handing work to another project', () => {
  it('queues for the named project, saying who asked', async () => {
    const { deps: d, sent } = deps('Switchboard')
    const result = await handoff(d, 'Ledger API', 'The auth header changed.')
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].id).toBe('p2')
    expect(sent[0].text).toContain('Handed over by the Switchboard session')
    expect(sent[0].text).toContain('The auth header changed.')
  })

  it('matches the name case-insensitively, since a model retypes it from memory', async () => {
    const { deps: d, sent } = deps('Switchboard')
    expect((await handoff(d, '  ledger api ', 'x')).ok).toBe(true)
    expect(sent[0].id).toBe('p2')
  })

  it('delivers nothing for an unknown name, and lists what it could have meant', async () => {
    const { deps: d, sent } = deps('Switchboard')
    const result = await handoff(d, 'Ledger', 'x')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Switchboard, Ledger API')
    expect(sent).toHaveLength(0)
  })

  it('refuses the sender its own project, which would be a loop with no way out', async () => {
    const { deps: d, sent } = deps('Switchboard')
    expect((await handoff(d, 'Switchboard', 'x')).ok).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe('starting the receiving session', () => {
  it('starts one when the target has none, and says so', async () => {
    const { deps: d, sent, started } = deps('Switchboard')
    const result = await handoff(d, 'Ledger API', 'x')
    expect(result.ok).toBe(true)
    expect(started).toEqual(['p2'])
    expect(sent).toHaveLength(1)
    expect(result.text).toContain('Started a session for Ledger API')
  })

  it('starts nothing when the target is already running', async () => {
    const { deps: d, started } = deps('Switchboard', { running: ['p2'] })
    const result = await handoff(d, 'Ledger API', 'x')
    expect(started).toEqual([])
    expect(result.text).toContain('already has a session running')
  })

  it('still reports the handover as queued when the start fails, and names the reason', async () => {
    const { deps: d, sent } = deps('Switchboard', { startFails: 'p2' })
    const result = await handoff(d, 'Ledger API', 'x')
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(result.text).toContain('Docker is not running')
  })
})

describe('sessionsReport', () => {
  it('names the running count, marks the sender, and shows queue depth', () => {
    const { deps: d } = deps('Switchboard', { running: ['p1'], queued: { p2: 3 } })
    const text = sessionsReport(d)
    expect(text).toContain('1 of 2 projects have a session running')
    expect(text).toContain('Switchboard (this session): working')
    expect(text).toContain('Ledger API: no session running, 3 queued')
  })

  it('says so plainly when the window has no projects', () => {
    const { deps: d } = deps('Switchboard')
    expect(sessionsReport({ ...d, overview: () => [] })).toContain('No projects are open')
  })
})
