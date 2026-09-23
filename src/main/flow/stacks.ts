import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FlowStackId } from '@shared/domain'

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'bin', 'obj', '.git', '.worktrees'])

const MAX_DEPTH = 3

async function walk(dir: string, depth: number, onEntry: (name: string) => void): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const nested: Promise<void>[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      nested.push(walk(join(dir, entry.name), depth + 1, onEntry))
      continue
    }
    onEntry(entry.name)
  }
  await Promise.all(nested)
}

export async function detectFlowStacks(projectPath: string): Promise<FlowStackId[]> {
  let dotnet = false
  let angular = false
  await walk(projectPath, 0, (name) => {
    const lower = name.toLowerCase()
    if (lower.endsWith('.sln') || lower.endsWith('.slnx') || lower.endsWith('.csproj'))
      dotnet = true
    if (lower === 'angular.json') angular = true
  })
  const stacks: FlowStackId[] = []
  if (dotnet) stacks.push('dotnet')
  if (angular) stacks.push('angular')
  return stacks
}
