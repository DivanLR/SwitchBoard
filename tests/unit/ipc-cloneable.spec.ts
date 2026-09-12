import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { toCloneable } from '@shared/cloneable'
import { errorMessage } from '@shared/ipc-types'

describe('IPC request serialisation', () => {
  it('proves the unguarded shape really does fail, so the guard is not superstition', () => {
    const selected = ref<string[]>(['dotnet-unit', 'dotnet-coverage'])
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

  it('reads the reason off a rejected invoke instead of printing [object Object]', () => {
    const ipcError = { code: 'NOT_FOUND', message: 'Claude Code was not found. Install it first.' }
    expect(errorMessage(ipcError)).toBe('Claude Code was not found. Install it first.')
    expect(errorMessage(ipcError)).not.toContain('[object Object]')

    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('a thrown string')).toBe('a thrown string')
    expect(errorMessage(undefined, 'Could not start the run.')).toBe('Could not start the run.')
    expect(errorMessage({}, 'Could not start the run.')).toBe('Could not start the run.')
    expect(errorMessage({ message: '   ' }, 'Could not start the run.')).toBe('Could not start the run.')
  })

  it('survives a cycle instead of recursing forever', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = toCloneable(a) as Record<string, unknown>
    expect(out.name).toBe('a')
    expect(out.self).toBe(out)
  })
})
