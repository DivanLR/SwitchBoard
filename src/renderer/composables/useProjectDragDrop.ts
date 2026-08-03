// Sidebar drag and drop: reorder lanes, move a project between groups, and take
// OS files dropped on a row. Extracted from Sidebar so the component is left
// rendering lanes rather than also owning the pointer state machine.
//
// Dragging a row REORDERS, and only reorders. Referencing one project from
// another is done by dragging it into the session pane instead, because a drop
// onto a row would otherwise have to mean two different things depending on
// where in the row it landed — and the developer cannot see that boundary.
import { ref, type Ref } from 'vue'
import type { ProjectGroup } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'

/** The ungrouped tail is a drop target too (it takes a project back out of its
 *  group), so it needs a key of its own — it has no id. */
export const UNGROUPED = '__ungrouped'

export function useProjectDragDrop(opts: {
  groupOf: Ref<Record<string, string>>
  assignGroup: (projectId: string, groupId: string | null) => void
}) {
  const projects = useProjectsStore()
  const activeSession = useActiveSessionStore()

  const dragId = ref<string | null>(null)
  const rowDrop = ref<{ id: string; zone: 'before' | 'after' | 'file' } | null>(null)
  /** Group header highlighted as the drop target for the dragged project. */
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

  // Project drags reorder: top half inserts before, bottom half after — no
  // drop-onto-reference zone. OS-file drags highlight the whole row.
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
    // An OS file dropped on a project: open it and point the composer at the path.
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
    // Dropping among a group's rows also joins that group, so dragging into the
    // middle of a group does the obvious thing instead of only reordering.
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
