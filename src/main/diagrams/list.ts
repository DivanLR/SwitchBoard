import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiagramEntry } from '@shared/domain'
import { DIAGRAMS_DIR } from '@shared/diagram'

interface DiagramRequestInfo {
  description: string | null
  sessionId: string | null
  plan: unknown
}

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
  return entries.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
}
