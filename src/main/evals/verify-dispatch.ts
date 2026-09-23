import {
  emptyVerifyReport,
  type EndpointResult,
  type EvidenceItem,
  type Measured,
  type SuiteResult,
  type SuiteStatus,
  type VerifyReport,
} from '@shared/domain'
import type { TestSuite } from '@shared/test-catalog'
import { firstJsonObject, markerTail, str } from './parse'

export const VERIFY_MARKER = 'SWB_VERIFY'

const SUITE_MARKER = 'SWB_SUITE'

export interface PlannedSuite {
  suite: TestSuite
}

export function planSuites(suites: readonly TestSuite[], chosen: readonly string[]): PlannedSuite[] {
  return suites.filter((s) => chosen.includes(s.id)).map((suite) => ({ suite }))
}

interface SchemaFlags {
  coverage: boolean
  quality: boolean
  mutation: boolean
  endpoints: boolean
}

function schemaFlags(runnable: PlannedSuite[], hasEndpoints: boolean): SchemaFlags {
  return {
    coverage: runnable.some((p) => p.suite.kind === 'coverage'),
    quality: runnable.some((p) => p.suite.kind === 'quality'),
    mutation: runnable.some((p) => p.suite.kind === 'mutation'),
    endpoints: hasEndpoints,
  }
}

function buildSchema(flags: SchemaFlags): string {
  const blocks = [
    '"suites": [{"id": "<suite id>", "status": "pass|fail|skipped|not_run", "detail": "<one line: counts, or the first failure>"}]',
  ]
  if (flags.coverage) {
    blocks.push(
      '"coverage": {\n' +
        '    "line": {"value": <percent 0-100 or null>, "source": "<the command or report file you read>"},\n' +
        '    "changed": {"value": <percent of CHANGED lines covered, or null>, "source": "<...>"},\n' +
        '    "files": [{"path": "<file you touched>", "pct": <percent covered>}]\n' +
        '  }',
    )
  }
  if (flags.quality || flags.mutation) {
    const fields: string[] = []
    if (flags.quality) {
      fields.push(
        '"gate": "pass|fail|not_configured", "gateSource": "<e.g. sonarqube>"',
        '"duplication": {"value": <percent duplicated lines or null>, "source": "<...>"}',
        '"debt": "<the service\'s own debt figure, e.g. 2d 4h, or null>"',
        '"archViolations": {"value": <count or null>, "source": "<...>"}',
        '"findings": ["<named rule violation, worst first>"]',
      )
    }
    if (flags.mutation) {
      fields.push(
        '"mutation": {"value": <percent mutants killed or null>, "source": "<...>"}',
        '"mutationKilled": <count of killed + timeout mutants, or null>',
        '"mutationSurvived": <count of survived + no-coverage mutants, or null>',
        '"survivors": ["<surviving mutant that matters, file:line - what it changed, worst first>"]',
      )
    }
    blocks.push(`"quality": {\n    ${fields.join(',\n    ')}\n  }`)
  }
  if (flags.endpoints) {
    blocks.push(
      '"endpoints": [{\n' +
        '    "method": "GET|POST|PUT|PATCH|DELETE",\n' +
        '    "path": "<the path you actually called, with REAL values substituted>",\n' +
        '    "status": <HTTP status you actually received, or null if the call never completed>,\n' +
        '    "ms": <round-trip milliseconds, or null>,\n' +
        '    "response": "<the response body, truncated to something readable>",\n' +
        '    "dataSource": "<the MCP server the real data came from, or null>",\n' +
        '    "dataQuery": "<the query you ran to get it, verbatim, or null>",\n' +
        '    "dataAssertion": "<what the data proved, e.g. \'customer 4417 has 3 contracts; response listed 3\'>",\n' +
        '    "outcome": "pass|fail|not_run",\n' +
        '    "detail": "<why it failed, or what you could not check>"\n' +
        '  }]',
    )
  }
  return `{\n  ${blocks.join(',\n  ')}\n}`
}

export const HONESTY =
  'Every number must come from output you actually ran or a report file you actually read. ' +
  'If you did not measure something, put null and leave its source null — a guessed, ' +
  'estimated or "typical" figure is far worse than no figure. Never mark a suite pass ' +
  'because it probably would.'

