import { ref, type Ref } from 'vue'
import type { ProjectGroup } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'

export const UNGROUPED = '__ungrouped'

export function useProjectDragDrop(opts: {
  groupOf: Ref<Record<string, string>>
  assignGroup: (projectId: string, groupId: string | null) => void
}) {
  const projects = useProjectsStore()
  const activeSession = useActiveSessionStore()

  const dragId = ref<string | null>(null)
  const rowDrop = ref<{ id: string; zone: 'before' | 'after' | 'file' } | null>(null)
  const groupDrop = ref<string | null>(null)

  function onGroupDragOver(group: ProjectGroup | null, event: DragEvent): void {
    if (!(event.dataTransfer?.types ?? []).includes('text/x-sb-project')) return
    event.preventDefault()
    groupDrop.value = group?.id ?? UNGROUPED
  }

  function onGroupDrop(group: ProjectGroup | null, event: DragEvent): void {
    event.preventDefault()
    groupDrop.value = null
    const dragged = event.dataTransfer?.getData('text/x-sb-project') || dragId.value
    dragId.value = null
    if (dragged) opts.assignGroup(dragged, group?.id ?? null)
  }

  function onDragStart(item: ProjectListItem, event: DragEvent): void {
    dragId.value = item.id
    event.dataTransfer?.setData('text/x-sb-project', item.id)
    event.dataTransfer?.setData('text/x-sb-project-path', item.path)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function onRowDragOver(item: ProjectListItem, event: DragEvent): void {
    const types = event.dataTransfer?.types ?? []
    if (types.includes('Files')) {
      event.preventDefault()
      rowDrop.value = { id: item.id, zone: 'file' }
      return
    }
    if (!types.includes('text/x-sb-project')) return
    if (dragId.value === item.id) return
    event.preventDefault()
    const el = event.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const y = (event.clientY - rect.top) / Math.max(1, rect.height)
    rowDrop.value = { id: item.id, zone: y < 0.5 ? 'before' : 'after' }
  }

  async function onRowDrop(item: ProjectListItem, event: DragEvent): Promise<void> {
    event.preventDefault()
    const drop = rowDrop.value
    rowDrop.value = null
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length > 0) {
      const paths = files
        .map((f) => window.switchboard.pathForFile?.(f))
        .filter((p): p is string => Boolean(p))
        .map((p) => `@${p}`)
      if (paths.length > 0) {
        projects.select(item.id)
        activeSession.requestComposerInsert(paths.join(' '))
      }
      dragId.value = null
      return
    }
    const dragged = event.dataTransfer?.getData('text/x-sb-project') || dragId.value
    dragId.value = null
    if (!drop || !dragged || dragged === item.id) return
    const fromIndex = projects.items.findIndex((p) => p.id === dragged)
    if (fromIndex === -1) return
    const targetIndex = projects.items.findIndex((p) => p.id === item.id)
    let toIndex = drop.zone === 'before' ? targetIndex : targetIndex + 1
    if (fromIndex < toIndex) toIndex -= 1
    const targetGroup = opts.groupOf.value[item.id] ?? null
    if ((opts.groupOf.value[dragged] ?? null) !== targetGroup) opts.assignGroup(dragged, targetGroup)
    await projects.move(dragged, toIndex)
  }

  function onDragEnd(): void {
    dragId.value = null
    rowDrop.value = null
    groupDrop.value = null
  }

  return {
    dragId,
    rowDrop,
    groupDrop,
    onGroupDragOver,
    onGroupDrop,
    onDragStart,
    onRowDragOver,
    onRowDrop,
    onDragEnd,
  }
}
