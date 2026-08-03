// Sidebar project groups: create, rename, recolour, fold, reorder, and assign
// projects to them. Extracted from Sidebar so the component is left rendering
// lanes rather than also owning a small CRUD surface.
//
// Groups live in Settings beside the other per-project maps rather than in their
// own table, so organising the sidebar needs no schema change. That is also why
// every write goes through `settings.save`, which applies the patch locally
// before it persists — two edits dispatched in one tick (naming a group, then
// clicking "new group", which blurs the name field) both have to survive.
import { computed, ref, type Ref } from 'vue'
import type { ProjectGroup } from '@shared/domain'
import { GROUP_COLORS } from '@renderer/project-accent'
import { useSettingsStore } from '@renderer/stores/settings'

export function useProjectGroups(opts: {
  /** Inline rename target, owned by the view (it also renames projects). */
  renamingGroupId: Ref<string | null>
  renameVal: Ref<string>
}) {
  const settings = useSettingsStore()

  const groups = computed<ProjectGroup[]>(() => settings.settings?.projectGroups ?? [])
  const groupOf = computed<Record<string, string>>(() => settings.settings?.projectGroupOf ?? {})

  /** Whether the ungrouped tail is folded. Not persisted like a real group's
   *  fold: it is a view preference on a section the developer never created. */
  const ungroupedFolded = ref(false)

  function saveGroups(next: ProjectGroup[]): void {
    void settings.save({ projectGroups: next })
  }

  /** Move a project into a group, or out of all groups with null. */
  function assignGroup(projectId: string, groupId: string | null): void {
    const map = { ...groupOf.value }
    if (groupId) map[projectId] = groupId
    else delete map[projectId]
    void settings.save({ projectGroupOf: map })
  }

  /** Folds a group, or the ungrouped tail when there is no id. */
  function toggleGroup(id: string | null): void {
    if (!id) {
      ungroupedFolded.value = !ungroupedFolded.value
      return
    }
    saveGroups(groups.value.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)))
  }

  /** A default name no existing group already has, so a second group reads as a
   *  second group rather than a duplicate of the first. */
  function defaultGroupName(): string {
    const taken = new Set(groups.value.map((g) => g.name))
    let name = 'New group'
    for (let n = 2; taken.has(name); n += 1) name = `New group ${n}`
    return name
  }

  /** Adds a group and drops straight into inline naming. */
  function newGroup(projectId?: string): void {
    const group: ProjectGroup = {
      id: crypto.randomUUID(),
      name: defaultGroupName(),
      collapsed: false,
      color: GROUP_COLORS[groups.value.length % GROUP_COLORS.length],
    }
    saveGroups([...groups.value, group])
    if (projectId) assignGroup(projectId, group.id)
    opts.renamingGroupId.value = group.id
    opts.renameVal.value = group.name
  }

  /** Removing a group never removes projects: they fall back to ungrouped. */
  function removeGroup(id: string): void {
    const map = { ...groupOf.value }
    for (const [projectId, groupId] of Object.entries(map)) {
      if (groupId === id) delete map[projectId]
    }
    void settings.save({
      projectGroups: groups.value.filter((g) => g.id !== id),
      projectGroupOf: map,
    })
  }

  function moveGroup(id: string, delta: number): void {
    const from = groups.value.findIndex((g) => g.id === id)
    const to = from + delta
    if (from === -1 || to < 0 || to >= groups.value.length) return
    const next = [...groups.value]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    saveGroups(next)
  }

  return {
    groups,
    groupOf,
    ungroupedFolded,
    saveGroups,
    assignGroup,
    toggleGroup,
    newGroup,
    removeGroup,
    moveGroup,
  }
}