function endpointSection(apiSuites: PlannedSuite[], dbServers: readonly string[]): string {
  if (apiSuites.length === 0) return ''
  const named = dbServers.length > 0
  return (
    `\n\nThis is what ${apiSuites.map((p) => p.suite.id).join(' and ')} above means in full, ` +
    'and it is the part not to skip. Do it even if an earlier suite failed: a formatting or ' +
    'coverage failure says nothing about whether the API answers, and a suite can go green ' +
    'against fixtures while every real request fails. Report each call in "endpoints".\n' +
    (named
      ? `- Get your inputs from the connected database MCP server(s): ${dbServers.join(', ')}. ` +
        'Query for identifiers that actually exist — a customer id, an account number, a ' +
        'contract — and call the endpoints with THOSE. Record the query you ran verbatim in ' +
        '"dataQuery" and the server in "dataSource".\n' +
        '- Read the schema through that server before you query it, and write SQL in ITS ' +
        'dialect. Do not guess a table or column name from the C# entity names, and do not ' +
        'assume the syntax of a different engine — an Oracle server does not take LIMIT, and a ' +
        'guessed table name fails in a way that looks like the API is broken when it is not. ' +
        'If a query errors, say so in "detail" and set "outcome" to "not_run" rather than ' +
        'reporting a call you never made.\n' +
        '- Where the endpoint is served by EF Core — a LINQ query over a DbContext rather than a ' +
        'stored procedure — reproduce that query as SQL through the same server and compare its ' +
        'rows with the response. That is the strongest check available on that path, and it is ' +
        'only available there: do not try to reproduce a stored procedure as SQL.\n' +
        '- Then check the response back against the data. Read the row counts or field values ' +
        'from the database and say in "dataAssertion" what they proved, e.g. "customer 4417 ' +
        'has 3 contracts; the response listed 3". An endpoint that answers 200 with an empty ' +
        'body because it was called with an id that does not exist is a FAIL, not a pass: ' +
        'that is exactly what querying first is for.\n'
      : '- No database MCP server is connected for this project, so you have no source of ' +
        'real identifiers. Still call the endpoints, using whatever the project itself ' +
        'provides (a seed script, an .http file, appsettings), and set "dataSource" and ' +
        '"dataQuery" to null so it is clear the inputs were not drawn from real data.\n') +
    '- Start the API yourself if it is not already running, and shut it down afterwards.\n' +
    '- Cover the endpoints this working tree touched first, then the main read paths. ' +
    'Include at least one case that SHOULD fail (a missing id, absent auth) and report what ' +
    'it actually returned — an API that returns 200 for a deleted record is the kind of ' +
    'thing only a real call finds.\n' +
    '- Record the real status, the round-trip time, and enough of the body to be useful. ' +
    'Never write a status you did not receive: if the call did not complete, status is null ' +
    'and outcome is "not_run" with the reason in "detail".\n' +
    '- Do NOT mutate real data unless the endpoint under test is a write and the project ' +
    'clearly points at a test database. If in doubt, exercise reads and say so in "detail".\n'
  )
}

function qualitySection(flags: SchemaFlags): string {
  const lines: string[] = []
  if (flags.coverage) {
    lines.push(
      '- Coverage: read the coverage report the run produced (cobertura/lcov/json) and give ' +
        'total line coverage, coverage of the lines this working tree changed (compare against ' +
        'git diff), and the touched files with the least coverage.',
    )
  }
  if (flags.quality) {
    lines.push(
      '- Code quality: if a SonarQube or SonarCloud MCP server is connected for this project, ' +
        'read its quality gate, duplication, technical debt and issue counts through it and name ' +
        'it as the source. If no such server is connected, set "gate" to "not_configured" and ' +
        'leave the figures null — do not substitute a lint count for it. Architecture violations ' +
        'come only from an architecture suite above that actually produced them.',
    )
  }
  if (flags.mutation) {
    lines.push(
      "- Mutation: read the mutation tool's own report (Stryker's mutation-report.json, or the " +
        "equivalent for this stack) rather than typing a remembered figure. Give the score, how " +
        'many mutants were killed versus survived, and the surviving mutants worth a look, worst ' +
        'first.',
      '- Running Stryker: it must be started from a directory holding a TEST project, not from ' +
        'the repository root — at the root it finds nothing to mutate. If that test project ' +
        'references more than one project, Stryker refuses until told which to mutate: pass ' +
        '--project <the csproj it names>. It lists the candidates in the refusal, so read them ' +
        'and pick the one under test rather than guessing.',
    )
  }
  return lines.length === 0 ? '' : `\n\nThen gather the quality figures, without re-running the tests:\n${lines.join('\n')}\n`
}

