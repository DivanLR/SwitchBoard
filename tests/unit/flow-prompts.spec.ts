import { describe, expect, it } from 'vitest'
import {
  buildSteps,
  cleanSteps,
  reviewSteps,
  shipPrompt,
  testWritePrompt,
} from '@main/flow/flow-prompts'

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
