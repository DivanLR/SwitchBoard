// Finding a run's artefact files on disk. The parsing and the reconciliation are
// in artefacts.ts and are pure; only the walk lives here, so node:fs stays out of
// the testable half.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectArtefacts, type ArtefactFile, type RunArtefacts } from './artefacts'

/**
 * Where test runners actually leave their reports. Named directories rather than a
 * whole-tree walk: a project can hold a hundred thousand files, and a verification
 * run finishing is not the moment to walk them.
 */
const ARTEFACT_DIRS = ['TestResults', 'StrykerOutput', 'coverage', 'artifacts', '.']

/** How deep to look inside each. `TestResults/<guid>/coverage.cobertura.xml` is
 *  two, `StrykerOutput/<timestamp>/reports/mutation-report.json` is three. */
const MAX_DEPTH = 4

/** Stop a pathological tree from turning this into a full crawl. */
const MAX_FILES = 4000

/**
 * The artefacts a run produced, read and parsed.
 *
 * `since` is the run's own start time, and it is the honesty guard: a TRX file
 * left by last week's run is not evidence about this one. A file older than the
 * run is ignored outright, so the figure stays unmeasured rather than being filled
 * in from something stale.
 *
 * Anything unreadable is treated as absent. A permissions error must not turn into
 * a claim about the code.
 */
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
