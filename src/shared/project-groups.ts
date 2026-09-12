import type { ProjectGroup } from './domain'

export interface GroupSection<T> {
  group: ProjectGroup | null
  items: T[]
}

export function groupSections<T extends { id: string }>(
  items: readonly T[],
  groups: readonly ProjectGroup[],
  groupOf: Readonly<Record<string, string>>,
): GroupSection<T>[] {
  const sections = groups.map((group) => ({ group, items: [] as T[] }))
  const byId = new Map(sections.map((section) => [section.group.id, section]))
  const ungrouped: T[] = []
  for (const item of items) {
    const section = byId.get(groupOf[item.id] ?? '')
    if (section) section.items.push(item)
    else ungrouped.push(item)
  }
  return ungrouped.length > 0 ? [...sections, { group: null, items: ungrouped }] : sections
}