export function verifyPrompt(
  plan: PlannedSuite[],
  stackLabel: string,
  dbServers: readonly string[] = [],
): string {
  const apiSuites = plan.filter((p) => p.suite.kind === 'api')
  const flags = schemaFlags(plan, apiSuites.length > 0)
  return (
    `Verify the working tree of this ${stackLabel} project. This is a verification pass: ` +
    'run things and report what happened. Do not fix anything and do not edit any file.\n\n' +
    'Run these in order, and STOP at the first one that fails:\n' +
    plan
      .map((p) =>
        p.suite.mcp
          ? `- ${p.suite.id} (${p.suite.label}) — through the ${p.suite.mcp} MCP server, not a ` +
            `shell command. If that server is not connected, report status "skipped" with that ` +
            `as the reason and carry on. ${p.suite.command}`
          : `- ${p.suite.id} (${p.suite.label}): ${p.suite.command}`,
      )
      .join('\n') +
    (apiSuites.length > 0
      ? '\n(The endpoint pass described below is the exception to that stop rule.)'
      : '') +
    endpointSection(apiSuites, dbServers) +
    qualitySection(flags) +
    `\n${HONESTY}\n\n` +
    `As soon as EACH suite finishes, before you start the next one, print one line ` +
    `on its own starting with ${SUITE_MARKER}: followed by JSON (one line, no code ` +
    `fence):\n{"id": "<suite id>", "status": "pass|fail|skipped|not_run", ` +
    `"detail": "<one line: counts, or the first failure>"}\n` +
    `Print it for every suite you run, including the ones that fail. Then carry on ` +
    `with the next suite.\n\n` +
    `Finish your reply with one line, on its own, starting with ${VERIFY_MARKER}: followed by ` +
    `JSON of this shape (one line, no code fence):\n${buildSchema(flags)}`
  )
}

export function evidencePrompt(acceptanceHints: readonly string[]): string {
  return (
    'Capture evidence that the change in this working tree actually works. Execute the code — ' +
    'do not read it and describe what it would do.\n\n' +
    'Do this:\n' +
    '1. Exercise the changed behaviour with real inputs: call the endpoints, run the ' +
    'commands, or drive the screens that the change touched. Record the exact input you ' +
    'sent and the exact result that came back.\n' +
    '2. If the change is visible, launch the app and screenshot the affected screen with ' +
    'Playwright. Save each screenshot to a file and give its absolute path.\n' +
    '3. Include at least one case that SHOULD fail (bad input, missing auth) and what it did.\n' +
    (acceptanceHints.length > 0
      ? `\nThe change is meant to satisfy:\n${acceptanceHints.map((a) => `- ${a}`).join('\n')}\n`
      : '') +
    `\nAnything you could not execute is left out. ${HONESTY}\n\n` +
    `Finish with one line, on its own, starting with ${VERIFY_MARKER}: followed by JSON ` +
    '(one line, no code fence):\n' +
    '{"evidence": [{"kind": "run|screenshot", "what": "<the input sent or screen captured>", ' +
    '"result": "<what actually came back>", "path": "<absolute file path or null>"}]}'
  )
}

