import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectArtefacts, type ArtefactFile, type RunArtefacts } from './artefacts'

const ARTEFACT_DIRS = ['TestResults', 'StrykerOutput', 'coverage', 'artifacts', '.']

const MAX_DEPTH = 4

const MAX_FILES = 4000

export function scanArtefacts(projectPath: string, since: number): RunArtefacts {
  const walk = (): ArtefactFile[] => {
    const found: ArtefactFile[] = []
    const visit = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH || found.length >= MAX_FILES) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (found.length >= MAX_FILES) return
        const full = join(dir, name)
        let info: ReturnType<typeof statSync>
        try {
          info = statSync(full)
        } catch {
          continue
        }
        if (info.isDirectory()) {
          if (name === 'node_modules' || name === '.git' || name === 'obj' || name === 'bin') continue
          visit(full, depth + 1)
        } else if (info.mtimeMs >= since) {
          found.push({ path: full, mtime: info.mtimeMs })
        }
      }
    }
    for (const dir of ARTEFACT_DIRS) visit(join(projectPath, dir), dir === '.' ? MAX_DEPTH - 1 : 1)
    return found
  }

  return collectArtefacts(walk, (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  })
}
