// The test report a run leaves behind: the document a developer keeps, reviews
// with a colleague, and attaches to a ticket.
//
// Written from the recorded run and NOTHING else. Every status, timing, body and
// query in it is something the app sent or received (api-runner.ts), so the report
// is a transcript rather than a summary — the same reason the run does not ask a
// model whether the API works. Where a run measured nothing, the report says so;
// it never fills a gap, and it has no opinions to offer that the calls did not
// establish.
//
// The shape follows the reports this replaces (what the action is, the contracts,
// a response matrix, the cases with their live results, findings, and an appendix
// naming the environment and every query verbatim), because that shape is what a
// reviewer already knows how to read.
import type { ApiCall, ApiEvalRun } from './api-endpoints'

/** Context the run row does not hold, supplied by whoever writes the file. */
export interface ReportContext {
  /** The project, as the developer named it. */
  projectName: string
  /** Database MCP servers connected while the request data was produced. */
  dbServers?: readonly string[]
}

/**
 * Mask long digit runs — account, contract, card and identity numbers.
 *
 * A report is a document that gets attached to a ticket and pasted into chat, and
 * the run that produced it called a real environment with real identifiers, so
 * without this the file carries live customer numbers to wherever it is sent. The
 * hand-written reports this replaces redact exactly these by hand and remain
 * perfectly readable, which is the evidence that the redaction costs nothing worth
 * keeping.
 *
 * Eight digits is the threshold because it clears everything the report needs to
 * stay useful — row counts, statuses, millisecond timings, ISO dates, prices — and
 * catches the identifiers, which in this domain run from ten digits to twenty. The
 * length is kept, so "the same id appears in the query and the response" is still
 * visible. The run itself used the real values; only the document is masked.
 *
 * ponytail: digit runs, not a PII classifier. It cannot know that a free-text note
 * mentions a person, and pretending otherwise would be a false promise — which is
 * why the report says out loud that it holds live data.
 */
function maskIdentifiers(text: string): string {
  return text.replace(/\d{8,}/g, (run) => `<redacted:${run.length} digits>`)
}

/**
 * The run as a markdown report.
 *
 * A run that called nothing still produces a report: "nothing was called, and
 * here is why" is the most important thing such a run has to say, and leaving it
 * out is how a failed run becomes an unnoticed one.
 */
