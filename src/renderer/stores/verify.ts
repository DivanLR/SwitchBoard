// Verification-run state per project: the runs, their reports, and the transport
// for starting one. Mirrors the evals store (view/transport separation): every
// mutation answers with the project's full list, so there is nothing to merge.
import { reactive } from 'vue'
import type { VerifyRun } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * A Tests-section dispatch can spawn the project's dedicated tests session, and
 * the sidebar only learns about a session it already knows: `applyStatusPush`
 * patches a session id present in `item.sessions` and does not insert an unknown
 * one. Without this refresh the run happens in a session with no row anywhere on
 * screen, which is worse than blocking the chat — at least a blocked chat is
 * visible.
 *
 * `refresh()` re-applies the developer's own focus afterwards, so surfacing the
 * tests session never moves the centre pane off the conversation.
 */
async function surfaceNewSessions(): Promise<void> {
  await useProjectsStore().refresh()
}

// Guards the shared list against a slower response from a project the developer
// has already switched away from (mirrors evals.load).
let requestToken = 0

const store = reactive({
  byProject: {} as Record<string, VerifyRun[]>,
  error: null as string | null,
  /** True between the click and the dispatch landing, so the button can't double-fire. */
  starting: false,

  listFor(projectId: string): VerifyRun[] {
    return this.byProject[projectId] ?? []
  },

  /** The run the panels render: the newest, running or finished. */
  latestFor(projectId: string): VerifyRun | null {
    return this.listFor(projectId)[0] ?? null
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    const runs = await invoke('verify.list', { projectId })
    if (token !== requestToken) return
    this.byProject[projectId] = runs
  },

  applyPush(projectId: string, runs: VerifyRun[]): void {
    this.byProject[projectId] = runs
  },

  /**
   * Start a run over the chosen suites.
   *
   * `isolated` runs each suite in its own fresh container, sequentially, rather
   * than sharing the project's one background container for the whole run — the
   * opt-in fix for a heavy suite killing that shared container's memory ceiling
   * out from under the others (exit 137, SIGKILL, no stderr). Defaulted to
   * false so every existing caller keeps dispatching exactly as it always has.
   *
   * Resolves to true when it was dispatched.
   */
  async start(
    projectId: string,
    stackId: string,
    suiteIds: string[],
    isolated = false,
  ): Promise<boolean> {
    this.error = null
    this.starting = true
    try {
      const { runs } = await invoke('verify.start', { projectId, stackId, suiteIds, isolated })
      this.byProject[projectId] = runs
      await surfaceNewSessions()
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    } finally {
      this.starting = false
    }
  },

  /** Stop a run in progress. The row closes as inconclusive saying you stopped
   *  it, which is a different thing from a session that gave up on its own. */
  async cancel(projectId: string, runId: string): Promise<boolean> {
    this.error = null
    try {
      this.byProject[projectId] = await invoke('verify.cancel', { projectId, runId })
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },

  /** Capture evidence against the newest run, without re-running its suites. */
  async captureEvidence(projectId: string, runId?: string): Promise<boolean> {
    this.error = null
    try {
      const { runs } = await invoke('verify.evidence', { projectId, runId })
      this.byProject[projectId] = runs
      await surfaceNewSessions()
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },
})

export const useVerifyStore = (): typeof store => store
