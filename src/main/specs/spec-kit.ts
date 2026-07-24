// GitHub Spec Kit (github/spec-kit) per-project integration. Detects whether a
// project has Spec Kit initialised (a `.specify/` directory), parses the specs
// under `specs/NNN-name/`, and installs Spec Kit into a project on demand.
//
// Installation runs the official CLI EPHEMERALLY via `uvx` (nothing is
// installed globally): `uvx --from git+https://github.com/github/spec-kit.git
// specify init --here ...` scaffolds `.specify/` inside the project directory.
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type {
  ResolvedClarification,
  SpecDetail,
  SpecKitState,
  SpecPhase,
  SpecSection,
  SpecStatus,
  SpecSummary,
  SpecTask,
} from '@shared/domain'

const execFileAsync = promisify(execFile)

const SPEC_KIT_GIT = 'git+https://github.com/github/spec-kit.git'

function specsDir(projectPath: string): string {
  return join(projectPath, 'specs')
}

export async function isSpecKitInstalled(projectPath: string): Promise<boolean> {
  try {
    await stat(join(projectPath, '.specify'))
    return true
  } catch {
    return false
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listSpecDirs(projectPath: string): Promise<string[]> {
  try {
    const entries = await readdir(specsDir(projectPath), { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** First markdown H1 or "Feature Specification: X" title, else the directory id. */
function parseTitle(specMd: string | null, id: string): string {
  if (!specMd) return id
  const h1 = specMd.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/m)
  return h1 ? h1[1].trim() : id
}

/** Short description: the first non-heading paragraph, or the Summary section. */
function parseDescription(specMd: string | null): string {
  if (!specMd) return ''
  const summary = specMd.match(/^##\s+Summary\s*\n+([^\n#][^\n]*(?:\n[^\n#][^\n]*)*)/m)
  if (summary) return summary[1].replace(/\s+/g, ' ').trim().slice(0, 400)
  // First paragraph that is not a heading or metadata line.
  const lines = specMd.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#') || line.startsWith('**') || line.startsWith('|')) continue
    return line.slice(0, 400)
  }
  return ''
}

/** Sections from spec.md: each `## Heading` becomes a section with its body. */
function parseSections(specMd: string | null): SpecSection[] {
  if (!specMd) return []
  const sections: SpecSection[] = []
  const regex = /^##\s+(.+)$/gm
  const matches = [...specMd.matchAll(regex)]
  for (let i = 0; i < matches.length; i += 1) {
    const title = matches[i][1].replace(/\*/g, '').trim()
    const start = matches[i].index! + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : specMd.length
    const body = specMd
      .slice(start, end)
      .replace(/^\s+/, '')
      .replace(/\s+$/, '')
    if (title && body) sections.push({ title, body })
  }
  return sections
}

const TASK_LINE = /^\s*-\s*\[( |x|X)\]\s*(T\d+)?\s*(.*)$/

/** Tasks grouped by phase from tasks.md; also returns totals. */
function parseTasks(tasksMd: string | null): { phases: SpecPhase[]; total: number; done: number } {
  if (!tasksMd) return { phases: [], total: 0, done: 0 }
  const phases: SpecPhase[] = []
  let current: SpecPhase | null = null
  let total = 0
  let done = 0
  for (const raw of tasksMd.split('\n')) {
    const phaseMatch = raw.match(/^##\s+(.+)$/)
    if (phaseMatch && /phase/i.test(phaseMatch[1])) {
      current = { label: phaseMatch[1].replace(/\*/g, '').trim(), tasks: [] }
      phases.push(current)
      continue
    }
    const taskMatch = raw.match(TASK_LINE)
    if (taskMatch) {
      const isDone = taskMatch[1].toLowerCase() === 'x'
      const id = taskMatch[2] ?? ''
      const label = taskMatch[3].trim()
      if (!label) continue
      total += 1
      if (isDone) done += 1
      if (!current) {
        current = { label: 'Tasks', tasks: [] }
        phases.push(current)
      }
      const task: SpecTask = { id, label, done: isDone }
      current.tasks.push(task)
    }
  }
  return { phases: phases.filter((p) => p.tasks.length > 0), total, done }
}

function parseClarifications(specMd: string | null): string[] {
  if (!specMd) return []
  const out: string[] = []
  const regex = /\[NEEDS CLARIFICATION:?\s*([^\]]*)\]/gi
  for (const m of specMd.matchAll(regex)) {
    const text = m[1].trim()
    out.push(text || 'Unspecified clarification')
  }
  return out
}

/**
 * Already-answered clarifications from the `## Clarifications` section, which
 * Spec Kit records as `- Q: <question> → A: <answer>` lines.
 */
function parseResolvedClarifications(specMd: string | null): ResolvedClarification[] {
  if (!specMd) return []
  const heading = specMd.match(/^##\s+Clarifications\s*$/m)
  if (!heading || heading.index === undefined) return []
  const start = heading.index + heading[0].length
  const nextHeading = specMd.slice(start).search(/\n##\s/)
  const body = nextHeading === -1 ? specMd.slice(start) : specMd.slice(start, start + nextHeading)
  const out: ResolvedClarification[] = []
  const line = /^\s*-\s*Q:\s*(.+?)\s*(?:→|->|—)\s*A:\s*(.+)$/gm
  for (const m of body.matchAll(line)) {
    out.push({ question: m[1].trim(), answer: m[2].trim() })
  }
  return out
}

function deriveStatus(total: number, done: number): SpecStatus {
  if (total === 0) return 'draft'
  if (done >= total) return 'complete'
  if (done > 0) return 'in_progress'
  return 'ready'
}

async function summarise(projectPath: string, id: string): Promise<SpecSummary> {
  const dir = join(specsDir(projectPath), id)
  const [specMd, tasksMd] = await Promise.all([
    readFileSafe(join(dir, 'spec.md')),
    readFileSafe(join(dir, 'tasks.md')),
  ])
  const { total, done } = parseTasks(tasksMd)
  return {
    id,
    title: parseTitle(specMd, id),
    status: deriveStatus(total, done),
    tasksTotal: total,
    tasksDone: done,
  }
}

export async function readSpecKitState(projectPath: string): Promise<SpecKitState> {
  const [installed, ids] = await Promise.all([
    isSpecKitInstalled(projectPath),
    listSpecDirs(projectPath),
  ])
  const specs = await Promise.all(ids.map((id) => summarise(projectPath, id)))
  return { installed, specs }
}

export async function readSpecDetail(projectPath: string, id: string): Promise<SpecDetail | null> {
  const dir = join(specsDir(projectPath), id)
  try {
    if (!(await stat(dir)).isDirectory()) return null
  } catch {
    return null
  }
  const [specMd, planMd, tasksMd] = await Promise.all([
    readFileSafe(join(dir, 'spec.md')),
    readFileSafe(join(dir, 'plan.md')),
    readFileSafe(join(dir, 'tasks.md')),
  ])
  const { phases, total, done } = parseTasks(tasksMd)
  return {
    id,
    title: parseTitle(specMd, id),
    status: deriveStatus(total, done),
    tasksTotal: total,
    tasksDone: done,
    description: parseDescription(specMd),
    path: `specs/${id}`,
    sections: parseSections(specMd),
    plan: parseSections(planMd),
    phases,
    clarifications: parseClarifications(specMd),
    resolvedClarifications: parseResolvedClarifications(specMd),
  }
}

/**
 * Install Spec Kit into a project via the ephemeral uvx CLI (no global install).
 * Scaffolds `.specify/` in the project directory. Resolves on success.
 */
export async function installSpecKit(projectPath: string): Promise<void> {
  const script = process.platform === 'win32' ? 'ps' : 'sh'
  try {
    await execFileAsync(
      'uvx',
      [
        '--from',
        SPEC_KIT_GIT,
        'specify',
        'init',
        '--here',
        '--force',
        '--integration',
        'claude',
        '--script',
        script,
        '--ignore-agent-tools',
      ],
      { cwd: projectPath, timeout: 180_000, windowsHide: true, shell: process.platform === 'win32' },
    )
  } catch (error) {
    const e = error as { stderr?: string; message?: string }
    throw new Error(e.stderr?.trim() || e.message || 'Spec Kit init failed', { cause: error })
  }
  if (!(await isSpecKitInstalled(projectPath))) {
    throw new Error('Spec Kit init completed but .specify/ was not created')
  }
}
