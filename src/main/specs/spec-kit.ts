import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpecKitState, SpecStatus, SpecSummary } from '@shared/domain'

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

function parseTitle(specMd: string | null, id: string): string {
  if (!specMd) return id
  const h1 = specMd.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/m)
  return h1 ? h1[1].trim() : id
}

const TASK_LINE = /^\s*-\s*\[( |x|X)\]\s*(T\d+)?\s*(.*)$/

function parseTasks(tasksMd: string | null): { total: number; done: number } {
  let total = 0
  let done = 0
  for (const raw of tasksMd?.split('\n') ?? []) {
    const taskMatch = raw.match(TASK_LINE)
    if (!taskMatch || !taskMatch[3].trim()) continue
    total += 1
    if (taskMatch[1].toLowerCase() === 'x') done += 1
  }
  return { total, done }
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
