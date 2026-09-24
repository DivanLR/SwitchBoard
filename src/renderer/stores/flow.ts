import { computed, reactive, toRefs } from 'vue'
import type { FlowFeature, FlowRun, FlowStackId, FlowStage, FlowStageLive, FlowStageRecord } from '@shared/domain'
import { isIpcError, type FlowArtefactKind, type FlowCompanionRequest, type FlowStartSource, type FlowSnapshot } from '@shared/ipc-types'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

let requestToken = 0
let listToken = 0

const state = reactive({
  runsByProject: {} as Record<string, FlowRun[]>,
  stagesByProject: {} as Record<string, FlowStageRecord[]>,
  liveByProject: {} as Record<string, FlowStageLive[]>,
  focusRunRequest: null as { projectId: string; runId: string } | null,
  projectId: null as string | null,
  features: [] as FlowFeature[],
  featuresNote: null as string | null,
  featuresSkipped: null as string | null,
  searching: null as 'search' | 'reconnect' | null,
  listingByProject: {} as Record<string, string | null>,
  signingInByProject: {} as Record<string, boolean>,
  adoDown: null as string | null,
  adoNeedsAuth: false,
  existingSpecs: [] as { id: string; title: string }[],
  stacksByProject: {} as Record<string, FlowStackId[]>,
  busy: null as string | null,
  error: null as string | null,
  seed: null as { projectId: string; source: FlowStartSource } | null,
})

const runs = computed<FlowRun[]>(() =>
  state.projectId ? (state.runsByProject[state.projectId] ?? []) : [],
)

const stagesByRun = computed(() => {
  const byRun = new Map<string, FlowStageRecord[]>()
  const stages = state.projectId ? (state.stagesByProject[state.projectId] ?? []) : []
  for (const stage of stages) {
    const list = byRun.get(stage.runId)
    if (list) list.push(stage)
    else byRun.set(stage.runId, [stage])
  }
  return byRun
})

const liveByRun = computed(() => {
  const byRun = new Map<string, FlowStageLive>()
  const live = state.projectId ? (state.liveByProject[state.projectId] ?? []) : []
  for (const entry of live) byRun.set(entry.runId, entry)
  return byRun
})

