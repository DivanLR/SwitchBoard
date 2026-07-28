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
  type EvidenceItem,
  type Measured,
  type SuiteResult,
  type SuiteStatus,
  type VerifyReport,
} from '@shared/domain'
import { unavailableReason, type SandboxEnv, type TestSuite } from '@shared/test-catalog'

/** Sentinel the session is told to emit, once, on its own line. */
export const VERIFY_MARKER = 'SWB_VERIFY'

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

const SCHEMA = `{
  "suites": [{"id": "<suite id>", "status": "pass|fail|skipped|not_run", "detail": "<one line: counts, or the first failure>"}],
  "coverage": {
    "line": {"value": <percent 0-100 or null>, "source": "<the command or report file you read>"},
    "changed": {"value": <percent of CHANGED lines covered, or null>, "source": "<...>"},
    "files": [{"path": "<file you touched>", "pct": <percent covered>}]
  },
  "quality": {
    "gate": "pass|fail|not_configured", "gateSource": "<e.g. sonarqube>",
    "duplication": {"value": <percent duplicated lines or null>, "source": "<...>"},
    "debt": "<the service's own debt figure, e.g. 2d 4h, or null>",
    "mutation": {"value": <percent mutants killed or null>, "source": "<...>"},
    "survivors": ["<surviving mutant, file:line - what it changed>"],
    "archViolations": {"value": <count or null>, "source": "<...>"},
    "findings": ["<named rule violation, worst first>"]
  }
}`

const HONESTY =
  'Every number must come from output you actually ran or a report file you actually read. ' +
  'If you did not measure something, put null and leave its source null — a guessed, ' +
  'estimated or "typical" figure is far worse than no figure. Never mark a suite pass ' +
  'because it probably would.'

/**
 * The default run: execute the chosen suites in order, stop at the first failure
 * (FR-075 — figures gathered through failing tests are not reported, FR-076),
 * and report one line of JSON.
 */
export function verifyPrompt(plan: PlannedSuite[], stackLabel: string, sandbox: SandboxEnv): string {
  const runnable = plan.filter((p) => !p.unavailable)
  const blocked = plan.filter((p) => p.unavailable)
  return (
    `Verify the working tree of this ${stackLabel} project. This is a verification pass: ` +
    'run things and report what happened. Do not fix anything and do not edit any file.\n\n' +
    'Run these in order, and STOP at the first one that fails:\n' +
    runnable.map((p) => `- ${p.suite.id} (${p.suite.label}): ${p.suite.command}`).join('\n') +
    (blocked.length > 0
      ? '\n\nDo NOT attempt these — this environment cannot run them, which is not a ' +
        'failure of the code. Report each with status "skipped" and the reason as its detail:\n' +
        blocked.map((p) => `- ${p.suite.id}: ${p.unavailable}`).join('\n')
      : '') +
    (sandbox
      ? `\n\nYou are inside the bypass container: it has git, ripgrep and ${sandbox.join(', ')}` +
        ', and nothing else. Do not install a toolchain to work around that.'
      : '') +
    '\n\nThen gather the quality figures, without re-running the tests:\n' +
    '- Coverage: read the coverage report the run produced (cobertura/lcov/json) and give ' +
    'total line coverage, coverage of the lines this working tree changed (compare against ' +
    'git diff), and the touched files with the least coverage.\n' +
    '- Code quality: if a SonarQube or SonarCloud MCP server is connected for this project, ' +
    'read its quality gate, duplication, technical debt and issue counts through it and name ' +
    'it as the source. If no such server is connected, set "gate" to "not_configured" and ' +
    'leave the figures null — do not substitute a lint count for it.\n' +
    '- Architecture and mutation: only from a suite above that actually produced them.\n\n' +
    `${HONESTY}\n\n` +
    `Finish your reply with one line, on its own, starting with ${VERIFY_MARKER}: followed by ` +
    `JSON of this shape (one line, no code fence):\n${SCHEMA}`
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
  const at = text.lastIndexOf(`${VERIFY_MARKER}:`)
  if (at < 0) return null
  const tail = text.slice(at + VERIFY_MARKER.length + 1)
  const start = tail.indexOf('{')
  const end = tail.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(tail.slice(start, end + 1))
  } catch {
    return null
  }
  return normalizeReport(raw)
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
  report.quality.archViolations = toMeasured(quality.archViolations)
  report.quality.survivors = asArray(quality.survivors).map(str).filter(isText)
  report.quality.findings = asArray(quality.findings).map(str).filter(isText)
  report.evidence = asArray(raw.evidence).map(toEvidence).filter((e): e is EvidenceItem => e !== null)
  return report
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

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // "null"/"n/a" reach us as strings often enough to be worth collapsing here.
  return trimmed && !/^(null|n\/a|none|unknown)$/i.test(trimmed) ? trimmed : null
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
