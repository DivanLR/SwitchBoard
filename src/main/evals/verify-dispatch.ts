// A verification run: what the session is asked to execute, and how its answer
// is read back into a report (spec 002 US1-US4).
//
// Same contract as the eval loop's check (eval-dispatch.ts) and for the same
// reason: everything runs THROUGH the session (FR-041), so the only way to get a
// deterministic result without spawning our own processes is to demand one
// machine-readable line and read it off the session's own events. No line, no
// figures (FR-047) — and a figure the run did not measure stays null, because
// the app never derives or substitutes one (FR-072).
import {
  emptyVerifyReport,
  type EndpointResult,
  type EvidenceItem,
  type Measured,
  type SuiteResult,
  type SuiteStatus,
  type VerifyReport,
} from '@shared/domain'
import { unavailableReason, type SandboxEnv, type TestSuite } from '@shared/test-catalog'
import { firstJsonObject, markerTail, str } from './parse'

/** Sentinel the session is told to emit, once, on its own line. */
export const VERIFY_MARKER = 'SWB_VERIFY'

/**
 * Per-suite progress, emitted as each suite finishes. Deliberately a different
 * sentinel from VERIFY_MARKER so the scanner cannot mistake a progress line for
 * the closing report and settle the run four suites early.
 */
export const SUITE_MARKER = 'SWB_SUITE'

/** A suite as the run sees it: the command, and whether this environment can run it. */
export interface PlannedSuite {
  suite: TestSuite
  /** Set when the suite cannot run here — it is reported, not attempted (FR-057). */
  unavailable: string | null
}

/** Split the chosen suites into what will run and what this environment cannot. */
export function planSuites(
  suites: readonly TestSuite[],
  chosen: readonly string[],
  sandbox: SandboxEnv,
): PlannedSuite[] {
  return suites
    .filter((s) => chosen.includes(s.id))
    .map((suite) => ({ suite, unavailable: unavailableReason(suite, sandbox) }))
}

/**
 * What the run actually plans to measure, so the schema (and the guidance below
 * it) only describes fields that stand a chance of being non-null. A unit run
 * with no coverage, mutation or API suite chosen was sending a schema for
 * coverage files, a mutation score and endpoint results it would never have:
 * most of the JSON, sent every run, describing nothing.
 *
 * `quality` is the coarse one, and knowingly so. SuiteKind tags a lint suite
 * and an architecture suite alike as 'quality', so a lint-only run still gets
 * the gate/duplication/debt block it cannot fill. Splitting the kind would
 * reach the catalogue, the gate tiles and the panels; the cost of not splitting
 * it is one unfillable block, and qualitySection already tells the run to
 * answer `not_configured` rather than invent a figure. Split it when a suite
 * needs the distinction for its own sake, not for this.
 */
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

/**
 * One honesty rule, stated once. Exported so apiDataPrompt uses this exact text
 * plus its own addendum instead of reinventing the rule — three independent
 * copies of "don't guess" is how they drift apart.
 */
export const HONESTY =
  'Every number must come from output you actually ran or a report file you actually read. ' +
  'If you did not measure something, put null and leave its source null — a guessed, ' +
  'estimated or "typical" figure is far worse than no figure. Never mark a suite pass ' +
  'because it probably would.'

/**
 * Tell the session to exercise the API for real, and to get its inputs from the
 * project's database MCP servers rather than inventing them.
 *
 * This is the difference between "the integration suite passed" and knowing what
 * the API answered. A test suite can pass against fixtures while every real
 * request 404s, and an endpoint called with a made-up id can answer 200 with an
 * empty body and look healthy. So the identifiers must come from real rows, and
 * the response must be checked back against those rows.
 *
 * When no database MCP server is connected, the section says so and asks for the
 * calls anyway, unseeded: fewer facts, honestly labelled, beats a silent skip.
 */
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

/**
 * The guidance for gathering whatever quality figures this run actually planned
 * to produce. Conditioned the same way endpointSection is: a run with no
 * coverage suite gets no instruction to go read a coverage report, and a run
 * with no mutation suite is never told to go read Stryker's output.
 */
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
      // Two facts about invoking Stryker, both learned by watching it refuse on a
      // real solution rather than guessed at. The catalogue's bare `dotnet
      // stryker` is a guess about a conventional layout, and neither of these
      // refusals is a fault in the code being verified.
      '- Running Stryker: it must be started from a directory holding a TEST project, not from ' +
        'the repository root — at the root it finds nothing to mutate. If that test project ' +
        'references more than one project, Stryker refuses until told which to mutate: pass ' +
        '--project <the csproj it names>. It lists the candidates in the refusal, so read them ' +
        'and pick the one under test rather than guessing.',
    )
  }
  return lines.length === 0 ? '' : `\n\nThen gather the quality figures, without re-running the tests:\n${lines.join('\n')}\n`
}

/**
 * The default run: execute the chosen suites in order, stop at the first failure
 * (FR-075 — figures gathered through failing tests are not reported, FR-076),
 * and report one line of JSON.
 *
 * The real-endpoint pass is deliberately outside the stop rule. FR-075 exists so
 * a quality figure measured through failing tests is never reported, and that
 * reasoning does not reach the API: whether the endpoints answer is independent
 * evidence, and gating it on `dotnet format` would hide the answer the developer
 * came for behind an unrelated failure.
 */