export function parseVerifyReport(text: string): VerifyReport | null {
  const tail = markerTail(text, VERIFY_MARKER)
  if (tail === null) return null
  const json = firstJsonObject(tail)
  if (json === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  return normalizeReport(raw)
}

export function verifyMarkerBroken(text: string): boolean {
  return markerTail(text, VERIFY_MARKER) !== null && parseVerifyReport(text) === null
}

export function parseSuiteProgress(text: string): SuiteResult | null {
  const tail = markerTail(text, SUITE_MARKER)
  if (tail === null) return null
  const json = firstJsonObject(tail)
  if (json === null) return null
  try {
    return toSuiteResult(JSON.parse(json))
  } catch {
    return null
  }
}

function normalizeReport(raw: unknown): VerifyReport | null {
  if (!isRecord(raw)) return null
  const report = emptyVerifyReport()
  const coverage = isRecord(raw.coverage) ? raw.coverage : {}
  const quality = isRecord(raw.quality) ? raw.quality : {}

  report.suites = asArray(raw.suites).map(toSuiteResult).filter((s): s is SuiteResult => s !== null)
  report.coverage.line = toMeasured(coverage.line)
  report.coverage.changed = toMeasured(coverage.changed)
  report.coverage.files = asArray(coverage.files)
    .map((entry) => {
      if (!isRecord(entry)) return null
      const path = str(entry.path)
      const pct = num(entry.pct)
      return path && pct !== null ? { path, pct } : null
    })
    .filter((f): f is { path: string; pct: number } => f !== null)

  const gate = str(quality.gate)?.toLowerCase()
  report.quality.gate =
    gate === 'pass' || gate === 'fail' || gate === 'not_configured' ? gate : null
  report.quality.gateSource = str(quality.gateSource)
  report.quality.duplication = toMeasured(quality.duplication)
  report.quality.debt = str(quality.debt)
  report.quality.mutation = toMeasured(quality.mutation)
  report.quality.mutationKilled = truncOrNull(num(quality.mutationKilled))
  report.quality.mutationSurvived = truncOrNull(num(quality.mutationSurvived))
  report.quality.archViolations = toMeasured(quality.archViolations)
  report.quality.survivors = asArray(quality.survivors).map(str).filter(isText)
  report.quality.findings = asArray(quality.findings).map(str).filter(isText)
  report.evidence = asArray(raw.evidence).map(toEvidence).filter((e): e is EvidenceItem => e !== null)
  report.endpoints = asArray(raw.endpoints)
    .map(toEndpointResult)
    .filter((e): e is EndpointResult => e !== null)
  return report
}

function toEndpointResult(raw: unknown): EndpointResult | null {
  if (!isRecord(raw)) return null
  const method = str(raw.method)?.toUpperCase()
  const path = str(raw.path)
  if (!method || !path) return null
  const outcome = str(raw.outcome)?.toLowerCase().replace(/[\s-]/g, '_')
  return {
    method,
    path,
    status: num(raw.status),
    ms: num(raw.ms),
    response: str(raw.response),
    dataSource: str(raw.dataSource),
    dataQuery: str(raw.dataQuery),
    dataAssertion: str(raw.dataAssertion),
    outcome: outcome === 'pass' || outcome === 'fail' ? outcome : 'not_run',
    detail: str(raw.detail),
  }
}

const SUITE_STATUSES: readonly SuiteStatus[] = ['pass', 'fail', 'skipped', 'unavailable', 'not_run']

function toSuiteResult(raw: unknown): SuiteResult | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const status = str(raw.status)?.toLowerCase().replace(/[\s-]/g, '_')
  return {
    id,
    label: str(raw.label) ?? id,
    status: SUITE_STATUSES.includes(status as SuiteStatus) ? (status as SuiteStatus) : 'not_run',
    detail: str(raw.detail) ?? '',
  }
}

function toEvidence(raw: unknown): EvidenceItem | null {
  if (!isRecord(raw)) return null
  const what = str(raw.what)
  if (!what) return null
  return {
    kind: str(raw.kind) === 'screenshot' ? 'screenshot' : 'run',
    what,
    result: str(raw.result) ?? '',
    path: str(raw.path),
  }
}

function toMeasured(raw: unknown): Measured {
  if (isRecord(raw)) return { value: num(raw.value), source: str(raw.source) }
  return { value: num(raw), source: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isText(value: string | null): value is string {
  return value !== null
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value.replace('%', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function truncOrNull(value: number | null): number | null {
  return value === null ? null : Math.trunc(value)
}
