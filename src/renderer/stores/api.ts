import { reactive } from 'vue'
import type { ApiEvalRun, ApiTarget, DiscoveredEndpoint } from '@shared/api-endpoints'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

interface HostInfo {
  baseUrl: string | null
  startCmd: string | null
  from: string | null
  error: string | null
}

interface QaInfo {
  baseUrl: string | null
  headers: string | null
  error: string | null
}

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
  reportPath: null as string | null,

  runsFor(projectId: string): ApiEvalRun[] {
    return this.runs[projectId] ?? []
  },

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
      await useProjectsStore().refresh()
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    } finally {
      this.starting = false
    }
  },

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
