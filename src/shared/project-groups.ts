// Splitting the sidebar's project list into collapsible groups.
import type { ProjectGroup } from './domain'

export interface GroupSection<T> {
  /** null for the tail of projects that belong to no group. */
  group: ProjectGroup | null
  items: T[]
}

/**
 * Groups the sidebar list: one section per group in group order, then the
 * ungrouped tail. Order WITHIN a section follows `items`, so the existing
 * drag-to-reorder keeps working untouched.
 *
 * Empty groups are kept (they are still a drop target), and a mapping to a group
 * that no longer exists reads as ungrouped, so removing a group can never hide a
 * project. The ungrouped section is omitted when everything is grouped.
 */
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
