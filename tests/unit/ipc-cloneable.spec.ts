// The IPC boundary must accept a request built from Vue reactive state.
//
// Electron serialises invoke arguments with structuredClone, which rejects a
// Proxy. Vue wraps every array and object reached through ref()/reactive() in
// one, so a store passing its own state straight to invoke fails with "An object
// could not be cloned" — naming neither the field nor the call. That is exactly
// what broke the Tests section's Run verification button, which handed over the
// reactive array of selected suite ids.
//
// These tests assert the two halves of the fix: that the raw shape genuinely
// fails (so the guard is not cargo cult), and that the guard makes every shape
// the IPC contract actually carries survive a real structuredClone.
import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { toCloneable } from '@shared/cloneable'

describe('IPC request serialisation', () => {
  it('proves the unguarded shape really does fail, so the guard is not superstition', () => {
    const selected = ref<string[]>(['dotnet-unit', 'dotnet-coverage'])
    // This is the literal bug: the reactive array handed straight to invoke.
    expect(() => structuredClone(selected.value)).toThrow(/could not be cloned/)
    expect(() => structuredClone(reactive({ suiteIds: ['a'] }))).toThrow(/could not be cloned/)
  })

  it('carries the verify.start request through, reactive array and all', () => {
    const selected = ref<string[]>(['dotnet-unit', 'dotnet-api', 'dotnet-arch'])
    const req = { projectId: 'p-1', stackId: 'dotnet', suiteIds: selected.value }
    const clone = structuredClone(toCloneable(req))
    expect(clone).toEqual({
      projectId: 'p-1',
      stackId: 'dotnet',
      suiteIds: ['dotnet-unit', 'dotnet-api', 'dotnet-arch'],
    })
  })

  it('handles nested reactive structures, which settings requests are full of', () => {
    const settings = reactive({
      projectTestStacks: { 'p-1': 'dotnet' },
      databaseMcpServers: ['oracle-sqlcl'],
      nested: { deep: [{ id: 1 }] },
    })
    expect(() => structuredClone(toCloneable(settings))).not.toThrow()
    expect(structuredClone(toCloneable(settings))).toEqual({
      projectTestStacks: { 'p-1': 'dotnet' },
      databaseMcpServers: ['oracle-sqlcl'],
      nested: { deep: [{ id: 1 }] },
    })
  })

  it('leaves primitives, undefined and null exactly as they were', () => {
    // Most invoke calls pass undefined; that must not become {}.
    expect(toCloneable(undefined)).toBeUndefined()
    expect(toCloneable(null)).toBeNull()
    expect(toCloneable('x')).toBe('x')
    expect(toCloneable(7)).toBe(7)
    expect(toCloneable(false)).toBe(false)
  })

  it('preserves a Date rather than flattening it to an object', () => {
    const when = new Date('2026-07-28T00:00:00.000Z')
    const out = toCloneable({ when })
    expect(out.when).toBeInstanceOf(Date)
    expect(structuredClone(out).when.toISOString()).toBe('2026-07-28T00:00:00.000Z')
  })

  it('survives a cycle instead of recursing forever', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = toCloneable(a) as Record<string, unknown>
    expect(out.name).toBe('a')
    expect(out.self).toBe(out)
  })
})
