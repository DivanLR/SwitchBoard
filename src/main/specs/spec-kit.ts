import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ConstitutionState,
  ResolvedClarification,
  SddEntry,
  SddProcess,
  SpecDetail,
  SpecKitState,
  SpecPhase,
  SpecSection,
  SpecStatus,
  SpecSummary,
  SpecTask,
} from '@shared/domain'
import type { IpcError } from '@shared/ipc-types'
import { SDD_DIRS, SDD_REPORTS, bugResultOf, decisionOf, isSddSlug, reportTitle, severityOf } from '@shared/sdd'

const SPEC_KIT_GIT = 'git+https://github.com/github/spec-kit.git'

export function pinnedSpecify(...args: string[]): string[] {
  return ['--from', SPEC_KIT_GIT, 'specify', ...args]
}

function specsDir(projectPath: string): string {
  return join(projectPath, 'specs')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function isSpecKitInstalled(projectPath: string): Promise<boolean> {
  return exists(join(projectPath, '.specify'))
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function parseTitle(specMd: string | null, id: string): string {
  if (!specMd) return id
  const h1 = specMd.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/m)
  return h1 ? h1[1].trim() : id
}

function parseDescription(specMd: string | null): string {
  if (!specMd) return ''
  const summary = specMd.match(/^##\s+Summary\s*\n+([^\n#][^\n]*(?:\n[^\n#][^\n]*)*)/m)
  if (summary) return summary[1].replace(/\s+/g, ' ').trim().slice(0, 400)
  for (const raw of specMd.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('**') || line.startsWith('|')) continue
    return line.slice(0, 400)
  }
  return ''
}

function parseSections(markdown: string | null): SpecSection[] {
  if (!markdown) return []
  const sections: SpecSection[] = []
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)]
  for (let i = 0; i < matches.length; i += 1) {
    const title = matches[i][1].replace(/\*/g, '').trim()
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? markdown.length) : markdown.length
    const body = markdown.slice(start, end).trim()
    if (title && body) sections.push({ title, body })
  }
  return sections
}

const TASK_LINE = /^\s*-\s*\[( |x|X)\]\s*(T\d+)?\s*(.*)$/

function parseTasks(tasksMd: string | null): { phases: SpecPhase[]; total: number; done: number } {
  if (!tasksMd) return { phases: [], total: 0, done: 0 }
  const phases: SpecPhase[] = []
  let current: SpecPhase | null = null
  let total = 0
  let done = 0
  for (const raw of tasksMd.split(/\r?\n/)) {
    const phaseMatch = raw.match(/^##\s+(.+)$/)
    if (phaseMatch && /phase/i.test(phaseMatch[1])) {
      current = { label: phaseMatch[1].replace(/\*/g, '').trim(), tasks: [] }
      phases.push(current)
      continue
    }
    const taskMatch = raw.match(TASK_LINE)
    if (!taskMatch) continue
    const label = taskMatch[3].trim()
    if (!label) continue
    const isDone = taskMatch[1].toLowerCase() === 'x'
    total += 1
    if (isDone) done += 1
    if (!current) {
      current = { label: 'Tasks', tasks: [] }
      phases.push(current)
    }
    const task: SpecTask = { id: taskMatch[2] ?? '', label, done: isDone }
    current.tasks.push(task)
  }
  return { phases: phases.filter((p) => p.tasks.length > 0), total, done }
}

function parseClarifications(specMd: string | null): string[] {
  if (!specMd) return []
  return [...specMd.matchAll(/\[NEEDS CLARIFICATION:?\s*([^\]]*)\]/gi)].map(
    (m) => m[1].trim() || 'Unspecified clarification',
  )
}

