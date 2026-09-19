import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SecurityFinding,
  SecurityReport,
  SecurityScope,
  SecuritySeverity,
  SecurityUnit,
  SecurityUnitStatus,
  SecurityVerdict,
} from '@shared/domain'

export const SECURITY_MARKER = 'SWB_SECURITY'

export const SECURITY_SKILL_NAME = 'security-audit'

export const SECURITY_SKILL_URL = 'https://github.com/cloudflare/security-audit-skill/tree/main/skills'

const FINDINGS_FILE = 'findings.json'
const LEDGER_FILE = 'coverage-ledger.json'
const MAX_ARTEFACT_BYTES = 5 * 1024 * 1024

export function auditPrompt(input: { scope: SecurityScope; outputDir: string }): string {
  const scopeLine =
    input.scope === 'changes'
      ? 'Scope: only the pending changes in this working tree. Read `git status` and `git diff` first, audit the code those changes touch and the paths reachable from it, and mark every other coverage unit out_of_scope.'
      : 'Scope: the whole repository.'

  return [
    `Run a security audit of this repository with the ${SECURITY_SKILL_NAME} skill, in full audit mode.`,
    '',
    scopeLine,
    `Output directory: ${input.outputDir}`,
    'Write every artefact there and nothing into the repository itself.',
    '',
    `The run is only finished once ${LEDGER_FILE}, ${FINDINGS_FILE} and REPORT.md exist in that directory and both validators pass.`,
    `Then finish your reply with one line, on its own: ${SECURITY_MARKER}: done`,
  ].join('\n')
}

export function auditDone(text: string): boolean {
  return new RegExp(`^${SECURITY_MARKER}:\\s*done\\s*$`, 'mi').test(text)
}

const VERDICTS: ReadonlySet<string> = new Set(['confirmed', 'needs_validation', 'rejected'])
const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'informational'])
const UNIT_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'not_applicable',
  'out_of_scope',
  'in_progress',
  'covered',
  'candidate',
  'blocked',
  'deferred',
])

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function traceSite(record: Record<string, unknown>): { file: string | null; line: number | null } {
  const trace = Array.isArray(record.trace) ? (record.trace as Record<string, unknown>[]) : []
  const sink = trace.find((t) => t.kind === 'sink') ?? trace[0]
  if (!sink) return { file: null, line: null }
  const line = typeof sink.line === 'number' && Number.isFinite(sink.line) ? sink.line : null
  return { file: str(sink.file), line }
}

export function parseFindings(raw: unknown, classOf?: (fingerprint: string) => string | null): SecurityFinding[] {
  if (!Array.isArray(raw)) return []
  const findings: SecurityFinding[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const verdict = str(record.verdict)
    const title = str(record.title)
    if (!verdict || !VERDICTS.has(verdict) || !title) continue
    const fingerprint = str(record.fingerprint) ?? title
    const severityRaw =
      typeof record.severity === 'object' && record.severity !== null
        ? str((record.severity as Record<string, unknown>).overall_severity)
        : null
    const site = traceSite(record)
    findings.push({
      fingerprint,
      verdict: verdict as SecurityVerdict,
      title,
      severity: severityRaw && SEVERITIES.has(severityRaw) ? (severityRaw as SecuritySeverity) : null,
      attackClass: classOf?.(fingerprint) ?? null,
      file: site.file,
      line: site.line,
    })
  }
  return findings
}

export function parseLedger(raw: unknown): SecurityUnit[] {
  if (!Array.isArray(raw)) return []
  const units: SecurityUnit[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const status = str(record.status)
    const attackClass = str(record.attack_class)
    const coverageId = str(record.coverage_id)
    if (!status || !UNIT_STATUSES.has(status) || !coverageId) continue
    units.push({
      coverageId,
      attackClass: attackClass ?? 'unclassified',
      subsystem: str(record.subsystem),
      status: status as SecurityUnitStatus,
    })
  }
  return units
}

export function fingerprintClasses(raw: unknown): Map<string, string> {
  const byFingerprint = new Map<string, string>()
  if (!Array.isArray(raw)) return byFingerprint
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const attackClass = str(record.attack_class)
    if (!attackClass) continue
    const attempts = Array.isArray(record.attempts) ? (record.attempts as Record<string, unknown>[]) : []
    const lists = [record.result_fingerprints, ...attempts.map((a) => a.result_fingerprints)]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const fingerprint of list) {
        const key = str(fingerprint)
        if (key && !byFingerprint.has(key)) byFingerprint.set(key, attackClass)
      }
    }
  }
  return byFingerprint
}

function readJson(dir: string, name: string): unknown {
  try {
    const text = readFileSync(join(dir, name), 'utf8')
    if (text.length > MAX_ARTEFACT_BYTES) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function readAuditReport(dir: string): SecurityReport | null {
  const ledgerRaw = readJson(dir, LEDGER_FILE)
  const findingsRaw = readJson(dir, FINDINGS_FILE)
  if (ledgerRaw === null && findingsRaw === null) return null
  const classes = fingerprintClasses(ledgerRaw)
  let artefacts: string[]
  try {
    artefacts = readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
  } catch {
    artefacts = []
  }
  return {
    findings: parseFindings(findingsRaw, (fingerprint) => classes.get(fingerprint) ?? null),
    units: parseLedger(ledgerRaw),
    artefacts,
  }
}
