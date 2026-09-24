import { describe, expect, it } from 'vitest'
import { commandSource, flowModeNote, flowStagePlan, missingCommands, slashCommandOf } from '@shared/flow-plan'
import {
  bugAssessPrompt,
  bugFixPrompt,
  bugTestPrompt,
  buildSteps,
  checklistSteps,
  cleanSteps,
  clarifyPrompt,
  constitutionPrompt,
  convergePrompt,
  ideaPrompt,
  planSteps,
  reviewSteps,
  specifyPrompt,
} from '@main/flow/flow-prompts'

function namesOf(steps: readonly string[]): string[] {
  return steps.flatMap((step) => slashCommandOf(step) ?? [])
}

const sddRun = { slug: 'x', autopilot: false, title: 'Login times out', description: 'It hangs.' }

describe('flowStagePlan against the real prompt builders', () => {
  it('matches the spec stage in both constitution cases', () => {
    const run = { source: 'text' as const, sourceRef: null, sourceUrl: null, title: 'Checkout v2', description: '', autopilot: false }
    const planCommands = flowStagePlan('feature', 'spec', [], false).commands
    expect(planCommands.filter((c) => !c.only).map((c) => c.name)).toEqual(
      namesOf([specifyPrompt(run), clarifyPrompt(false)]),
    )
    expect(planCommands.map((c) => c.name)).toEqual(
      namesOf([constitutionPrompt(false), specifyPrompt(run), clarifyPrompt(false)]),
    )
  })

  it('matches the plan stage, with and without the checklist gate', () => {
    expect(flowStagePlan('feature', 'plan', ['dotnet'], false).commands.map((c) => c.name)).toEqual(
      namesOf(planSteps(['dotnet'], 'specs/001-x')),
    )
    expect(flowStagePlan('feature', 'plan', ['dotnet'], true).commands.map((c) => c.name)).toEqual(
      namesOf([...planSteps(['dotnet'], 'specs/001-x'), ...checklistSteps('specs/001-x', false)]),
    )
  })

  it('matches the build stage (scaffold and/or implement, then converge) for every stack combination', () => {
    for (const stacks of [['dotnet'], ['angular'], ['dotnet', 'angular']]) {
      expect(flowStagePlan('feature', 'build', stacks).commands.map((c) => c.name)).toEqual(
        namesOf([...buildSteps(stacks, 'specs/001-x'), convergePrompt('specs/001-x')]),
      )
    }
  })

  it('matches the clean stage for every stack combination', () => {
    for (const stacks of [['dotnet'], ['angular'], ['dotnet', 'angular']]) {
      expect(flowStagePlan('feature', 'clean', stacks).commands.map((c) => c.name)).toEqual(
        namesOf(cleanSteps(stacks, 'main')),
      )
    }
  })

  it('matches the review stage, empty for angular-only since no review skill runs there', () => {
    for (const stacks of [['dotnet'], ['angular'], ['dotnet', 'angular']]) {
      expect(flowStagePlan('feature', 'review', stacks).commands.map((c) => c.name)).toEqual(
        namesOf(reviewSteps(stacks, 'main')),
      )
    }
    expect(flowStagePlan('feature', 'review', ['angular']).commands).toEqual([])
  })

  it('sends nothing but the handshake at Ship', () => {
    expect(flowStagePlan('feature', 'ship', ['dotnet']).commands).toEqual([])
  })

  it('matches every bug stage', () => {
    expect(flowStagePlan('bug', 'assess', []).commands.map((c) => c.name)).toEqual(namesOf([bugAssessPrompt(sddRun)]))
    expect(flowStagePlan('bug', 'fix', ['dotnet']).commands.map((c) => c.name)).toEqual(
      namesOf([bugFixPrompt(sddRun, ['dotnet'])]),
    )
    expect(flowStagePlan('bug', 'test', []).commands.map((c) => c.name)).toEqual(namesOf([bugTestPrompt(sddRun)]))
  })

  it('matches every idea stage', () => {
    for (const stage of ['intake', 'research', 'define', 'shape', 'decide'] as const) {
      expect(flowStagePlan('idea', stage, []).commands.map((c) => c.name)).toEqual(
        namesOf([ideaPrompt(stage, sddRun)]),
      )
    }
  })
})

describe('missingCommands', () => {
  it('reports every needed command missing when the available list is confirmed empty', () => {
    expect(missingCommands(['speckit-specify'], [])).toEqual(['speckit-specify'])
  })

  it('finds an exact name or a name behind a plugin: prefix, and nothing else', () => {
    expect(missingCommands(['speckit-specify', 'speckit-clarify'], ['speckit-specify'])).toEqual(['speckit-clarify'])
    expect(missingCommands(['speckit-specify'], ['speckit:speckit-specify'])).toEqual([])
    expect(missingCommands(['speckit-specify'], ['other:speckit-specify-extra'])).toEqual(['speckit-specify'])
  })

  it('de-duplicates repeated needed commands', () => {
    expect(missingCommands(['speckit-plan', 'speckit-plan'], ['x'])).toEqual(['speckit-plan'])
  })
})

describe('commandSource', () => {
  it('names the source for each command family', () => {
    expect(commandSource('dotnet-claude-kit:code-review')).toContain('dotnet-claude-kit plugin')
    expect(commandSource('ponytail:ponytail-review')).toBe('the ponytail plugin')
    expect(commandSource('speckit-implement-scaffold')).toContain('scaffold-implementer agent')
    expect(commandSource('speckit-bug-fix')).toContain('Spec Kit bug extension')
    expect(commandSource('speckit-assess-intake')).toContain('Spec Kit assess extension')
    expect(commandSource('speckit-specify')).toContain('Spec Kit skills')
    expect(commandSource('mystery-thing')).toBe('a Claude Code plugin or skill')
  })
})

describe('flowModeNote', () => {
  it('floors plan mode to accept edits whatever autopilot is set to', () => {
    expect(flowModeNote('plan', false)).toContain('accept edits')
    expect(flowModeNote('plan', true)).toContain('accept edits')
  })

  it('says nothing when autopilot is off, or the mode is already Auto', () => {
    expect(flowModeNote('default', false)).toBeNull()
    expect(flowModeNote('dontAsk', false)).toBeNull()
    expect(flowModeNote('auto', true)).toBeNull()
  })

  it('names why each mode short of Auto defeats an unattended autopilot run', () => {
    expect(flowModeNote('default', true)).toContain('asks you before each command')
    expect(flowModeNote('dontAsk', true)).toContain('refuses each command')
    expect(flowModeNote('acceptEdits', true)).toContain('approves file edits only')
    expect(flowModeNote('bypass', true)).toContain('approves file edits only')
  })
})
