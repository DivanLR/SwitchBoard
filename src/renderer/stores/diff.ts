// Diff tab: changed files in a project's working tree, and one selected
// file's diff content. The store owns diff.* transport (view/transport
// separation), mirroring stores/specs.ts.
import { reactive } from 'vue'
import type { DiffListResult, FileDiffContent } from '@shared/domain'
import { invoke } from '@renderer/ipc'
import { isIpcError } from '@shared/ipc-types'

// Two independent counters, not one shared: a background list refresh (the
// turn-complete cadence) and an interactive file selection must not cancel
// each other out, the way stores/specs.ts's polling deliberately bypasses its
// own token rather than sharing it with spec selection.
let listToken = 0
let fileToken = 0

const store = reactive({
  byProject: {} as Record<string, DiffListResult>,
  /** Projects confirmed to have no live session — distinct from "no
   *  changes" (an empty `files` list) and "can't be read" (`gitNotice` set). */
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

  /** Loads (or refreshes) a project's changed-file list. A project switch
   *  drops the current selection; a same-project refresh (the existing
   *  turn-complete cadence) leaves it alone so a session that keeps working
   *  doesn't yank the developer's open diff out from under them. */
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
      if (token !== listToken) return // a newer load superseded this
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

  /**
   * Hands a selected region and an instruction to the containerised session.
   *
   * The session runs with /workspace bind-mounted read-write, so the edit lands
   * in the working tree this very diff is reading. `applying` is a single flag
   * rather than one per file: only one region can be selected at a time, so a
   * second dispatch is a second thing to wait for, not a parallel one.
   *
   * Errors are held rather than thrown. The caller is a composer sitting over a
   * diff, and the useful place to say "no live session" is in that composer,
   * beside the button that was pressed.
   */
  applying: false,
  applyError: null as string | null,
  /** The session the last dispatch went to, so the view can offer to watch it. */
  appliedSessionId: null as string | null,

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
      this.appliedSessionId = sessionId
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

  /** Fetches one file's diff content, only on selection (FR-006). */
  async selectFile(projectId: string, path: string): Promise<void> {
    const token = ++fileToken
    this.selectedPath = path
    this.fileDiff = null
    this.fileLoading = true
    try {
      const diff = await invoke('diff.file', { projectId, path })
      if (token !== fileToken) return // a newer selection superseded this
      this.fileDiff = diff
    } finally {
      if (token === fileToken) this.fileLoading = false
    }
  },
})

export const useDiffStore = (): typeof store => store
