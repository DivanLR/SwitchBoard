// Covers the trim added on top of verify-dispatch's prompt: the JSON schema and
// the quality-gathering guidance now describe only the fields a plan actually
// has a chance of measuring (FR-072 read forward — the fix is that the SCHEMA
// itself stops inviting a figure the chosen suites never produce, not just that
// a missing figure reads back as null). schemaFlags/buildSchema/qualitySection
// are not exported, so the property is read off verifyPrompt's own text, which
// is the only thing the session ever sees.
import { describe, expect, it } from 'vitest'
import { stackById } from '@shared/test-catalog'
import { parseVerifyReport, planSuites, verifyPrompt } from '@main/evals/verify-dispatch'

const dotnet = stackById('dotnet')!
const node = stackById('node')!

describe('trimming the schema to what the plan can actually measure', () => {
  it('asks for none of coverage, quality gate, mutation or endpoints on a plan of unit suites alone', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit'], null)
    const prompt = verifyPrompt(plan, '.NET', null)

    expect(prompt).not.toContain('"coverage"')
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('mutationKilled')
    expect(prompt).not.toContain('mutationSurvived')
    expect(prompt).not.toContain('"mutation"')
    expect(prompt).not.toContain('"endpoints"')
    expect(prompt).not.toContain('Then gather the quality figures')
  })

  it('asks for coverage fields, in the schema and the guidance, once a coverage suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-coverage'], null)
    const prompt = verifyPrompt(plan, '.NET', null)

    expect(prompt).toContain('"coverage"')
    expect(prompt).toContain('"line"')
    expect(prompt).toContain('"changed"')
    expect(prompt).toContain('Coverage: read the coverage report')
    // Nothing else this plan has no suite for.
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('mutationKilled')
    expect(prompt).not.toContain('"endpoints"')
  })

  it('asks for the quality gate block, in the schema and the guidance, once a quality suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-arch'], null)
    const prompt = verifyPrompt(plan, '.NET', null)

    expect(prompt).toContain('"gate"')
    expect(prompt).toContain('"duplication"')
    expect(prompt).toContain('"debt"')
    expect(prompt).toContain('"archViolations"')
    expect(prompt).toContain('Code quality: if a SonarQube')
    // Still nothing this plan cannot produce.
    expect(prompt).not.toContain('"coverage"')
    expect(prompt).not.toContain('mutationKilled')
    expect(prompt).not.toContain('"endpoints"')
  })

  it('asks for the mutation fields, in the schema and the guidance, once a mutation suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-mutation'], null)
    const prompt = verifyPrompt(plan, '.NET', null)

    expect(prompt).toContain('"mutation"')
    expect(prompt).toContain('mutationKilled')
    expect(prompt).toContain('mutationSurvived')
    expect(prompt).toContain('"survivors"')
    expect(prompt).toContain("Mutation: read the mutation tool's own report")
    // A mutation-only plan has no SonarQube-style suite, so the gate fields stay out.
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('"coverage"')
  })

  it('asks for endpoints, in the schema, once an api suite is planned', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-http'], null)
    const prompt = verifyPrompt(plan, '.NET', null)

    expect(prompt).toContain('"endpoints"')
    expect(prompt).not.toContain('"coverage"')
    expect(prompt).not.toContain('"gate"')
    expect(prompt).not.toContain('mutationKilled')
  })

  it('asks for every block at once when the plan carries all four kinds', () => {
    const plan = planSuites(
      dotnet.suites,
      ['dotnet-unit', 'dotnet-coverage', 'dotnet-arch', 'dotnet-mutation', 'dotnet-http'],
      null,
    )
    const prompt = verifyPrompt(plan, '.NET', null)

    expect(prompt).toContain('"coverage"')
    expect(prompt).toContain('"gate"')
    expect(prompt).toContain('mutationKilled')
    expect(prompt).toContain('"endpoints"')
  })

  // NOTE (see test-file report to caller): this is the exact scenario the file's
  // own comment above SchemaFlags names as the motivating case — "a typical
  // unit+lint run ... was sending a schema for ... a SonarQube gate ... it would
  // never have". But `dotnet-format`/`node-types` ("Types and lint", one plain
  // `tsc && eslint` command) are filed under SuiteKind 'quality', the same kind
  // used for an actual SonarQube-backed suite, and schemaFlags keys off the kind
  // alone. So a lint-only plan — no coverage, no mutation, no api suite, nothing
  // that could produce a gate — still pulls in the whole gate/duplication/debt/
  // archViolations/findings block, i.e. the schema still describes a figure this
  // plan has no way to produce. (qualitySection does hedge the wording with
  // "not_configured"/null, so the model is never told to fabricate one — but the
  // schema is not trimmed the way the header comment says it now is.) Encoding
  // CURRENT behaviour here, not the narrower one the comment describes.
  it('a lint-only plan still pulls in the quality-gate block, because "quality" kind covers plain lint too', () => {
    const dotnetPlan = planSuites(dotnet.suites, ['dotnet-format'], null)
    expect(verifyPrompt(dotnetPlan, '.NET', null)).toContain('"gate"')

    const nodePlan = planSuites(node.suites, ['node-unit', 'node-types'], null)
    const nodePrompt = verifyPrompt(nodePlan, 'Node', null)
    expect(nodePrompt).toContain('"gate"')
    // The rest of the trim still holds on this same plan.
    expect(nodePrompt).not.toContain('"coverage"')
    expect(nodePrompt).not.toContain('"endpoints"')
    expect(nodePrompt).not.toContain('mutationKilled')
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
    // Math.trunc(-3.7) is -3, not -4 — worth pinning since a count going negative
    // at all would already be a sign the model invented a figure.
    const report = parseVerifyReport(line('{"suites":[],"quality":{"mutationKilled":-3.7}}'))
    expect(report?.quality.mutationKilled).toBe(-3)
  })

  it('reads a numeric string the same way a bare number is read, percent sign and all', () => {
    // num() strips a trailing "%" and parses with parseFloat — the same tolerance
    // every other figure in this file gets, so a model that quotes a count as a
    // string is not penalised for it.
    const report = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":"87","mutationSurvived":"12.6%"}}'),
    )
    expect(report?.quality.mutationKilled).toBe(87)
    expect(report?.quality.mutationSurvived).toBe(12)
  })

  it('turns null, missing, NaN, Infinity and a non-numeric string into null rather than 0', () => {
    // A silent 0 here would read as "every mutant survived" or "none were killed"
    // — the opposite of "nothing measured it". Each of these must stay null.
    const nullField = parseVerifyReport(
      line('{"suites":[],"quality":{"mutationKilled":null,"mutationSurvived":9}}'),
    )
    expect(nullField?.quality.mutationKilled).toBeNull()

    const missingField = parseVerifyReport(line('{"suites":[],"quality":{"mutationSurvived":9}}'))
    expect(missingField?.quality.mutationKilled).toBeNull()

    // A bare NaN is not valid JSON at all, so the only way the session's own
    // output produces one is quoted — parseFloat("NaN") is itself NaN, which
    // num() must also reject.
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
