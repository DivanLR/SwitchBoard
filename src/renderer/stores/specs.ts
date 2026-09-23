import { computed, reactive, toRefs } from 'vue'
import type { SddProcess, SpecDetail, SpecKitState } from '@shared/domain'
import { SDD_REPORTS } from '@shared/sdd'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSectionsStore } from '@renderer/stores/sections'

interface SddRun {
  projectId: string
  key: string
  label: string
  sessionId: string
}

type Installable = 'speckit' | SddProcess

interface SddReport {
  process: SddProcess
  slug: string
  file: string
  path: string | null
  content: string | null
}

const EMPTY: SpecKitState = {
  installed: false,
  specs: [],
  constitution: 'missing',
  bugs: [],
  ideas: [],
  extensions: { bug: false, assess: false },
}

let token = 0

const state = reactive({
  projectId: null as string | null,
  byProject: {} as Record<string, SpecKitState>,
  detail: null as SpecDetail | null,
  selectedSpecId: null as string | null,
  selectedSlugs: { bug: null, assess: null } as Record<SddProcess, string | null>,
  report: null as SddReport | null,
  runs: [] as SddRun[],
  installing: null as Installable | null,
  installError: null as { what: Installable; message: string } | null,
  error: null as string | null,
})

const liveRuns = computed(() => {
  const sessions = new Map(useProjectsStore().items.flatMap((item) => item.sessions).map((s) => [s.id, s]))
  return state.runs.filter((run) => {
    const session = sessions.get(run.sessionId)
    return session !== undefined && !session.endedAt
  })
})

function entriesOf(value: SpecKitState, process: SddProcess): SpecKitState['bugs'] {
  return process === 'bug' ? value.bugs : value.ideas
}

const store = reactive({
  ...toRefs(state),
  liveRuns,

  stateFor(projectId: string): SpecKitState {
    return state.byProject[projectId] ?? EMPTY
  },

  isRunning(projectId: string, key: string): boolean {
    return liveRuns.value.some((run) => run.projectId === projectId && run.key === key)
  },

  async load(projectId: string): Promise<void> {
    const mine = ++token
    if (state.projectId !== projectId) {
      state.projectId = projectId
      state.detail = null
      state.selectedSpecId = null
      state.selectedSlugs = { bug: null, assess: null }
      state.report = null
      state.installError = null
    }
    state.error = null
    let fresh: SpecKitState
    try {
      fresh = await invoke('specs.state', { projectId })
    } catch (error) {
      if (mine === token) state.error = errorMessage(error)
      return
    }
    if (mine !== token) return
    state.byProject[projectId] = fresh
    for (const process of ['bug', 'assess'] as const) {
      const entries = entriesOf(fresh, process)
      if (!entries.some((entry) => entry.slug === state.selectedSlugs[process])) {
        state.selectedSlugs[process] = entries[0]?.slug ?? null
      }
    }
    const kept = fresh.specs.some((spec) => spec.id === state.selectedSpecId)
    const specId = kept ? state.selectedSpecId : ([...fresh.specs].sort((a, b) => b.id.localeCompare(a.id))[0]?.id ?? null)
    if (specId) await this.selectSpec(projectId, specId)
    else state.detail = null
    if (state.report) await this.openReport(projectId, state.report.process, state.report.slug, state.report.file)
  },

  async selectSpec(projectId: string, specId: string): Promise<void> {
    const mine = ++token
    state.selectedSpecId = specId
    const detail = await invoke('specs.detail', { projectId, specId }).catch(() => null)
    if (mine === token) state.detail = detail
  },

  async selectEntry(projectId: string, process: SddProcess, slug: string): Promise<void> {
    state.selectedSlugs[process] = slug
    const entry = entriesOf(this.stateFor(projectId), process).find((item) => item.slug === slug)
    const file = SDD_REPORTS[process].map((report) => report.file).filter((name) => entry?.files.includes(name)).pop()
    if (file) await this.openReport(projectId, process, slug, file)
    else state.report = null
  },

  async openReport(projectId: string, process: SddProcess, slug: string, file: string): Promise<void> {
    const found = await invoke('specs.report', { projectId, process, slug, file }).catch(() => null)
    state.report = { process, slug, file, path: found?.path ?? null, content: found?.content ?? null }
  },

  async run(projectId: string, text: string, key: string, label: string, specId?: string): Promise<void> {
    if (specId) await invoke('specs.pin', { projectId, specId })
    const sessionId = await useSectionsStore().runInSession(projectId, text, true, false, 'spec')
    state.runs = [
      ...state.runs.filter((run) => run.projectId !== projectId || run.key !== key),
      { projectId, key, label, sessionId },
    ]
  },

  async settle(projectId: string): Promise<void> {
    const live = new Set(liveRuns.value.map((run) => run.sessionId))
    state.runs = state.runs.filter((run) => live.has(run.sessionId))
    await this.load(projectId)
  },

  async install(projectId: string): Promise<void> {
    await this.runInstall(projectId, 'speckit', () => invoke('specs.install', { projectId }))
  },

  async installExtension(projectId: string, name: SddProcess): Promise<void> {
    await this.runInstall(projectId, name, () => invoke('specs.installExtension', { projectId, name }))
  },

  async runInstall(projectId: string, what: Installable, work: () => Promise<SpecKitState>): Promise<void> {
    state.installing = what
    state.installError = null
    try {
      state.byProject[projectId] = await work()
    } catch (error) {
      state.installError = { what, message: errorMessage(error) }
    } finally {
      state.installing = null
    }
  },
})

export const useSpecsStore = (): typeof store => store
