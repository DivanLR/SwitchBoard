import { computed, reactive, toRefs } from 'vue'
import type { Elicitation, ElicitationAnswer, ElicitationValues } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'

const state = reactive({
  pending: [] as Elicitation[],
})

function groupBy(items: Elicitation[], key: (item: Elicitation) => string): Map<string, Elicitation[]> {
  const groups = new Map<string, Elicitation[]>()
  for (const item of items) {
    const list = groups.get(key(item))
    if (list) list.push(item)
    else groups.set(key(item), [item])
  }
  return groups
}

const bySession = computed(() => groupBy(state.pending, (item) => item.sessionId))

const flowByProject = computed(() =>
  groupBy(
    state.pending.filter((item) => item.flow),
    (item) => item.projectId,
  ),
)

const count = computed((): number => state.pending.length)

const store = reactive({
  ...toRefs(state),
  count,

  forSession(sessionId: string | null | undefined): Elicitation[] {
    return (sessionId && bySession.value.get(sessionId)) || []
  },

  flowFor(projectId: string): Elicitation[] {
    return flowByProject.value.get(projectId) ?? []
  },

  async refresh(): Promise<void> {
    state.pending = await invoke('elicitations.pending', undefined)
  },

  apply(pending: Elicitation[]): void {
    state.pending = pending
  },

  async respond(id: string, action: ElicitationAnswer, values?: ElicitationValues): Promise<string | null> {
    try {
      await invoke('elicitations.respond', { id, action, values })
      return null
    } catch (error) {
      return errorMessage(error)
    }
  },

  async openAgain(id: string): Promise<string | null> {
    try {
      await invoke('elicitations.openAgain', { id })
      return null
    } catch (error) {
      return errorMessage(error)
    }
  },
})

export const useElicitationsStore = (): typeof store => store