export function verifyPrompt(
  plan: PlannedSuite[],
  stackLabel: string,
  sandbox: SandboxEnv,
  /** Connected database MCP servers, so API suites can exercise real rows. */
  dbServers: readonly string[] = [],
): string {
  const runnable = plan.filter((p) => !p.unavailable)
  const blocked = plan.filter((p) => p.unavailable)
  // Only worth asking for real endpoint exercise when an API-shaped suite is in
  // the run: otherwise the instruction is noise the session has to read past.
  const apiSuites = runnable.filter((p) => p.suite.kind === 'api')
  const flags = schemaFlags(runnable, apiSuites.length > 0)
  return (
    `Verify the working tree of this ${stackLabel} project. This is a verification pass: ` +
    'run things and report what happened. Do not fix anything and do not edit any file.\n\n' +
    'Run these in order, and STOP at the first one that fails:\n' +
    // An MCP-answered suite is not a command line, so it is not offered as one:
    // told to "run" it, a session tries to execute the sentence in a shell.
    runnable
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
    (blocked.length > 0
      ? '\n\nDo NOT attempt these — this environment cannot run them, which is not a ' +
        'failure of the code. Report each with status "skipped" and the reason as its detail:\n' +
        blocked.map((p) => `- ${p.suite.id}: ${p.unavailable}`).join('\n')
      : '') +
    (sandbox
      ? `\n\nYou are inside the bypass container: it has git, ripgrep and ${sandbox.join(', ')}` +
        ', and nothing else. Do not install a toolchain to work around that.' +
        // The project folder is a bind mount shared with the host, so a file the
        // HOST has open cannot be replaced from in here. The MSBuild error for it
        // names a path and a permission and gives no hint of the cause, and the
        // obvious reading — the container lacks rights — is wrong: it can create
        // new files in that very directory. Observed on a real run, where the
        // developer's own API was running on the host and holding the DLLs its
        // build wanted to overwrite.
        '\n\n/workspace is the developer\'s own folder, shared live with their machine. ' +
        'If a build fails with MSB3021 or "Access to the path ... is denied" for a file ' +
        'under bin/ or obj/, that file is LOCKED BY A PROCESS ON THE HOST — usually the ' +
        'application itself running outside this container. It is not a permissions ' +
        'problem here and not a fault in the code. Report that suite as "skipped", say ' +
        'which file and that it is locked by a host process, and name the project so it ' +
        'can be stopped. Do not delete bin/ or obj/ to get around it: those are the ' +
        "developer's build outputs and something is using them."
      : '') +
    endpointSection(apiSuites, dbServers) +
    qualitySection(flags) +
    `\n${HONESTY}\n\n` +
    // Progress, not the verdict. Without this a six-suite run shows nothing at all
    // until every suite has finished, so the developer cannot tell a slow suite
    // from a stuck one.
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

/**
 * Evidence capture: a separate action against the build that already passed
 * (FR-059), because it launches and drives the app, which a default run must not
 * do (FR-058). Every item has to be the product of executing the code (FR-048).
 */
export function evidencePrompt(acceptanceHints: readonly string[], sandboxed: boolean): string {
  return (
    'Capture evidence that the change in this working tree actually works. Execute the code — ' +
    'do not read it and describe what it would do.\n\n' +
    'Do this:\n' +
    '1. Exercise the changed behaviour with real inputs: call the endpoints, run the ' +
    'commands, or drive the screens that the change touched. Record the exact input you ' +
    'sent and the exact result that came back.\n' +
    (sandboxed
      ? '2. You are inside the bypass container — no browser and no display, so skip screenshots ' +
        'and say so.\n'
      : '2. If the change is visible, launch the app and screenshot the affected screen with ' +
        'Playwright. Save each screenshot to a file and give its absolute path.\n') +
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

/**
 * Read a report out of session text. Tolerant on the way in — the model may fence
 * the JSON, spread it over lines, or send a bare number where a measured figure
 * belongs — and strict on the way out: anything unreadable becomes null rather
 * than a number nothing measured.
 *
 * The LAST marker wins: the prompt itself names the sentinel, and a turn may
 * restate it, so an early mention must never be mistaken for the answer.
 */
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

/**
 * The turn carried a report line that could not be read.
 *
 * Distinct from "no marker at all", which is a session that simply never
 * reported. The two need opposite explanations to the developer, and telling
 * them apart is the whole reason `markerTail` returns null only on absence.
 */
export function verifyMarkerBroken(text: string): boolean {
  return markerTail(text, VERIFY_MARKER) !== null && parseVerifyReport(text) === null
}

/**
 * One suite's outcome, announced the moment that suite finishes rather than in
 * the report at the end.
 *
 * The final marker is still the record: this is progress, and progress is allowed
 * to be wrong in a way a verdict is not. A suite ticked green here that the closing
 * report calls failed loses the argument, because `finish` overwrites the whole
 * suites array with the settled one. The value is that a run covering six suites
 * stops being a spinner for four minutes.
 *
 * The FIRST occurrence wins per suite, unlike the closing report where the last
 * marker wins: a suite announces itself once, and a later restatement in the
 * summary text must not be read as a second, contradictory run of it.
 */
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
  // Counts, not percentages, so truncate — num() otherwise tolerates a decimal.
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

/**
 * One reported HTTP call, kept only when it names a method and a path.
 *
 * `status` is deliberately NOT defaulted: a missing or unparseable status stays
 * null, so a call that never completed can never read as a response. `outcome`
 * falls back to 'not_run' for the same reason — an unrecognised value must not
 * become a pass, which is the one direction that would mislead.
 */
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
    // An unrecognised status is not a pass: it proves nothing, so it did not run.
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

/** A figure with its source. A bare number is accepted (the model often sends
 *  one) but keeps a null source, so the panel can still say where it came from —
 *  nowhere it named. */
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

/** Percentages arrive as 82, "82", "82%" or 0.82 — and as "unknown" when nothing
 *  measured them, which must stay null rather than becoming 0. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value.replace('%', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** A mutant count, never a fraction — Math.trunc on a null is not an option. */
function truncOrNull(value: number | null): number | null {
  return value === null ? null : Math.trunc(value)
}
