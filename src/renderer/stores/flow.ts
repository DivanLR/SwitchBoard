import { computed, reactive, toRefs } from 'vue'
import type { FlowFeature, FlowItem, FlowLesson, FlowRun, ScopedItem } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

let requestToken = 0

const state = reactive({
  runsByProject: {} as Record<string, FlowRun[]>,
  itemsByProject: {} as Record<string, FlowItem[]>,
  projectId: null as string | null,
  features: [] as FlowFeature[],
  featuresNote: null as string | null,
  searching: false,
  busy: null as string | null,
  error: null as string | null,
  lessons: [] as FlowLesson[],
  lastWrite: null as string | null,
})

const runs = computed<FlowRun[]>(() =>
  state.projectId ? (state.runsByProject[state.projectId] ?? []) : [],
)

const run = computed<FlowRun | null>(() => runs.value[0] ?? null)

const items = computed<FlowItem[]>(() => {
  const current = run.value
  if (!current || !state.projectId) return []
  return (state.itemsByProject[state.projectId] ?? []).filter((item) => item.runId === current.id)
})

const WORKING: ReadonlySet<string> = new Set([
  'queued',
  'preparing',
  'implementing',
  'tech_review',
  'revising',
  'raising_pr',
  'pr_interrupted',
])

const pendingLessons = computed<FlowLesson[]>(() =>
  state.lessons.filter((lesson) => lesson.status === 'proposed'),
)

const counts = computed(() => {
  const all = items.value
  return {
    total: all.length,
    proposed: all.filter((item) => item.status === 'proposed').length,
    published: all.filter((item) => item.status === 'published').length,
    working: all.filter((item) => WORKING.has(item.status)).length,
    prOpen: all.filter((item) => item.status === 'pr_open').length,
    blocked: all.filter((item) => item.status === 'blocked').length,
    failed: all.filter((item) => item.status === 'failed').length,
  }
})

const store = reactive({
  ...toRefs(state),
  runs,
  run,
  items,
  counts,
  pendingLessons,

  // A record index, not a scan: a getter is enough and does not need caching.
  runsFor(projectId: string): FlowRun[] {
    return state.runsByProject[projectId] ?? []
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    state.projectId = projectId
    const snapshot = await invoke('flow.list', { projectId })
    if (token !== requestToken) return
    state.runsByProject[projectId] = snapshot.runs
    state.itemsByProject[projectId] = snapshot.items
  },

  applyPush(projectId: string, pushedRuns: FlowRun[], pushedItems: FlowItem[]): void {
    state.runsByProject[projectId] = pushedRuns
    state.itemsByProject[projectId] = pushedItems
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

  async start(projectId: string, feature: FlowFeature): Promise<boolean> {
    return this.act('start', async () => {
      const snapshot = await invoke('flow.start', {
        projectId,
        featureId: feature.id,
        featureTitle: feature.title,
      })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
      await useProjectsStore().refresh()
    })
  },

  async saveItems(projectId: string, runId: string, scoped: ScopedItem[]): Promise<boolean> {
    return this.act('save', async () => {
      const snapshot = await invoke('flow.saveItems', { projectId, runId, items: scoped })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
    })
  },

  async publish(projectId: string, runId: string): Promise<boolean> {
    return this.act('publish', async () => {
      const snapshot = await invoke('flow.publish', { projectId, runId })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
    })
  },

  async startWork(projectId: string, runId: string): Promise<boolean> {
    return this.act('work', async () => {
      const snapshot = await invoke('flow.startWork', { projectId, runId })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
      await useProjectsStore().refresh()
    })
  },

  async retryItem(projectId: string, itemId: string): Promise<boolean> {
    return this.act('retry', async () => {
      const snapshot = await invoke('flow.retryItem', { projectId, itemId })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
    })
  },

  async loadLessons(projectId: string): Promise<void> {
    state.lessons = await invoke('flow.lessons', { projectId })
  },

  async learn(projectId: string, runId: string): Promise<boolean> {
    return this.act('learn', async () => {
      const snapshot = await invoke('flow.learn', { projectId, runId })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
      await useProjectsStore().refresh()
    })
  },

  async decideLesson(
    projectId: string,
    lessonId: string,
    accept: boolean,
    reason?: string,
  ): Promise<boolean> {
    return this.act('lesson', async () => {
      const result = await invoke('flow.decideLesson', { projectId, lessonId, accept, reason })
      state.lessons = result.lessons
      state.lastWrite = accept
        ? result.appliedLines > 0
          ? `Wrote ${result.appliedLines} line${result.appliedLines === 1 ? '' : 's'} to ${result.path ?? 'CLAUDE.md'}.`
          : 'That rule was already there, so nothing was written.'
        : null
    })
  },

  async cancel(projectId: string, runId: string): Promise<boolean> {
    return this.act('cancel', async () => {
      const snapshot = await invoke('flow.cancel', { projectId, runId })
      state.runsByProject[projectId] = snapshot.runs
      state.itemsByProject[projectId] = snapshot.items
    })
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
