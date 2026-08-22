// Running a Spec Kit command and finding out that it happened.
//
// The dispatch always worked; the section never learned anything afterwards.
// Spec state is read on mount and on a project switch, so a spec scaffolded two
// minutes later, or a plan.md written by /speckit-plan, appeared only when the
// view was next remounted. Both were reported the same way: "create spec is not
// working", and a panel saying "No plan.md content parsed" with an 18KB plan.md
// sitting on disk beside it.
//
// The watch is keyed on the command's own session, which is exact rather than a
// guess: every Spec Kit command takes a session of its own and that session ends
// when its turn ends, so the ending IS the moment the files are final.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpecDetail, SpecKitState } from '@shared/domain'

/** What specs.state and specs.detail answer with, mutated between poll rounds. */
let state: SpecKitState = { installed: true, specs: [] }
let detail: SpecDetail | null = null
/** The dispatched session's fate, as the watch asks for it each round. Null
 *  endedAt means "still running". */
let fate: { endedAt: string | null; endReason: string | null; statusDetail: string | null } | null =
  { endedAt: null, endReason: null, statusDetail: null }
const sent: string[] = []
/** Set by a test that wants to inspect the starting phase before the session
 *  exists; releaseDispatch() then lets the dispatch finish. */
let holdDispatch = false
/** Overrides `fate` for one session, so two commands can end independently. */
let fateBySession: Record<string, typeof fate> = {}
let releaseDispatch: () => void = () => {}

vi.mock('@renderer/ipc', async () => {
  const actual = await vi.importActual<typeof import('@shared/ipc-types')>('@shared/ipc-types')
  return {
    invoke: vi.fn(async (method: string, req: Record<string, unknown>) => {
      if (method === 'specs.state') return state
      if (method === 'specs.detail') return detail
      if (method === 'sessions.fate') return fateBySession[String(req.sessionId)] ?? fate
      if (method === 'specs.runInSession') {
        sent.push(String(req.text))
        // Held open when a test wants to see the window between the click and
        // the session existing, which is its own state on every control.
        if (holdDispatch) await new Promise<void>((resolve) => (releaseDispatch = resolve))
        return { sessionId: `session-${sent.length}` }
      }
      // runInSession refreshes the sidebar after a background dispatch.
      if (method === 'projects.list') return { projects: [], counters: {} }
      return undefined
    }),
    errorMessage: actual.errorMessage,
  }
})

const { useSpecsStore } = await import('@renderer/stores/specs')

const spec = (id: string): SpecKitState['specs'][number] => ({
  id,
  title: id,
  status: 'draft',
  tasksDone: 0,
  tasksTotal: 0,
})

const detailFor = (id: string, plan: { title: string; body: string }[] = []): SpecDetail => ({
  ...spec(id),
  description: '',
  path: `specs/${id}`,
  sections: [],
  plan,
  phases: [],
  clarifications: [],
  resolvedClarifications: [],
})

const ended = { endedAt: '2026-08-22T12:40:00.000Z', endReason: 'done', statusDetail: null }

