// Sidebar grouping: the partition must never lose or reorder a project.
import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '@shared/domain'
import { groupSections } from '@shared/project-groups'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const work: ProjectGroup = { id: 'g1', name: 'Work', collapsed: false }
const clients: ProjectGroup = { id: 'g2', name: 'Clients', collapsed: true }

describe('groupSections', () => {
  it('returns one section per group in group order, then the ungrouped tail', () => {
    const sections = groupSections(items, [work, clients], { a: 'g1', c: 'g2' })
    expect(sections.map((s) => [s.group?.name ?? null, s.items.map((i) => i.id)])).toEqual([
      ['Work', ['a']],
      ['Clients', ['c']],
      [null, ['b', 'd']],
    ])
  })

  it('keeps the incoming order inside a section, so reordering still works', () => {
    const sections = groupSections(items, [work], { d: 'g1', b: 'g1', a: 'g1' })
    expect(sections[0].items.map((i) => i.id)).toEqual(['a', 'b', 'd'])
  })

  it('omits the ungrouped section only when every project is grouped', () => {
    const all = groupSections(items, [work], { a: 'g1', b: 'g1', c: 'g1', d: 'g1' })
    expect(all).toHaveLength(1)
    expect(groupSections(items, [work], { a: 'g1' })).toHaveLength(2)
  })

  it('keeps an empty group, since it is still a drop target', () => {
    const sections = groupSections(items, [work, clients], { a: 'g1' })
    expect(sections[1].group?.name).toBe('Clients')
    expect(sections[1].items).toEqual([])
  })

  it('treats a mapping to a removed group as ungrouped rather than hiding it', () => {
    const sections = groupSections(items, [work], { a: 'g1', b: 'gone' })
    expect(sections.map((s) => s.items.map((i) => i.id))).toEqual([['a'], ['b', 'c', 'd']])
  })

  it('with no groups returns every project in one ungrouped section', () => {
    const sections = groupSections(items, [], {})
    expect(sections).toEqual([{ group: null, items }])
  })

  it('never drops or duplicates a project', () => {
    const sections = groupSections(items, [work, clients], { a: 'g1', b: 'g2', c: 'gone' })
    const seen = sections.flatMap((s) => s.items.map((i) => i.id))
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})
