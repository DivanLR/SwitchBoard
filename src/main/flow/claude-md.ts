import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FlowLesson } from '@shared/domain'

const execFileAsync = promisify(execFile)

export const INSTRUCTIONS_FILE = 'CLAUDE.md'

const LEARNED_HEADING = '## Learned from review'

export function instructionsPath(projectPath: string): string {
  return join(projectPath, INSTRUCTIONS_FILE)
}

export async function isIgnored(projectPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', projectPath, 'check-ignore', '-q', INSTRUCTIONS_FILE], {
      timeout: 8000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

function headingIndex(lines: readonly string[], heading: string): number {
  const wanted = heading.trim().toLowerCase().replace(/^#+\s*/, '')
  return lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && line.replace(/^#+\s*/, '').trim().toLowerCase() === wanted,
  )
}

function sectionEnd(lines: readonly string[], from: number): number {
  for (let i = from + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) return i
  }
  return lines.length
}

export function withRule(
  current: string,
  lesson: Pick<FlowLesson, 'rule' | 'section'>,
): { text: string; addedLines: number } {
  const bullet = `- ${lesson.rule.trim().replace(/\s+/g, ' ')}`
  const lines = current.length === 0 ? [] : current.replace(/\r\n/g, '\n').split('\n')
  if (lines.some((line) => line.trim() === bullet)) return { text: current, addedLines: 0 }

  const target = lesson.section ? headingIndex(lines, lesson.section) : -1
  if (target >= 0) {
    const end = sectionEnd(lines, target)
    let at = end
    while (at > target + 1 && lines[at - 1].trim() === '') at -= 1
    const next = [...lines.slice(0, at), bullet, ...lines.slice(at)]
    return { text: `${next.join('\n').replace(/\n+$/, '')}\n`, addedLines: 1 }
  }

  const learned = headingIndex(lines, LEARNED_HEADING)
  if (learned >= 0) {
    const end = sectionEnd(lines, learned)
    let at = end
    while (at > learned + 1 && lines[at - 1].trim() === '') at -= 1
    const next = [...lines.slice(0, at), bullet, ...lines.slice(at)]
    return { text: `${next.join('\n').replace(/\n+$/, '')}\n`, addedLines: 1 }
  }

  const body = lines.join('\n').replace(/\n+$/, '')
  const prefix = body.length > 0 ? `${body}\n\n` : ''
  return { text: `${prefix}${LEARNED_HEADING}\n\n${bullet}\n`, addedLines: 3 }
}

export async function appendRule(
  projectPath: string,
  lesson: Pick<FlowLesson, 'rule' | 'section'>,
): Promise<{ appliedLines: number; path: string }> {
  const path = instructionsPath(projectPath)
  const current = existsSync(path) ? await readFile(path, 'utf8') : ''
  const { text, addedLines } = withRule(current, lesson)
  if (addedLines > 0) await writeFile(path, text, 'utf8')
  return { appliedLines: addedLines, path }
}