export function apiReportMarkdown(run: ApiEvalRun, context: ReportContext): string {
  const lines: string[] = []
  const push = (...text: string[]): void => {
    lines.push(...text)
  }

  const templates = [...new Set(run.calls.map((c) => c.request.template))]
  push(
    `# ${reportTitle(templates)} — Test Report`,
    '',
    `**Project:** ${context.projectName}`,
    `**Environment:** ${environmentWords(run)}`,
    `**Base URL:** \`${run.baseUrl}\``,
    `**Endpoints covered:** ${templates.length > 0 ? templates.map(code).join(', ') : 'none'}`,
    `**Run:** ${run.startedAt}${run.finishedAt ? ` → ${run.finishedAt}` : ' (unfinished)'}`,
    `**Verdict:** ${verdictWords(run)}`,
    '**Test method:** every request below was sent by the application itself and judged from the ' +
      'status and body that came back. No figure in this report is a summary of a run — it is the ' +
      'run.',
    '',
    '> **Live data.** This run called a real environment with real identifiers. Numbers of eight ' +
      'digits or more are masked below (account, contract, card and identity numbers keep their ' +
      'length so the same value can still be followed between a query and a response), and header ' +
      'values are never printed. Free text in a response or a note is reproduced as it came back, ' +
      'so treat this file as sensitive and check it before sending it outside the team.',
    '',
  )
  if (run.note) push(`> ${run.note}`, '')

  push('---', '', '## 1. What was called', '')
  if (run.calls.length === 0) {
    push(
      'Nothing. This run sent no request at all, so it proves nothing about the endpoints — the ' +
        'note above says why.',
      '',
    )
    return `${lines.join('\n')}\n`
  }
  push(
    `${run.calls.length} ${run.calls.length === 1 ? 'call' : 'calls'} across ` +
      `${templates.length} ${templates.length === 1 ? 'endpoint' : 'endpoints'}: ` +
      `${count(run.calls, 'pass')} passed, ${count(run.calls, 'fail')} failed, ` +
      `${count(run.calls, 'not_run')} never completed.`,
    '',
    run.launched
      ? 'The application started the API for this run and stopped it afterwards.'
      : run.target === 'qa'
        ? 'The environment was already running and was left exactly as it was found: nothing was ' +
          'started, restarted or stopped.'
        : 'The API was already running and was used as it was found.',
    '',
  )

  push('## 2. Response matrix', '', '| # | Method | Path | Expected | Status | Time | Outcome |', '|---|---|---|---|---|---|---|')
  run.calls.forEach((call, index) => {
    push(
      `| ${index + 1} | ${call.request.method} | ${code(maskIdentifiers(call.request.path))} | ${expectWords(call)} | ` +
        `${call.status ?? '—'} | ${call.ms === null ? '—' : `${call.ms} ms`} | ` +
        `${outcomeWords(call.outcome)} |`,
    )
  })
  push('')

  push('## 3. Cases and live results', '')
  run.calls.forEach((call, index) => {
    push(`### TC-${index + 1} — ${call.request.method} ${maskIdentifiers(call.request.path)}`, '')
    if (call.request.note) push(`**Given** ${maskIdentifiers(call.request.note)}`, '')
    push(
      `**When** \`${call.request.method} ${maskIdentifiers(call.request.path)}\` is called against ${code(run.baseUrl)}`,
      '',
      `**Then** ${expectWords(call)} — ${outcomeWords(call.outcome)}` +
        (call.detail ? `: ${maskIdentifiers(call.detail)}` : ''),
      '',
    )
    if (call.request.headers) {
      // Header NAMES only. A report is a document that gets pasted into a ticket,
      // and an API key in it outlives every precaution taken elsewhere.
      push(`**Headers sent:** ${Object.keys(call.request.headers).map(code).join(', ')}`, '')
    }
    if (call.request.body) push('**Request body:**', '', fence(maskIdentifiers(call.request.body)), '')
    if (call.body !== null) {
      push(
        `**Response (${call.status ?? 'no status'}):**`,
        '',
        fence(maskIdentifiers(call.body)),
        '',
      )
    } else {
      push('**Response:** none — the call did not complete.', '')
    }
    if (call.request.dataQuery) {
      push(
        `**Data behind it** (${call.request.dataSource ?? 'source not named'}):`,
        '',
        fence(maskIdentifiers(call.request.dataQuery), 'sql'),
        '',
      )
    }
  })

  push('## 4. Findings', '')
  const findings = reportFindings(run)
  if (findings.length === 0) {
    push(
      'Every call answered as its expectation said. Note what that does and does not cover: only ' +
        'the calls listed above were made, and only what section 2 names as expected was checked.',
      '',
    )
  } else {
    findings.forEach((finding, index) => push(`${index + 1}. ${finding}`, ''))
  }

  push(
    '## Appendix A — Test conditions',
    '',
    `- **Environment:** ${environmentWords(run)}, \`${run.baseUrl}\`.`,
    `- **Server lifecycle:** ${run.launched ? 'started and stopped by this run' : 'not touched by this run'}.`,
    `- **Real data:** ${dataSourceWords(run, context)}`,
    `- **Session:** ${run.sessionId ? code(run.sessionId) : 'none recorded'} — used only to produce the request data, never to judge a response.`,
    `- **Run id:** ${code(run.id)}.`,
    '',
  )
  return `${lines.join('\n')}\n`
}

/**
 * The file name for a run's report, in the shape the existing reports use.
 *
 * Deterministic on purpose: asking for the report twice rewrites the same file
 * rather than leaving a numbered trail of near-identical documents.
 */
export function apiReportFileName(run: ApiEvalRun): string {
  const templates = [...new Set(run.calls.map((c) => c.request.template))]
  const day = run.startedAt.slice(0, 10)
  return `${slug(reportTitle(templates))}-${day}-Test-Report.md`
}