describe('a Spec Kit command the section is waiting on', () => {
  const specs = useSpecsStore()

  beforeEach(() => {
    vi.useFakeTimers()
    state = { installed: true, specs: [] }
    detail = null
    fate = { endedAt: null, endReason: null, statusDetail: null }
    holdDispatch = false
    fateBySession = {}
    sent.length = 0
    specs.byProject = {}
    specs.selectedSpecId = null
    specs.detail = null
    specs.stopSpecWatch()
  })

  afterEach(() => {
    specs.stopSpecWatch()
    vi.useRealTimers()
  })

  it('dispatches /speckit-specify and says so until the spec lands', async () => {
    await specs.createSpec('p1', 'a feature')
    expect(sent).toEqual(['/speckit-specify a feature'])
    expect(specs.runningLabel('p1')).toBe('Scaffolding the spec')

    // A round with nothing new keeps waiting rather than declaring anything.
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.runningLabel('p1')).toBe('Scaffolding the spec')
    expect(specs.selectedSpecId).toBeNull()

    state = { installed: true, specs: [spec('001-a-feature')] }
    detail = detailFor('001-a-feature')
    await vi.advanceTimersByTimeAsync(3000)

    // Selected the moment it appears, and still watched until the run is over:
    // /speckit-specify writes its checklists after the spec itself.
    expect(specs.selectedSpecId).toBe('001-a-feature')
    expect(specs.runningLabel('p1')).toBe('Scaffolding the spec')

    fate = ended
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.runningLabel('p1')).toBeNull()
    expect(specs.stateFor('p1').specs.map((s) => s.id)).toEqual(['001-a-feature'])
  })

  it('selects a spec that was not already there, not merely a non-empty list', async () => {
    state = { installed: true, specs: [spec('001-old')] }
    detail = detailFor('001-old')
    await specs.loadState('p1')

    await specs.createSpec('p1', 'another feature')
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.selectedSpecId).toBe('001-old') // nothing new has landed yet

    state = { installed: true, specs: [spec('001-old'), spec('002-another-feature')] }
    detail = detailFor('002-another-feature')
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.selectedSpecId).toBe('002-another-feature')
  })

  it('re-reads the selected spec, so a plan written mid-run reaches the panel', async () => {
    state = { installed: true, specs: [spec('001-architecture-world')] }
    detail = detailFor('001-architecture-world')
    await specs.loadState('p1')
    expect(specs.detail?.plan).toEqual([])

    await specs.runSpecCommand(
      'p1',
      '/speckit-plan 001-architecture-world',
      'speckit-plan',
      'Running /speckit-plan',
    )
    expect(sent.at(-1)).toBe('/speckit-plan 001-architecture-world')
    expect(specs.runningLabel('p1')).toBe('Running /speckit-plan')

    // The command writes plan.md and its session ends on the same turn.
    detail = detailFor('001-architecture-world', [{ title: 'Summary', body: 'A visual slice.' }])
    fate = ended
    await vi.advanceTimersByTimeAsync(3000)

    expect(specs.detail?.plan?.map((s) => s.title)).toEqual(['Summary'])
    expect(specs.runningLabel('p1')).toBeNull()
  })

  it('stops when the session is gone, rather than polling a row that will not return', async () => {
    await specs.runSpecCommand('p1', '/speckit-tasks 001-x', 'speckit-tasks', 'Running /speckit-tasks')
    fate = null
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.runningLabel('p1')).toBeNull()
  })

  it('gives up on a session that never ends', async () => {
    await specs.createSpec('p1', 'a feature nothing ever finishes')
    // 2400 rounds at 3s: two hours, the ceiling in the store.
    await vi.advanceTimersByTimeAsync(3000 * 2400)
    expect(specs.runningLabel('p1')).toBeNull()
  })

  it('shows the control as starting before its session exists, then as running', async () => {
    holdDispatch = true
    const dispatched = specs.runSpecCommand(
      'p1',
      '/speckit-clarify 001-x',
      'speckit-clarify',
      'Running /speckit-clarify',
    )
    await Promise.resolve()
    // Starting a session is not instant, and a control that does not change
    // until output arrives reads as a click that missed.
    expect(specs.phaseOf('p1', 'speckit-clarify')).toBe('starting')

    releaseDispatch()
    await dispatched
    expect(specs.phaseOf('p1', 'speckit-clarify')).toBe('running')

    fate = ended
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.phaseOf('p1', 'speckit-clarify')).toBeNull()
  })

  it('leaves a control alone when a different one is dispatched, and clears each on its own session', async () => {
    // The whole reason each command takes a session of its own: two can run at
    // once, so one button's state must not be the other's.
    await specs.runSpecCommand('p1', '/speckit-plan 001-x', 'speckit-plan', 'Running /speckit-plan')
    await specs.runSpecCommand('p1', '/speckit-tasks 001-x', 'speckit-tasks', 'Running /speckit-tasks')
    expect(specs.phaseOf('p1', 'speckit-plan')).toBe('running')
    expect(specs.phaseOf('p1', 'speckit-tasks')).toBe('running')

    // Only the second command's session has ended.
    fateBySession['session-2'] = ended
    await vi.advanceTimersByTimeAsync(3000)
    expect(specs.phaseOf('p1', 'speckit-tasks')).toBeNull()
    expect(specs.phaseOf('p1', 'speckit-plan')).toBe('running')
  })

  it('reports an implement run as the section running, and only that', async () => {
    await specs.runSpecCommand('p1', '/speckit-plan 001-x', 'speckit-plan', 'Running /speckit-plan')
    expect(specs.isRunning('p1')).toBe(false)

    state = { installed: true, specs: [spec('001-x')] }
    detail = detailFor('001-x')
    await specs.startPhase('p1', '001-x', '/speckit-implement-scaffold …', 'implement')
    expect(specs.isRunning('p1')).toBe(true)
  })
})
