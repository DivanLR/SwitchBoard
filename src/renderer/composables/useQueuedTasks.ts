import { ref, toValue, type MaybeRefOrGetter } from 'vue'
import { useQueueStore } from '@renderer/stores/queue'

export function useQueuedTasks(projectIdInput: MaybeRefOrGetter<string>) {
  const queue = useQueueStore()
  const projectId = (): string => toValue(projectIdInput)

  const editingQueued = ref<string | null>(null)
  const queuedDraft = ref('')

  async function addQueued(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    await queue.add(projectId(), trimmed)
  }

  async function removeQueued(id: string): Promise<void> {
    await queue.remove(projectId(), id)
  }

  function beginEditQueued(task: { id: string; text: string }): void {
    editingQueued.value = task.id
    queuedDraft.value = task.text
  }

  async function saveQueued(): Promise<void> {
    const id = editingQueued.value
    if (!id) return
    editingQueued.value = null
    await queue.edit(projectId(), id, queuedDraft.value)
  }

  function cancelEditQueued(): void {
    editingQueued.value = null
    queuedDraft.value = ''
  }

  return {
    editingQueued,
    queuedDraft,
    addQueued,
    removeQueued,
    beginEditQueued,
    saveQueued,
    cancelEditQueued,
  }
}