function parseResolvedClarifications(specMd: string | null): ResolvedClarification[] {
  if (!specMd) return []
  const heading = specMd.match(/^##\s+Clarifications\s*$/m)
  if (!heading || heading.index === undefined) return []
  const start = heading.index + heading[0].length
  const nextHeading = specMd.slice(start).search(/\n##\s/)
  const body = nextHeading === -1 ? specMd.slice(start) : specMd.slice(start, start + nextHeading)
  return [...body.matchAll(/^\s*-\s*Q:\s*(.+?)\s*(?:→|->|—)\s*A:\s*(.+)$/gm)].map((m) => ({
    question: m[1].trim(),
    answer: m[2].trim(),
  }))
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

const TEMPLATE_MARKERS = /\[(?:PROJECT_NAME|PRINCIPLE_\d+_NAME|PRINCIPLE_\d+_DESCRIPTION)\]/

export async function readConstitutionState(projectPath: string): Promise<ConstitutionState> {
  const text = await readFileSafe(join(projectPath, '.specify', 'memory', 'constitution.md'))
  if (!text?.trim()) return 'missing'
  return TEMPLATE_MARKERS.test(text) ? 'template' : 'written'
}

export function isExtensionInstalled(projectPath: string, name: SddProcess): Promise<boolean> {
  return exists(join(projectPath, '.specify', 'extensions', name, 'extension.yml'))
}

export async function readSddEntries(projectPath: string, process: SddProcess): Promise<SddEntry[]> {
  const root = join(projectPath, '.specify', SDD_DIRS[process])
  const slugs = (await listDirs(root)).filter(isSddSlug)
  return Promise.all(
    slugs.map(async (slug) => {
      const texts = await Promise.all(
        SDD_REPORTS[process].map(async (report) => ({
          file: report.file,
          text: await readFileSafe(join(root, slug, report.file)),
        })),
      )
      const text = (file: string): string | null => texts.find((entry) => entry.file === file)?.text ?? null
      const first = texts.find((entry) => entry.text !== null)?.text ?? null
      return {
        slug,
        title: reportTitle(first) ?? slug,
        files: texts.filter((entry) => entry.text !== null).map((entry) => entry.file),
        verdict: process === 'bug' ? bugResultOf(text('test.md')) : decisionOf(text('decision.md')),
        severity: process === 'bug' ? severityOf(text('assessment.md')) : null,
      }
    }),
  )
}

export async function readSddReport(
  projectPath: string,
  process: SddProcess,
  slug: string,
  file: string,
): Promise<{ path: string; content: string } | null> {
  if (!isSddSlug(slug) || !SDD_REPORTS[process].some((report) => report.file === file)) return null
  const path = `.specify/${SDD_DIRS[process]}/${slug}/${file}`
  const content = await readFileSafe(join(projectPath, path))
  return content === null ? null : { path, content }
}

export async function readSpecKitState(projectPath: string): Promise<SpecKitState> {
  const [installed, ids, constitution, bugs, ideas, bug, assess] = await Promise.all([
    isSpecKitInstalled(projectPath),
    listDirs(specsDir(projectPath)),
    readConstitutionState(projectPath),
    readSddEntries(projectPath, 'bug'),
    readSddEntries(projectPath, 'assess'),
    isExtensionInstalled(projectPath, 'bug'),
    isExtensionInstalled(projectPath, 'assess'),
  ])
  const specs = await Promise.all(ids.map((id) => summarise(projectPath, id)))
  return { installed, specs, constitution, bugs, ideas, extensions: { bug, assess } }
}

export async function readSpecDetail(projectPath: string, id: string): Promise<SpecDetail | null> {
  if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') return null
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
  const converging = phases.filter((phase) => /convergence/i.test(phase.label))
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
    convergence: {
      rounds: converging.length,
      open: converging.reduce((sum, phase) => sum + phase.tasks.filter((task) => !task.done).length, 0),
    },
  }
}

export interface CommandResult {
  code: number | null
  missing: boolean
  output: string
}

export type CommandRunner = (file: string, args: readonly string[], cwd: string) => Promise<CommandResult>

export const execFileRunner: CommandRunner = (file, args, cwd) =>
  new Promise((resolvePromise) => {
    execFile(
      file,
      [...args],
      {
        cwd,
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`
        const code = (error as { code?: unknown } | null)?.code
        resolvePromise({
          code: error ? (typeof code === 'number' ? code : null) : 0,
          missing: code === 'ENOENT',
          output: error && !output.trim() ? error.message : output,
        })
      },
    )
  })

function plainOutput(output: string): string {
  const text = output.replace(/\s+/g, ' ').trim()
  const at = text.indexOf('Error:')
  return (at === -1 ? text : text.slice(at + 'Error:'.length).trim()).slice(0, 600)
}

export async function installSpecKit(projectPath: string, run: CommandRunner = execFileRunner): Promise<void> {
  const script = process.platform === 'win32' ? 'ps' : 'sh'
  const result = await run(
    'uvx',
    pinnedSpecify('init', '--here', '--force', '--integration', 'claude', '--script', script, '--ignore-agent-tools'),
    projectPath,
  )
  if (result.missing) {
    throw {
      code: 'UNSUPPORTED',
      message: 'uvx is not on this machine’s PATH, so Spec Kit cannot be set up. Install uv and try again.',
    } satisfies IpcError
  }
  if (result.code !== 0 || !(await isSpecKitInstalled(projectPath))) {
    throw {
      code: 'INTERNAL',
      message: `Spec Kit could not be set up: ${plainOutput(result.output) || 'specify init printed nothing.'}`,
    } satisfies IpcError
  }
}

export async function installExtension(
  projectPath: string,
  name: SddProcess,
  run: CommandRunner = execFileRunner,
): Promise<void> {
  if (!(await isSpecKitInstalled(projectPath))) {
    throw { code: 'UNSUPPORTED', message: 'Set up Spec Kit in this project before adding an extension.' } satisfies IpcError
  }
  const result = await run('uvx', pinnedSpecify('extension', 'add', name), projectPath)
  if (result.missing) {
    throw {
      code: 'UNSUPPORTED',
      message: 'uvx is not on this machine’s PATH, so the extension cannot be added. Install uv and try again.',
    } satisfies IpcError
  }
  if (result.code !== 0 || !(await isExtensionInstalled(projectPath, name))) {
    const exit = result.code === null ? '' : ` with exit code ${result.code}`
    throw {
      code: 'INTERNAL',
      message: `specify extension add ${name} failed${exit}: ${plainOutput(result.output) || 'it printed nothing.'}`,
    } satisfies IpcError
  }
}