const store = reactive({
  ...toRefs(state),
  runs,

  runsFor(projectId: string): FlowRun[] {
    return state.runsByProject[projectId] ?? []
  },

  stagesFor(runId: string): FlowStageRecord[] {
    return stagesByRun.value.get(runId) ?? []
  },

  liveFor(runId: string): FlowStageLive | null {
    return liveByRun.value.get(runId) ?? null
  },

  focusRun(projectId: string, runId: string): void {
    state.focusRunRequest = { projectId, runId }
  },

  takeFocusedRun(projectId: string): string | null {
    const request = state.focusRunRequest
    if (request?.projectId !== projectId) return null
    state.focusRunRequest = null
    return request.runId
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    state.projectId = projectId
    state.error = null
    try {
      const snapshot = await invoke('flow.list', { projectId })
      if (token !== requestToken) return
      this.applyPush(projectId, snapshot.runs, snapshot.stages, snapshot.live, snapshot.listing, snapshot.signingIn)
    } catch (error) {
      if (token !== requestToken) return
      state.error = errorMessage(error)
      state.runsByProject[projectId] ??= []
    }
  },

  applyPush(
    projectId: string,
    runs: FlowRun[],
    stages: FlowStageRecord[],
    live: FlowStageLive[] = [],
    listing: string | null = null,
    signingIn = false,
  ): void {
    state.runsByProject[projectId] = runs
    state.stagesByProject[projectId] = stages
    state.liveByProject[projectId] = live
    state.listingByProject[projectId] = listing
    state.signingInByProject[projectId] = signingIn
  },

  async searchFeatures(projectId: string, query: string, reconnect = false): Promise<void> {
    const token = ++listToken
    state.error = null
    state.adoDown = null
    state.adoNeedsAuth = false
    state.featuresNote = null
    state.featuresSkipped = null
    state.searching = reconnect ? 'reconnect' : 'search'
    try {
      const { features, note } = await invoke(reconnect ? 'flow.reconnectAdo' : 'flow.features', { projectId, query })
      if (token !== listToken) return
      state.features = features
      state.featuresSkipped = note
      if (features.length === 0) {
        state.featuresNote = query.trim()
          ? 'No open Feature assigned to you matches that.'
          : 'No open Feature is assigned to you.'
      }
    } catch (error) {
      if (token !== listToken) return
      state.features = []
      if (isIpcError(error) && (error.code === 'MCP_NOT_CONNECTED' || error.code === 'MCP_NEEDS_AUTH')) {
        state.adoDown = error.message
        state.adoNeedsAuth = error.code === 'MCP_NEEDS_AUTH'
      }
      else state.error = errorMessage(error)
    } finally {
      if (token === listToken) state.searching = null
    }
  },

  async cancelFeatures(projectId: string): Promise<void> {
    listToken += 1
    state.searching = null
    state.listingByProject[projectId] = null
    state.featuresNote = 'You cancelled the list.'
    try {
      await invoke('flow.cancelFeatures', { projectId })
    } catch (error) {
      state.error = errorMessage(error)
    }
  },

  async loadExistingSpecs(projectId: string): Promise<void> {
    state.existingSpecs = await invoke('flow.existingSpecs', { projectId }).catch(() => [])
  },

  seedIntake(projectId: string, source: FlowStartSource): void {
    state.seed = { projectId, source }
  },

  takeSeed(projectId: string): FlowStartSource | null {
    const seed = state.seed
    if (seed?.projectId !== projectId) return null
    state.seed = null
    return seed.source
  },

  async detectStacks(projectId: string): Promise<void> {
    state.stacksByProject[projectId] = await invoke('flow.detectStacks', { projectId }).catch(() => [])
  },

  async start(
    projectId: string,
    source: FlowStartSource,
    autopilot: boolean,
    autoShip: boolean,
    baseBranch?: string,
    companions?: FlowCompanionRequest[],
    checklist?: boolean,
  ): Promise<string | null> {
    let runId: string | null = null
    await this.act('start', async () => {
      const snapshot = await invoke('flow.start', {
        projectId,
        source,
        autopilot,
        autoShip,
        checklist,
        baseBranch,
        companions,
      })
      runId = snapshot.runId
      state.runsByProject[projectId] = snapshot.runs
      state.stagesByProject[projectId] = snapshot.stages
      state.liveByProject[projectId] = snapshot.live
      await useProjectsStore().refresh()
    })
    return runId
  },

  async approve(runId: string): Promise<boolean> {
    return this.act('approve', async () =>
      this.applySnapshot(await invoke('flow.approve', { runId })),
    )
  },

  async retry(runId: string): Promise<boolean> {
    return this.act('retry', async () => this.applySnapshot(await invoke('flow.retry', { runId })))
  },

  async skip(runId: string): Promise<boolean> {
    return this.act('skip', async () => this.applySnapshot(await invoke('flow.skip', { runId })))
  },

  async fix(runId: string): Promise<boolean> {
    return this.act('fix', async () => this.applySnapshot(await invoke('flow.fix', { runId })))
  },

  async ship(runId: string): Promise<boolean> {
    return this.act('ship', async () => this.applySnapshot(await invoke('flow.ship', { runId })))
  },

  async featureFrom(projectId: string, runId: string): Promise<boolean> {
    return this.act('feature', async () => {
      const seed = await invoke('flow.feature', { runId })
      state.seed = { projectId, source: { kind: 'text', title: seed.title, description: seed.description } }
    })
  },

  async cancel(runId: string): Promise<boolean> {
    return this.act('cancel', async () =>
      this.applySnapshot(await invoke('flow.cancel', { runId })),
    )
  },

  async revise(runId: string, feedback: string): Promise<boolean> {
    return this.act('revise', async () =>
      this.applySnapshot(await invoke('flow.revise', { runId, feedback })),
    )
  },

  async setAutopilot(runId: string, autopilot: boolean): Promise<boolean> {
    return this.act('autopilot', async () =>
      this.applySnapshot(await invoke('flow.setAutopilot', { runId, autopilot })),
    )
  },

  async removeWorktree(runId: string, force: boolean): Promise<boolean> {
    return this.act('removeWorktree', async () =>
      this.applySnapshot(await invoke('flow.removeWorktree', { runId, force })),
    )
  },

  async openPullRequest(runId: string, projectId?: string): Promise<boolean> {
    return this.act('openPullRequest', async () => invoke('flow.openPullRequest', { runId, projectId }))
  },

  async artefact(
    runId: string,
    stage: FlowStage,
    kind?: FlowArtefactKind,
  ): Promise<{ path: string | null; content: string } | null> {
    return invoke('flow.artefact', { runId, stage, kind })
  },

  applySnapshot(snapshot: FlowSnapshot): void {
    const projectId = state.projectId
    if (!projectId) return
    state.runsByProject[projectId] = snapshot.runs
    state.stagesByProject[projectId] = snapshot.stages
    state.liveByProject[projectId] = snapshot.live
  },

  async act(name: string, work: () => Promise<void>): Promise<boolean> {
    state.error = null
    state.busy = name
    try {
      await work()
      return true
    } catch (error) {
      state.error = errorMessage(error)
      return false
    } finally {
      state.busy = null
    }
  },
})

export const useFlowStore = (): typeof store => store
