import { computed, reactive, toRefs } from 'vue'
import type { FlowFeature, FlowRun, FlowStackId, FlowStage, FlowStageRecord } from '@shared/domain'
import type { FlowArtefactKind, FlowStartSource } from '@shared/ipc-types'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

let requestToken = 0

const state = reactive({
  runsByProject: {} as Record<string, FlowRun[]>,
  stagesByProject: {} as Record<string, FlowStageRecord[]>,
  projectId: null as string | null,
  features: [] as FlowFeature[],
  featuresNote: null as string | null,
  searching: false,
  existingSpecs: [] as { id: string; title: string }[],
  detectedStacks: [] as FlowStackId[],
  busy: null as string | null,
  error: null as string | null,
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

const store = reactive({
  ...toRefs(state),
  runs,

  runsFor(projectId: string): FlowRun[] {
    return state.runsByProject[projectId] ?? []
  },

  stagesFor(runId: string): FlowStageRecord[] {
    return stagesByRun.value.get(runId) ?? []
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    state.projectId = projectId
    state.error = null
    try {
      const snapshot = await invoke('flow.list', { projectId })
      if (token !== requestToken) return
      state.runsByProject[projectId] = snapshot.runs
      state.stagesByProject[projectId] = snapshot.stages
    } catch (error) {
      if (token !== requestToken) return
      state.error = errorMessage(error)
      state.runsByProject[projectId] ??= []
    }
  },

  applyPush(projectId: string, runs: FlowRun[], stages: FlowStageRecord[]): void {
    state.runsByProject[projectId] = runs
    state.stagesByProject[projectId] = stages
  },

  async searchFeatures(projectId: string, query: string): Promise<void> {
    state.error = null
    state.featuresNote = null
    state.searching = true
    try {
      state.features = await invoke('flow.features', { projectId, query })
      if (state.features.length === 0) {
        state.featuresNote = 'No Feature matched that.'
      }
    } catch (error) {
      state.features = []
      state.error = errorMessage(error)
    } finally {
      state.searching = false
    }
  },

  async loadExistingSpecs(projectId: string): Promise<void> {
    state.existingSpecs = await invoke('flow.existingSpecs', { projectId }).catch(() => [])
  },

  async detectStacks(projectId: string): Promise<void> {
    state.detectedStacks = await invoke('flow.detectStacks', { projectId }).catch(() => [])
  },

  async start(
    projectId: string,
    source: FlowStartSource,
    autopilot: boolean,
    autoShip: boolean,
    baseBranch?: string,
  ): Promise<string | null> {
    let runId: string | null = null
    await this.act('start', async () => {
      const snapshot = await invoke('flow.start', {
        projectId,
        source,
        autopilot,
        autoShip,
        baseBranch,
      })
      runId = snapshot.runId
      state.runsByProject[projectId] = snapshot.runs
      state.stagesByProject[projectId] = snapshot.stages
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

  async openPullRequest(runId: string): Promise<boolean> {
    return this.act('openPullRequest', async () => invoke('flow.openPullRequest', { runId }))
  },

  async artefact(
    runId: string,
    stage: FlowStage,
    kind?: FlowArtefactKind,
  ): Promise<{ path: string | null; content: string } | null> {
    return invoke('flow.artefact', { runId, stage, kind })
  },

  applySnapshot(snapshot: { runs: FlowRun[]; stages: FlowStageRecord[] }): void {
    const projectId = state.projectId
    if (!projectId) return
    state.runsByProject[projectId] = snapshot.runs
    state.stagesByProject[projectId] = snapshot.stages
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
