import { reactive } from 'vue'
import type { DiagramEntry } from '@shared/domain'
import type { ArchifyOptions, DiagramFilePick } from '@shared/diagram'
import { diagramCommandForFile } from '@shared/diagram'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

let loadToken = 0

const store = reactive({
  byProject: {} as Record<string, DiagramEntry[]>,
  loading: false,
  generating: false,
  pending: null as
    | { projectId: string; file: string; description: string; sessionId: string }
    | null,
  selected: null as { projectId: string; file: string } | null,
  html: {} as Record<string, string>,
  error: null as string | null,

  forProject(projectId: string): DiagramEntry[] {
    return this.byProject[projectId] ?? []
  },

  async load(projectId: string): Promise<void> {
    const token = ++loadToken
    this.loading = true
    try {
      const list = await invoke('diagrams.list', { projectId })
      if (token !== loadToken) return 
      this.byProject[projectId] = list
      this.error = null
    } catch (e) {
      if (token !== loadToken) return
      this.error = errorMessage(e)
    } finally {
      if (token === loadToken) this.loading = false
    }
  },

  async generate(
    projectId: string,
    description: string,
    archify?: ArchifyOptions,
    name?: string,
  ): Promise<boolean> {
    this.generating = true
    this.error = null
    try {
      const { file, sessionId } = await invoke('diagrams.generate', {
        projectId,
        description,
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(archify ? { archify } : {}),
      })
      this.pending = { projectId, file, description, sessionId }
      const projects = useProjectsStore()
      await projects.refresh()
      projects.focusSession(projectId, sessionId)
      void this.awaitFile(projectId, file)
      return true
    } catch (e) {
      this.error = errorMessage(e)
      return false
    } finally {
      this.generating = false
    }
  },

  async awaitFile(projectId: string, file: string): Promise<void> {
    const deadline = Date.now() + 20 * 60_000
    const POLL_MS = 2500
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      if (this.pending?.projectId !== projectId || this.pending.file !== file) return

      const drawing = await invoke('sessions.fate', { sessionId: this.pending.sessionId }).catch(
        () => null,
      )
      if (drawing?.endedAt) {
        await this.load(projectId)
        if (this.forProject(projectId).some((d) => d.file === file)) {
          this.pending = null
          await this.select(projectId, file)
          return
        }
        this.error =
          drawing.statusDetail ??
          `The session drawing ${file} ended before it wrote anything. Open that session to see why, or ask again.`
        this.pending = null
        return
      }

      await this.load(projectId)
      if (this.forProject(projectId).some((d) => d.file === file)) {
        this.pending = null
        await this.select(projectId, file)
        return
      }
    }
    if (this.pending?.file === file) {
      this.error = `${file} has not appeared after twenty minutes. The background session may still be drawing it, or it may have failed — open that session to see, or ask again.`
      this.pending = null
    }
  },

  applyChanged(projectId: string, entries: DiagramEntry[]): void {
    this.byProject[projectId] = entries
    const waiting = this.pending
    if (!waiting || waiting.projectId !== projectId) return
    if (!entries.some((d) => d.file === waiting.file)) return
    this.pending = null
    void this.select(projectId, waiting.file)
  },

  async open(projectId: string, file: string): Promise<void> {
    try {
      await invoke('diagrams.open', { projectId, file })
    } catch (e) {
      this.error = errorMessage(e)
    }
  },

  async pickFile(command: string): Promise<string | null> {
    try {
      return (await invoke('dialog.pickFile', { command })).path
    } catch (e) {
      this.error = errorMessage(e)
      return null
    }
  },

  async pickImport(): Promise<{ path: string; command: DiagramFilePick } | null> {
    const path = await this.pickFile('import')
    if (!path) return null
    const command = diagramCommandForFile(path)
    if (!command) {
      const name = path.replace(/^.*[\\/]/, '')
      this.error =
        `Nothing here reads ${name}. Import a .drawio, .mmd or .xml file, ` +
        'or an .html diagram to export.'
      return null
    }
    this.error = null
    return { path, command }
  },

  async select(projectId: string, file: string): Promise<void> {
    this.selected = { projectId, file }
    if (this.html[file] !== undefined) return
    try {
      const { html } = await invoke('diagrams.read', { projectId, file })
      if (this.selected?.file !== file) return
      this.html[file] = html
    } catch (e) {
      this.error = errorMessage(e)
      this.selected = null
    }
  },
})

export const useDiagramsStore = (): typeof store => store
