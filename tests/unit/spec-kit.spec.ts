// Spec Kit detection and markdown parsing.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSpecKitInstalled, readSpecKitState, readSpecDetail } from '@main/specs/spec-kit'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'speckit-'))
  dirs.push(d)
  return d
}

describe('isSpecKitInstalled', () => {
  it('is false without .specify, true with it', () => {
    const p = makeProject()
    expect(isSpecKitInstalled(p)).toBe(false)
    mkdirSync(join(p, '.specify'))
    expect(isSpecKitInstalled(p)).toBe(true)
  })
})

describe('readSpecKitState + readSpecDetail', () => {
  it('lists specs and parses title, tasks, sections, clarifications', () => {
    const p = makeProject()
    mkdirSync(join(p, '.specify'))
    const specDir = join(p, 'specs', '001-feature-x')
    mkdirSync(specDir, { recursive: true })
    writeFileSync(
      join(specDir, 'spec.md'),
      [
        '# Feature Specification: Feature X',
        '',
        '## Summary',
        'Does the X thing for users.',
        '',
        '## Requirements',
        '- FR-001: MUST do X [NEEDS CLARIFICATION: which X?]',
        '',
        '## Assumptions',
        'None.',
      ].join('\n'),
    )
    writeFileSync(
      join(specDir, 'tasks.md'),
      [
        '# Tasks',
        '',
        '## Phase 1: Setup',
        '- [X] T001 Init the scaffold',
        '- [ ] T002 Configure tooling',
        '',
        '## Phase 2: Build',
        '- [ ] T003 Implement the handler',
      ].join('\n'),
    )

    const state = readSpecKitState(p)
    expect(state.installed).toBe(true)
    expect(state.specs).toHaveLength(1)
    expect(state.specs[0].title).toBe('Feature X')
    expect(state.specs[0].tasksTotal).toBe(3)
    expect(state.specs[0].tasksDone).toBe(1)
    expect(state.specs[0].status).toBe('in_progress')

    const detail = readSpecDetail(p, '001-feature-x')
    expect(detail).not.toBeNull()
    expect(detail!.description).toContain('Does the X thing')
    expect(detail!.sections.map((s) => s.title)).toEqual(['Summary', 'Requirements', 'Assumptions'])
    expect(detail!.phases).toHaveLength(2)
    expect(detail!.phases[0].label).toContain('Phase 1')
    expect(detail!.phases[0].tasks[0]).toMatchObject({ id: 'T001', done: true })
    expect(detail!.phases[0].tasks[1]).toMatchObject({ id: 'T002', done: false })
    expect(detail!.clarifications).toEqual(['which X?'])
  })

  it('reports complete when all tasks are done', () => {
    const p = makeProject()
    mkdirSync(join(p, '.specify'))
    const specDir = join(p, 'specs', '002-done')
    mkdirSync(specDir, { recursive: true })
    writeFileSync(join(specDir, 'spec.md'), '# Feature Specification: Done Feature\n')
    writeFileSync(join(specDir, 'tasks.md'), '## Phase 1\n- [X] T001 A\n- [x] T002 B\n')
    const state = readSpecKitState(p)
    expect(state.specs[0].status).toBe('complete')
    expect(state.specs[0].tasksDone).toBe(2)
  })

  it('returns empty state when specs/ is absent', () => {
    const p = makeProject()
    mkdirSync(join(p, '.specify'))
    const state = readSpecKitState(p)
    expect(state.installed).toBe(true)
    expect(state.specs).toEqual([])
  })
})
