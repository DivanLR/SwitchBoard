import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectFlowStacks } from '@main/flow/stacks'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-stacks-'))
  dirs.push(dir)
  return dir
}

describe('detecting the project stacks', () => {
  it('finds a .NET solution at the root', async () => {
    const dir = project()
    writeFileSync(join(dir, 'App.sln'), '')
    expect(await detectFlowStacks(dir)).toEqual(['dotnet'])
  })

  it('finds a .slnx or a bare .csproj too', async () => {
    const slnx = project()
    writeFileSync(join(slnx, 'App.slnx'), '')
    expect(await detectFlowStacks(slnx)).toEqual(['dotnet'])

    const csproj = project()
    mkdirSync(join(csproj, 'src'))
    writeFileSync(join(csproj, 'src', 'App.csproj'), '')
    expect(await detectFlowStacks(csproj)).toEqual(['dotnet'])
  })

  it('finds angular.json a few levels down', async () => {
    const dir = project()
    mkdirSync(join(dir, 'web', 'src'), { recursive: true })
    writeFileSync(join(dir, 'web', 'angular.json'), '{}')
    expect(await detectFlowStacks(dir)).toEqual(['angular'])
  })

  it('finds both in one mixed repo', async () => {
    const dir = project()
    writeFileSync(join(dir, 'Api.sln'), '')
    mkdirSync(join(dir, 'web'))
    writeFileSync(join(dir, 'web', 'angular.json'), '{}')
    expect(await detectFlowStacks(dir)).toEqual(['dotnet', 'angular'])
  })

  it('never looks inside node_modules, bin, obj, .git or .worktrees', async () => {
    const dir = project()
    for (const skip of ['node_modules', 'bin', 'obj', '.git', '.worktrees']) {
      mkdirSync(join(dir, skip), { recursive: true })
      writeFileSync(join(dir, skip, 'Ghost.sln'), '')
    }
    expect(await detectFlowStacks(dir)).toEqual([])
  })

  it('does not look past three levels deep', async () => {
    const dir = project()
    mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'TooDeep.sln'), '')
    expect(await detectFlowStacks(dir)).toEqual([])
  })

  it('refuses neither stack for an unrelated project', async () => {
    const dir = project()
    writeFileSync(join(dir, 'main.py'), '')
    expect(await detectFlowStacks(dir)).toEqual([])
  })
})