function reportTitle(templates: readonly string[]): string {
  if (templates.length === 1) return templates[0].replace(/^\//, '')
  if (templates.length === 0) return 'API'
  return `${templates[0].replace(/^\//, '')} +${templates.length - 1}`
}

function slug(text: string): string {
  return (
    text
      .replace(/\{[^}]*\}/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'api'
  )
}

function environmentWords(run: ApiEvalRun): string {
  return run.target === 'qa' ? 'QA (deployed)' : 'local'
}

function verdictWords(run: ApiEvalRun): string {
  if (run.status === 'pass') return 'PASS — every call answered as expected'
  if (run.status === 'fail') return 'FAIL — at least one call did not'
  if (run.status === 'running') return 'still running'
  // An inconclusive run is not always an empty one: a run where some calls
  // answered and others never went out proved something about the first group and
  // nothing about the second, and saying so is more use than either "pass" or
  // "proved nothing".
  const completed = count(run.calls, 'pass') + count(run.calls, 'fail')
  const never = count(run.calls, 'not_run')
  if (completed > 0 && never > 0) {
    return `INCONCLUSIVE — ${completed} of ${run.calls.length} calls completed, ${never} never went out`
  }
  return 'INCONCLUSIVE — this run proved nothing'
}

function outcomeWords(outcome: ApiCall['outcome']): string {
  if (outcome === 'pass') return 'PASS'
  return outcome === 'fail' ? 'FAIL' : 'NOT RUN'
}

/** The check as the app performed it, in the app's own terms. */
function expectWords(call: ApiCall): string {
  const expect = call.request.expect
  const parts = [expect.status !== null ? `status ${expect.status}` : 'any 2xx']
  if (expect.minItems !== null) parts.push(`at least ${expect.minItems} items`)
  if (expect.mustContain) parts.push(`body contains ${code(maskIdentifiers(expect.mustContain))}`)
  return parts.join(', ')
}

/**
 * What the run established that is worth acting on, and nothing else.
 *
 * Every entry is a fact about the recorded calls. There is no advice here that a
 * program cannot justify from the transcript: a report that speculates is one a
 * reviewer has to check, which defeats the point of it being deterministic.
 */
export function reportFindings(run: ApiEvalRun): string[] {
  const findings: string[] = []
  for (const [index, call] of run.calls.entries()) {
    if (call.outcome === 'fail') {
      findings.push(
        `**(Failure) TC-${index + 1} ${call.request.method} ${maskIdentifiers(call.request.path)}** — ` +
          `${maskIdentifiers(call.detail ?? 'the response did not match the expectation')}. ` +
          `Expected ${expectWords(call)}; received ${call.status ?? 'no response'}.`,
      )
    }
  }
  for (const [index, call] of run.calls.entries()) {
    if (call.outcome === 'not_run') {
      findings.push(
        `**(Not run) TC-${index + 1} ${call.request.method} ${maskIdentifiers(call.request.path)}** — ` +
          `${maskIdentifiers(call.detail ?? 'the call never completed')}. This is not a failure of the endpoint, ` +
          'and it is not evidence that it works either.',
      )
    }
  }
  const unseeded = run.calls.filter((c) => !c.request.dataQuery)
  if (unseeded.length > 0) {
    findings.push(
      `**(Weak evidence)** ${unseeded.length} of ${run.calls.length} calls name no query behind ` +
        'their inputs, so the identifiers they used are not traceable to a real row. A call with ' +
        'an invented id can answer 200 with an empty body and read as a pass.',
    )
  }
  const loose = run.calls.filter(
    (c) =>
      c.outcome === 'pass' &&
      c.request.expect.minItems === null &&
      !c.request.expect.mustContain,
  )
  if (loose.length > 0) {
    findings.push(
      `**(Weak check)** ${loose.length} passing ${loose.length === 1 ? 'call was' : 'calls were'} ` +
        'checked on status alone. The status says the endpoint answered, not that it answered with ' +
        'the right data.',
    )
  }
  return findings
}

function dataSourceWords(run: ApiEvalRun, context: ReportContext): string {
  const sources = [...new Set(run.calls.map((c) => c.request.dataSource).filter(Boolean))]
  if (sources.length > 0) {
    return `identifiers drawn from ${sources.join(', ')}; every query is reproduced above verbatim.`
  }
  const configured = context.dbServers ?? []
  return configured.length > 0
    ? `no query was recorded, although ${configured.join(', ')} was connected — the inputs are not traceable to a real row.`
    : 'no database MCP server supplied the inputs, so no call is traceable to a real row.'
}

function count(calls: readonly ApiCall[], outcome: ApiCall['outcome']): number {
  return calls.filter((c) => c.outcome === outcome).length
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``
}

/** A fenced block that cannot be broken out of by a body containing backticks. */
function fence(text: string, language = ''): string {
  const longest = /(`{3,})/.exec(text)?.[1]?.length ?? 0
  const fenceMark = '`'.repeat(Math.max(3, longest + 1))
  return `${fenceMark}${language}\n${text}\n${fenceMark}`
}
