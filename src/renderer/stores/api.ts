// API eval sets per project: the endpoints the app found, where it would call
// them, and the runs it has made. Mirrors the verify store's view/transport split
// — every mutation answers with the project's full list, so nothing merges.
import { reactive } from 'vue'
import type { ApiEvalRun, ApiTarget, DiscoveredEndpoint } from '@shared/api-endpoints'
import { errorMessage, invoke } from '@renderer/ipc'

interface HostInfo {
  baseUrl: string | null
  startCmd: string | null
  from: string | null
  error: string | null
}

/** The deployed environment: what is stored, and why a run there would fail now. */
interface QaInfo {
  baseUrl: string | null
  headers: string | null
  error: string | null
}

// Guards the shared state against a slower response from a project the developer
// has already switched away from (mirrors evals.load).
let requestToken = 0

const loadEndpoints = (projectId: string) => invoke('api.endpoints', { projectId })

const store = reactive({
  runs: {} as Record<string, ApiEvalRun[]>,
  endpoints: {} as Record<string, DiscoveredEndpoint[]>,
  recent: {} as Record<string, { method: string; template: string }[]>,
  host: {} as Record<string, HostInfo>,
  qa: {} as Record<string, QaInfo>,
  scan: {} as Record<string, { filesRead: number; truncated: boolean }>,
  error: null as string | null,
  starting: false,
  /** The report file the last write produced, so the panel can offer to open it. */
  reportPath: null as string | null,

  runsFor(projectId: string): ApiEvalRun[] {
    return this.runs[projectId] ?? []
  },

  /** The run the panel renders: the newest, running or finished. */
  latestFor(projectId: string): ApiEvalRun | null {
    return this.runsFor(projectId)[0] ?? null
  },

  endpointsFor(projectId: string): DiscoveredEndpoint[] {
    return this.endpoints[projectId] ?? []
  },

  recentFor(projectId: string): { method: string; template: string }[] {
    return this.recent[projectId] ?? []
  },

  hostFor(projectId: string): HostInfo | null {
    return this.host[projectId] ?? null
  },

  qaFor(projectId: string): QaInfo | null {
    return this.qa[projectId] ?? null
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    let runs: ApiEvalRun[]
    let found: Awaited<ReturnType<typeof loadEndpoints>>
    try {
      ;[runs, found] = await Promise.all([invoke('api.runs', { projectId }), loadEndpoints(projectId)])
    } catch (error) {
      // A failed load leaves the panel with whatever it had and says why, rather
      // than an empty list that reads as "this project has no endpoints".
      this.error = errorMessage(error)
      return
    }
    if (token !== requestToken) return
    this.runs[projectId] = runs
    this.endpoints[projectId] = found.endpoints
    this.recent[projectId] = found.recent
    this.host[projectId] = found.host
    this.qa[projectId] = found.qa
    this.scan[projectId] = { filesRead: found.filesRead, truncated: found.truncated }
  },

  applyPush(projectId: string, runs: ApiEvalRun[]): void {
    this.runs[projectId] = runs
  },

  /** Start an eval set over the chosen endpoints. True when it was dispatched. */
  async start(
    projectId: string,
    endpoints: { method: string; template: string }[],
    target: ApiTarget = 'local',
  ): Promise<boolean> {
    this.error = null
    this.starting = true
    this.reportPath = null
    try {
      const { runs } = await invoke('api.start', { projectId, endpoints, target })
      this.runs[projectId] = runs
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    } finally {
      this.starting = false
    }
  },

  /** Stop an eval set in progress. Reaches the session being asked for request
   *  data; a run already mid-flight in the app's own call loop finishes itself. */
  async cancel(projectId: string, runId: string): Promise<boolean> {
    this.error = null
    try {
      this.runs[projectId] = await invoke('api.cancel', { projectId, runId })
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },

  /** Set (or clear, with an empty string) where this project's API lives. */
  async setHost(
    projectId: string,
    fields: { baseUrl?: string; startCmd?: string; qaBaseUrl?: string; qaHeaders?: string },
  ): Promise<void> {
    this.error = null
    try {
      await invoke('api.setHost', { projectId, ...fields })
      await this.load(projectId)
    } catch (error) {
      this.error = errorMessage(error)
    }
  },

  /** Write the run's test report and remember where it landed. */
  async writeReport(projectId: string, runId?: string): Promise<void> {
    this.error = null
    this.reportPath = null
    try {
      const { path } = await invoke('api.report', { projectId, runId })
      this.reportPath = path
    } catch (error) {
      this.error = errorMessage(error)
    }
  },
})

export const useApiStore = (): typeof store => store
