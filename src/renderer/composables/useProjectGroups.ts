import { computed, ref, type Ref } from 'vue'
import type { ProjectGroup } from '@shared/domain'
import { GROUP_COLORS } from '@renderer/project-accent'
import { useSettingsStore } from '@renderer/stores/settings'

export function useProjectGroups(opts: {
  renamingGroupId: Ref<string | null>
  renameVal: Ref<string>
}) {
  const settings = useSettingsStore()

  const groups = computed<ProjectGroup[]>(() => settings.settings?.projectGroups ?? [])
  const groupOf = computed<Record<string, string>>(() => settings.settings?.projectGroupOf ?? {})

  const ungroupedFolded = ref(false)

  function saveGroups(next: ProjectGroup[]): void {
    void settings.save({ projectGroups: next })
  }

  function assignGroup(projectId: string, groupId: string | null): void {
    const map = { ...groupOf.value }
    if (groupId) map[projectId] = groupId
    else delete map[projectId]
    void settings.save({ projectGroupOf: map })
  }

  function toggleGroup(id: string | null): void {
    if (!id) {
      ungroupedFolded.value = !ungroupedFolded.value
      return
    }
    saveGroups(groups.value.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)))
  }

  function defaultGroupName(): string {
    const taken = new Set(groups.value.map((g) => g.name))
    let name = 'New group'
    for (let n = 2; taken.has(name); n += 1) name = `New group ${n}`
    return name
  }

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
