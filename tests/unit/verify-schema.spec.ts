import { describe, expect, it } from 'vitest'
import { stackById } from '@shared/test-catalog'
import { parseVerifyReport, planSuites, verifyPrompt } from '@main/verify/verify-dispatch'

const dotnet = stackById('dotnet')!
const angular = stackById('angular')!

describe('trimming the schema to what the plan can actually measure', () => {
  it('asks for none of coverage, quality gate, mutation or endpoints on a plan of unit suites alone', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit'])
    const prompt = verifyPrompt(plan, '.NET')

    expect(prompt).not.toContain('"coverage"')
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('mutationKilled')
    expect(prompt).not.toContain('mutationSurvived')
    expect(prompt).not.toContain('"mutation"')
    expect(prompt).not.toContain('"endpoints"')
    expect(prompt).not.toContain('Then gather the quality figures')
  })

  it('asks for coverage fields, in the schema and the guidance, once a coverage suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-coverage'])
    const prompt = verifyPrompt(plan, '.NET')

    expect(prompt).toContain('"coverage"')
    expect(prompt).toContain('"line"')
    expect(prompt).toContain('"changed"')
    expect(prompt).toContain('Coverage: read the coverage report')
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('mutationKilled')
    expect(prompt).not.toContain('"endpoints"')
  })

  it('asks for the quality gate block, in the schema and the guidance, once a quality suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-arch'])
    const prompt = verifyPrompt(plan, '.NET')

    expect(prompt).toContain('"gate"')
    expect(prompt).toContain('"duplication"')
    expect(prompt).toContain('"debt"')
    expect(prompt).toContain('"archViolations"')
    expect(prompt).toContain('Code quality: if a SonarQube')
    expect(prompt).not.toContain('"coverage"')
    expect(prompt).not.toContain('mutationKilled')
    expect(prompt).not.toContain('"endpoints"')
  })

  it('asks for the mutation fields, in the schema and the guidance, once a mutation suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-mutation'])
    const prompt = verifyPrompt(plan, '.NET')

    expect(prompt).toContain('"mutation"')
    expect(prompt).toContain('mutationKilled')
    expect(prompt).toContain('mutationSurvived')
    expect(prompt).toContain('"survivors"')
    expect(prompt).toContain("Mutation: read the mutation tool's own report")
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('"coverage"')
  })

  it('asks for endpoints, in the schema, once an api suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-http'])
    const prompt = verifyPrompt(plan, '.NET')

    expect(prompt).toContain('"endpoints"')
    expect(prompt).not.toContain('"coverage"')
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('mutationKilled')
  })

  it('asks for every block at once when the plan carries all four kinds', () => {
    const plan = planSuites(dotnet.suites, [
      'dotnet-unit',
      'dotnet-coverage',
      'dotnet-arch',
      'dotnet-mutation',
      'dotnet-http',
    ])
    const prompt = verifyPrompt(plan, '.NET')

    expect(prompt).toContain('"coverage"')
    expect(prompt).toContain('"gate"')
    expect(prompt).toContain('mutationKilled')
    expect(prompt).toContain('"endpoints"')
  })

  it('a lint-only plan still pulls in the quality-gate block, because "quality" kind covers plain lint too', () => {
    const dotnetPlan = planSuites(dotnet.suites, ['dotnet-format'])
    expect(verifyPrompt(dotnetPlan, '.NET')).toContain('"gate"')

    const angularPlan = planSuites(angular.suites, ['ng-unit', 'ng-lint'])
    const angularPrompt = verifyPrompt(angularPlan, 'Angular')
    expect(angularPrompt).toContain('"gate"')
    expect(angularPrompt).not.toContain('"coverage"')
    expect(angularPrompt).not.toContain('"endpoints"')
    expect(angularPrompt).not.toContain('mutationKilled')
  })
})

describe('normalizeReport truncates the new mutation counts, and never lets one read as zero', () => {
  const line = (json: string): string => `Ran everything.\n\nSWB_VERIFY: ${json}`

  it('truncates a decimal count down to an integer, same as Math.trunc', () => {
    const report = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":41.9,"mutationSurvived":3.2}}'),
    )
    expect(report?.quality.mutationKilled).toBe(41)
    expect(report?.quality.mutationSurvived).toBe(3)
  })

  it('truncates toward zero, not down, for a negative decimal', () => {
    const report = parseVerifyReport(line('{"suites":[],"quality":{"mutationKilled":-3.7}}'))
    expect(report?.quality.mutationKilled).toBe(-3)
  })

  it('reads a numeric string the same way a bare number is read, percent sign and all', () => {
    const report = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":"87","mutationSurvived":"12.6%"}}'),
    )
    expect(report?.quality.mutationKilled).toBe(87)
    expect(report?.quality.mutationSurvived).toBe(12)
  })

  it('turns null, missing, NaN, Infinity and a non-numeric string into null rather than 0', () => {
    const nullField = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":null,"mutationSurvived":9}}'),
    )
    expect(nullField?.quality.mutationKilled).toBeNull()

    const missingField = parseVerifyReport(line('{"suites":[],"quality":{"mutationSurvived":9}}'))
    expect(missingField?.quality.mutationKilled).toBeNull()

    const nanField = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":"NaN","mutationSurvived":9}}'),
    )
    expect(nanField?.quality.mutationKilled).toBeNull()

    const infinityField = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":1e999,"mutationSurvived":9}}'),
    )
    expect(infinityField?.quality.mutationKilled).toBeNull()

    const wordField = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":"none","mutationSurvived":9}}'),
    )
    expect(wordField?.quality.mutationKilled).toBeNull()
  })

  it('leaves both counts null when the quality object is absent entirely', () => {
    const report = parseVerifyReport(line('{"suites":[]}'))
    expect(report?.quality.mutationKilled).toBeNull()
    expect(report?.quality.mutationSurvived).toBeNull()
  })
})
