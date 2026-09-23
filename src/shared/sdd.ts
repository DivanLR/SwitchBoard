import type { FlowBugResult, FlowDecision, FlowKind, FlowStage, SddProcess } from './domain'

export interface SddCommand {
  command: string
  label: string
  hint: string
  needs: 'none' | 'spec' | 'text' | 'slug'
}

export const SPEC_KIT_COMMANDS: readonly SddCommand[] = [
  { command: 'speckit-constitution', label: '/speckit-constitution', hint: 'Write or update the project constitution, once per project', needs: 'none' },
  { command: 'speckit-specify', label: '/speckit-specify', hint: 'Describe a feature and scaffold its spec', needs: 'text' },
  { command: 'speckit-clarify', label: '/speckit-clarify', hint: 'Ask up to 5 clarification questions and write the answers into the spec', needs: 'spec' },
  { command: 'speckit-checklist', label: '/speckit-checklist', hint: 'Generate a requirements quality checklist for the spec', needs: 'spec' },
  { command: 'speckit-plan', label: '/speckit-plan', hint: 'Generate plan.md from the spec and its answers', needs: 'spec' },
  { command: 'speckit-tasks', label: '/speckit-tasks', hint: 'Break the plan into tasks.md, phase by phase', needs: 'spec' },
  { command: 'speckit-analyze', label: '/speckit-analyze', hint: 'Cross-check spec, plan and tasks for drift or contradictions', needs: 'spec' },
  { command: 'speckit-implement', label: '/speckit-implement', hint: 'Execute every remaining task in tasks.md', needs: 'spec' },
  { command: 'speckit-converge', label: '/speckit-converge', hint: 'Append unbuilt work as tasks; repeat implement until it reports Converged', needs: 'spec' },
]

export const SDD_COMMANDS: Readonly<Record<SddProcess, readonly SddCommand[]>> = {
  bug: [
    { command: 'speckit-bug-assess', label: '/speckit-bug-assess', hint: 'Assess a symptom against the code and propose a remediation', needs: 'text' },
    { command: 'speckit-bug-fix', label: '/speckit-bug-fix', hint: 'Apply the remediation from the assessment', needs: 'slug' },
    { command: 'speckit-bug-test', label: '/speckit-bug-test', hint: 'Verify the fix: verified, partial or failed', needs: 'slug' },
  ],
  assess: [
    { command: 'speckit-assess-intake', label: '/speckit-assess-intake', hint: 'Capture the idea as an intake note', needs: 'text' },
    { command: 'speckit-assess-research', label: '/speckit-assess-research', hint: 'Gather evidence for and against the idea', needs: 'slug' },
    { command: 'speckit-assess-define', label: '/speckit-assess-define', hint: 'Define the problem, goals and success metrics', needs: 'slug' },
    { command: 'speckit-assess-shape', label: '/speckit-assess-shape', hint: 'Shape concept options, appetite and trade-offs', needs: 'slug' },
    { command: 'speckit-assess-decide', label: '/speckit-assess-decide', hint: 'Decide go, needs-clarification or kill', needs: 'slug' },
  ],
}

export const SDD_DIRS: Readonly<Record<SddProcess, string>> = { bug: 'bugs', assess: 'assessments' }

export const SDD_REPORTS: Readonly<Record<SddProcess, readonly { file: string; label: string; stage: FlowStage }[]>> = {
  bug: [
    { file: 'assessment.md', label: 'Assessment', stage: 'assess' },
    { file: 'fix.md', label: 'Fix', stage: 'fix' },
    { file: 'test.md', label: 'Verification', stage: 'test' },
  ],
  assess: [
    { file: 'intake.md', label: 'Intake', stage: 'intake' },
    { file: 'research.md', label: 'Research', stage: 'research' },
    { file: 'problem.md', label: 'Problem', stage: 'define' },
    { file: 'concept.md', label: 'Concept', stage: 'shape' },
    { file: 'decision.md', label: 'Decision', stage: 'decide' },
  ],
}

export function sddProcessOf(kind: FlowKind): SddProcess | null {
  return kind === 'bug' ? 'bug' : kind === 'idea' ? 'assess' : null
}

export function sddDirOf(process: SddProcess, slug: string): string {
  return `.specify/${SDD_DIRS[process]}/${slug}`
}

export function sddReportOf(kind: FlowKind, stage: FlowStage): { file: string; label: string } | null {
  const process = sddProcessOf(kind)
  return (process && SDD_REPORTS[process].find((entry) => entry.stage === stage)) || null
}

export function sddDocPath(kind: FlowKind, slug: string | null, stage: FlowStage): string | null {
  const process = sddProcessOf(kind)
  const report = sddReportOf(kind, stage)
  return process && report && slug ? `${sddDirOf(process, slug)}/${report.file}` : null
}

export function sddCommand(command: string, arg: string, slug: string | null): string {
  const text = arg.trim()
  return [`/${command}`, text ? `"${text.replace(/"/g, "'")}"` : '', slug ? `slug=${slug}` : '']
    .filter(Boolean)
    .join(' ')
}

export function sddSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'untitled'
}

export function isSddSlug(text: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(text)
}

function field(text: string, name: string): string | null {
  const match = new RegExp(`^\\s*-\\s*\\*\\*${name}\\*\\*\\s*:\\s*(.+)$`, 'mi').exec(text)
  return match ? match[1].trim() : null
}

function firstWord(text: string | null, name: string): string | null {
  return text ? (field(text, name)?.toLowerCase().split(/[\s|,]+/)[0] ?? null) : null
}

export function bugResultOf(testMd: string | null): FlowBugResult | null {
  const value = firstWord(testMd, 'Result')
  return value === 'verified' || value === 'partial' || value === 'failed' ? value : null
}

export function decisionOf(decisionMd: string | null): FlowDecision | null {
  const value = firstWord(decisionMd, 'Verdict')
  return value === 'go' || value === 'needs-clarification' || value === 'kill' ? value : null
}

export function severityOf(assessmentMd: string | null): string | null {
  const value = firstWord(assessmentMd, 'Severity')
  return value && ['critical', 'high', 'medium', 'low'].includes(value) ? value : null
}

export function reportTitle(markdown: string | null): string | null {
  const match = markdown ? /^#\s+(?:[^:\n]+:\s*)?(.+)$/m.exec(markdown) : null
  return match ? match[1].trim() : null
}

export function handoffOf(decisionMd: string | null): string | null {
  if (!decisionMd) return null
  const at = decisionMd.search(/^##\s+If go\b.*$/m)
  if (at === -1) return null
  const body = decisionMd.slice(at).replace(/^##[^\n]*\n/, '')
  const end = body.search(/^##\s/m)
  const text = (end === -1 ? body : body.slice(0, end)).trim()
  return text || null
}
