import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { securityScores } from '@shared/domain'
import {
  auditDone,
  auditPrompt,
  fingerprintClasses,
  parseFindings,
  parseLedger,
  readAuditReport,
} from '@main/security/audit-dispatch'

const LEDGER = [
  {
    coverage_id: 'ipc:renderer:handlers:injection',
    attack_class: 'injection',
    subsystem: 'handlers',
    status: 'covered',
    attempts: [],
    result_fingerprints: [],
  },
  {
    coverage_id: 'ipc:renderer:handlers:path-traversal',
    attack_class: 'path-traversal',
    subsystem: 'handlers',
    status: 'candidate',
    attempts: [{ status: 'candidate', result_fingerprints: ['fp-1'] }],
    result_fingerprints: ['fp-1'],
  },
  {
    coverage_id: 'native:kernel:memory',
    attack_class: 'memory-safety',
    subsystem: 'native',
    status: 'not_applicable',
    attempts: [],
    result_fingerprints: [],
  },
  {
    coverage_id: 'ipc:renderer:handlers:authz',
    attack_class: 'authorization',
    subsystem: 'handlers',
    status: 'blocked',
    attempts: [],
    result_fingerprints: [],
  },
]

const FINDINGS = [
  {
    verdict: 'confirmed',
    fingerprint: 'fp-1',
    title: 'Path escapes the project root',
    trace: [
      { kind: 'entrypoint', file: 'src/main/ipc/handlers.ts', line: 10 },
      { kind: 'sink', file: 'src/main/skills/import.ts', line: 118 },
    ],
    severity: { overall_severity: 'high' },
  },
  {
    verdict: 'needs_validation',
    fingerprint: 'fp-2',
    title: 'Possible race on the permission gate',
    trace: [{ kind: 'sink', file: 'src/main/inbox/permission-broker.ts', line: 44 }],
  },
  {
    verdict: 'rejected',
    fingerprint: 'fp-3',
    title: 'Renderer can reach Node',
    trace: [],
  },
  { verdict: 'nonsense', fingerprint: 'fp-4', title: 'ignored' },
]

describe('the audit prompt', () => {
  it('names the output directory and the finish marker', () => {
    const prompt = auditPrompt({ scope: 'project', outputDir: 'C:\\audits\\run-1' })
    expect(prompt).toContain('C:\\audits\\run-1')
    expect(prompt).toContain('SWB_SECURITY: done')
    expect(prompt).toContain('whole repository')
  })

  it('says to scope a changes run to the working tree', () => {
    const prompt = auditPrompt({ scope: 'changes', outputDir: 'C:\\audits\\run-2' })
    expect(prompt).toContain('pending changes')
    expect(prompt).toContain('git diff')
  })

  it('only reads the marker on a line of its own', () => {
    expect(auditDone('work done\nSWB_SECURITY: done')).toBe(true)
    expect(auditDone('I will print SWB_SECURITY: done when finished')).toBe(false)
  })
})

describe('reading what the skill wrote', () => {
  it('keeps the records it understands and drops the ones it does not', () => {
    const findings = parseFindings(FINDINGS)
    expect(findings.map((f) => f.fingerprint)).toEqual(['fp-1', 'fp-2', 'fp-3'])
    expect(findings[0].severity).toBe('high')
    expect(findings[0].file).toBe('src/main/skills/import.ts')
    expect(findings[0].line).toBe(118)
    expect(findings[1].severity).toBeNull()
  })

  it('takes a finding\u2019s attack class from the ledger unit that raised it', () => {
    const classes = fingerprintClasses(LEDGER)
    const findings = parseFindings(FINDINGS, (fp) => classes.get(fp) ?? null)
    expect(findings[0].attackClass).toBe('path-traversal')
    expect(findings[1].attackClass).toBeNull()
  })

  it('keeps every ledger unit with a status it knows', () => {
    const units = parseLedger(LEDGER)
    expect(units).toHaveLength(4)
    expect(units.map((u) => u.status)).toEqual(['covered', 'candidate', 'not_applicable', 'blocked'])
  })

  it('reads both artefacts off disk, and the markdown beside them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-audit-'))
    try {
      writeFileSync(join(dir, 'coverage-ledger.json'), JSON.stringify(LEDGER))
      writeFileSync(join(dir, 'findings.json'), JSON.stringify(FINDINGS))
      writeFileSync(join(dir, 'REPORT.md'), '# Report')
      writeFileSync(join(dir, 'architecture.md'), '# Architecture')

      const report = readAuditReport(dir)
      expect(report?.units).toHaveLength(4)
      expect(report?.findings).toHaveLength(3)
      expect(report?.artefacts).toEqual(['REPORT.md', 'architecture.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null when the run wrote nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-audit-empty-'))
    try {
      expect(readAuditReport(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the percentages the tab shows', () => {
  const report = {
    units: parseLedger(LEDGER),
    findings: parseFindings(FINDINGS, (fp) => fingerprintClasses(LEDGER).get(fp) ?? null),
    artefacts: [],
  }

  it('counts coverage over the units that were in scope, not the ones ruled out', () => {
    const scores = securityScores(report)
    expect(scores.inScope).toBe(3)
    expect(scores.covered).toBe(1)
    expect(scores.coveragePct).toBe(33.3)
    expect(scores.unresolved).toBe(2)
  })

  it('separates confirmed from what is still open and what was disproved', () => {
    const scores = securityScores(report)
    expect(scores.confirmed).toBe(1)
    expect(scores.needsValidation).toBe(1)
    expect(scores.rejected).toBe(1)
    expect(scores.disprovedPct).toBe(33.3)
    expect(scores.bySeverity.high).toBe(1)
    expect(scores.bySeverity.critical).toBe(0)
  })

  it('reports a clean rate over the classes that were worked, so a class that raised a finding still counts', () => {
    const scores = securityScores(report)
    expect(scores.cleanPct).toBe(50)
    expect(scores.byClass.find((c) => c.attackClass === 'path-traversal')?.confirmed).toBe(1)
    expect(scores.byClass.find((c) => c.attackClass === 'authorization')?.worked).toBe(0)
  })

  it('answers null rather than zero when there is nothing to divide by', () => {
    const scores = securityScores({ units: [], findings: [], artefacts: [] })
    expect(scores.coveragePct).toBeNull()
    expect(scores.disprovedPct).toBeNull()
    expect(scores.cleanPct).toBeNull()
  })
})
