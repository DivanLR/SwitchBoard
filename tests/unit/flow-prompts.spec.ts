import { describe, expect, it } from 'vitest'
import {
  buildSteps,
  cleanSteps,
  fixFindingsPrompt,
  reviewSteps,
  revisePrompt,
  shipPrompt,
  testWritePrompt,
} from '@main/flow/flow-prompts'

describe('the fix prompt, sent to a fresh session', () => {
  const report = {
    findings: [
      { severity: 'must_fix' as const, file: 'Cart.cs', line: 12, what: 'Off-by-one in the total.' },
      { severity: 'must_fix' as const, file: null, line: null, what: 'No test covers the empty cart.' },
      { severity: 'should_fix' as const, file: 'Cart.cs', line: 40, what: 'Extract the rounding.' },
    ],
    unmet: ['A guest can pay without an account.'],
  }

  it('carries every must_fix finding with its location and every unmet criterion', () => {
    const prompt = fixFindingsPrompt(report, { baseBranch: 'develop', specDir: 'specs/002-cart' })
    expect(prompt).toContain('against develop')
    expect(prompt).toContain('- Cart.cs:12: Off-by-one in the total.')
    expect(prompt).toContain('- No test covers the empty cart.')
    expect(prompt).toContain('- A guest can pay without an account.')
    expect(prompt).toContain('specs/002-cart/spec.md')
    expect(prompt).not.toContain('Extract the rounding.')
  })

  it('still reads on its own without a stored report', () => {
    expect(fixFindingsPrompt(null, { baseBranch: null, specDir: null })).toContain('the base branch')
  })
})

describe('the revise prompt, sent to a fresh session', () => {
  const run = { specDir: 'specs/002-cart', prUrl: 'https://dev.azure.com/x/_git/y/pullrequest/9', baseBranch: 'main' }

  it('names the artefact file and the feedback', () => {
    const prompt = revisePrompt(run, 'plan', 'Split the migration into its own task.')
    expect(prompt).toContain('Revise the plan and its tasks (specs/002-cart/plan.md) per this feedback')
    expect(prompt).toContain('Split the migration into its own task.')
  })

  it('points a stage without an artefact file at the spec and the base branch', () => {
    const prompt = revisePrompt(run, 'build', 'Use the existing money type.')
    expect(prompt).toContain('the implementation on this branch')
    expect(prompt).toContain('specs/002-cart/spec.md')
    expect(prompt).toContain('against main')
  })

  it('names the pull request for the ship stage', () => {
    expect(revisePrompt(run, 'ship', 'Mention the migration.')).toContain(run.prUrl)
  })
})

describe('the build steps', () => {
  it('scaffolds .NET only for a dotnet-only run', () => {
    expect(buildSteps(['dotnet'])).toEqual(['/speckit-implement-scaffold'])
  })

  it('implements everything for an angular-only run', () => {
    expect(buildSteps(['angular'])).toEqual(['/speckit-implement'])
  })

  it('scaffolds .NET then finishes the remaining tasks for a mixed run', () => {
    expect(buildSteps(['dotnet', 'angular'])).toEqual([
      '/speckit-implement-scaffold',
      '/speckit-implement Complete every task still unchecked in tasks.md.',
    ])
  })
})

describe('the clean steps', () => {
  it('runs de-sloppify before ponytail for .NET', () => {
    const steps = cleanSteps(['dotnet'], 'main')
    expect(steps[0]).toContain('/dotnet-claude-kit:de-sloppify')
    expect(steps[0]).toContain('against main')
    expect(steps[1]).toContain('/ponytail:ponytail-review')
    expect(steps[1]).not.toContain('lint')
  })

  it('has no de-sloppify step for angular-only, and asks for lint --fix', () => {
    const steps = cleanSteps(['angular'], 'develop')
    expect(steps).toHaveLength(1)
    expect(steps[0]).toContain('/ponytail:ponytail-review')
    expect(steps[0]).toContain('against develop')
    expect(steps[0]).toContain("lint script with --fix")
  })

  it('runs both for a mixed run', () => {
    const steps = cleanSteps(['dotnet', 'angular'], 'main')
    expect(steps).toHaveLength(2)
    expect(steps[1]).toContain('lint script with --fix')
  })
})

describe('the test-writing prompt', () => {
  it('mentions only the stack sections that apply', () => {
    const dotnetOnly = testWritePrompt({ specDir: 'specs/1-x' }, ['dotnet'])
    expect(dotnetOnly).toContain('xUnit')
    expect(dotnetOnly).not.toContain('Karma/Jasmine')

    const angularOnly = testWritePrompt({ specDir: 'specs/1-x' }, ['angular'])
    expect(angularOnly).toContain('Karma/Jasmine')
    expect(angularOnly).not.toContain('xUnit')
  })

  it('always covers the API/Postman case, pointed at the spec folder', () => {
    const prompt = testWritePrompt({ specDir: 'specs/2-cart' }, ['dotnet'])
    expect(prompt).toContain('specs/2-cart/postman')
    expect(prompt).toContain('postman_collection.json')
  })
})

describe('the review steps', () => {
  it('runs the dotnet-claude-kit code review and security scan for .NET', () => {
    const steps = reviewSteps(['dotnet'], 'main')
    expect(steps).toEqual([
      '/dotnet-claude-kit:code-review Review the changes on this branch against main.',
      '/dotnet-claude-kit:security-scan Scope: the changes on this branch against main.',
    ])
  })

  it('has no dotnet-specific steps for angular-only, leaving it to the handshake turn', () => {
    expect(reviewSteps(['angular'], 'main')).toEqual([])
  })
})

describe('the ship prompt', () => {
  it('links the Azure DevOps work item when the source was ado', () => {
    const prompt = shipPrompt({
      title: 'Checkout v2',
      branch: 'feature/checkout-v2',
      baseBranch: 'main',
      source: 'ado',
      sourceRef: '4711',
    })
    expect(prompt).toContain('link Azure DevOps work item 4711')
    expect(prompt).toContain('Do not merge, approve, or add reviewers.')
  })

  it('never mentions a work item for a text source', () => {
    const prompt = shipPrompt({
      title: 'Checkout v2',
      branch: 'feature/checkout-v2',
      baseBranch: 'main',
      source: 'text',
      sourceRef: null,
    })
    expect(prompt).not.toContain('link Azure DevOps work item')
  })
})
