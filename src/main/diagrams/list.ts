// Reading a project's diagram folder. Extracted from the `diagrams.list` handler
// because it now has two callers that must not drift: the handler answering the
// section's own request, and the push that fires the moment a drawing session
// finishes its turn (see DiagramsChangedPush). Two copies of "what is in this
// folder" is how the pushed list and the fetched list come to disagree about the
// same directory.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiagramEntry } from '@shared/domain'
import { DIAGRAMS_DIR } from '@shared/diagram'

/** What the app recorded about a diagram it asked for, keyed by file name. */
export interface DiagramRequestInfo {
  description: string | null
  sessionId: string | null
  plan: unknown
}

/**
 * Every diagram in a project's folder, newest first.
 *
 * The FOLDER is the list. A file the app never asked for still appears, with
 * nulls for everything only a request could have told it — a diagram committed
 * by someone else, or drawn before this app existed, is still a diagram. A
 * missing folder is a project that has generated nothing, not a failure, so
 * ENOENT is the one rejection folded into an empty list; anything else (a
 * permission error, a path that is not a directory) propagates, because
 * reporting "no diagrams" for a folder that could not be read would be a lie
 * the section has no way to notice.
 *
 * Fully asynchronous: this runs in the main process, on the thread that draws
 * the window, and it used to be existsSync plus a statSync per file.
 */
export async function readDiagramList(
  projectPath: string,
  requests: Map<string, DiagramRequestInfo>,
): Promise<DiagramEntry[]> {
  const dir = join(projectPath, DIAGRAMS_DIR)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.toLowerCase().endsWith('.html'))
      .map(async (file): Promise<DiagramEntry> => {
        const info = await stat(join(dir, file))
        const known = requests.get(file)
        return {
          file,
          path: `${DIAGRAMS_DIR}/${file}`,
          description: known?.description ?? null,
          sessionId: known?.sessionId ?? null,
          plan: (known?.plan ?? null) as DiagramEntry['plan'],
          modifiedAt: info.mtime.toISOString(),
          bytes: info.size,
        }
      }),
  )
  // Newest first: the one just drawn is the one being looked for.
  return entries.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
}
