import { reactive } from 'vue'
import type { DiffListResult, FileDiffContent } from '@shared/domain'
import { invoke } from '@renderer/ipc'
import { isIpcError } from '@shared/ipc-types'

let listToken = 0
let fileToken = 0

const store = reactive({
  byProject: {} as Record<string, DiffListResult>,
  notLiveFor: {} as Record<string, boolean>,
  loading: false,
  lastProjectId: null as string | null,
  selectedPath: null as string | null,
  fileDiff: null as FileDiffContent | null,
  fileLoading: false,

  resultFor(projectId: string): DiffListResult {
    return this.byProject[projectId] ?? { gitNotice: null, files: [] }
  },

  isNotLive(projectId: string): boolean {
    return this.notLiveFor[projectId] ?? false
  },

  async loadList(projectId: string): Promise<void> {
    const token = ++listToken
    if (projectId !== this.lastProjectId) {
      this.selectedPath = null
      this.fileDiff = null
    }
    this.lastProjectId = projectId
    this.loading = true
    try {
      const result = await invoke('diff.list', { projectId })
      if (token !== listToken) return 
      this.byProject[projectId] = result
      this.notLiveFor[projectId] = false
    } catch (e) {
      if (token !== listToken) return
      if (isIpcError(e) && e.code === 'NOT_LIVE') {
        this.notLiveFor[projectId] = true
      } else {
        throw e
      }
    } finally {
      if (token === listToken) this.loading = false
    }
  },

  applying: false,
  applyError: null as string | null,
  appliedFor: {} as Record<string, string>,

  async applyToRegion(
    projectId: string,
    path: string,
    lines: string[],
    instruction: string,
  ): Promise<boolean> {
    if (this.applying) return false
    this.applying = true
    this.applyError = null
    try {
      const { sessionId } = await invoke('diff.apply', { projectId, path, lines, instruction })
      this.appliedFor[projectId] = sessionId
      return true
    } catch (e) {
      this.applyError = isIpcError(e)
        ? e.code === 'NOT_LIVE'
          ? 'Start a session for this project first.'
          : e.message
        : 'That could not be sent.'
      return false
    } finally {
      this.applying = false
    }
  },

  hideApplied(projectId: string): void {
    delete this.appliedFor[projectId]
  },

  async selectFile(projectId: string, path: string): Promise<void> {
    const token = ++fileToken
    this.selectedPath = path
    this.fileDiff = null
    this.fileLoading = true
    try {
      const diff = await invoke('diff.file', { projectId, path })
      if (token !== fileToken) return 
      this.fileDiff = diff
    } finally {
      if (token === fileToken) this.fileLoading = false
    }
  },
})

export const useDiffStore = (): typeof store => store
