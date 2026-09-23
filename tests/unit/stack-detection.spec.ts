import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectStacks, stackEntries, TEST_STACKS } from '@shared/test-catalog'
import { detectProjectSuites } from '@main/verify/verify-dispatch'

describe('stack detection', () => {
  it('reports every stack present, so an API and its front end both get suites', () => {
    const found = detectStacks(['MyApi.sln', 'angular.json', 'README.md'])
    expect(found.map((s) => s.stackId)).toEqual(['dotnet', 'angular'])
  })

  it('matches an extension pattern anywhere in the root, case-insensitively', () => {
    expect(detectStacks(['Thing.SLNX']).map((s) => s.stackId)).toEqual(['dotnet'])
    expect(detectStacks(['notes.txt'])).toEqual([])
  })

  it('finds a solution one level down, where repos usually wrap it', () => {
    const tree: Record<string, string[]> = {
      '/ExternalAPI': ['CLAUDE.md', 'Ppl.Einstein.External.Api', 'device_recon.txt'],
      '/ExternalAPI/Ppl.Einstein.External.Api': ['Ppl.Einstein.External.Api.sln', 'src'],
    }
    const entries = stackEntries('/ExternalAPI', (dir) => tree[dir] ?? [])
    expect(entries).toContain('Ppl.Einstein.External.Api/Ppl.Einstein.External.Api.sln')
    expect(detectStacks(entries).map((s) => s.stackId)).toEqual(['dotnet'])
  })

  it('matches an exact marker on the basename, not the whole nested path', () => {
    expect(detectStacks(['app/global.json']).map((s) => s.stackId)).toEqual(['dotnet'])
    expect(detectStacks(['my-global.json'])).toEqual([])
  })

  it('does not descend into build or vendor directories', () => {
    const tree: Record<string, string[]> = {
      '/p': ['node_modules', 'obj', '.git', 'src'],
      '/p/node_modules': ['some.sln'],
      '/p/obj': ['other.sln'],
      '/p/.git': ['x.sln'],
      '/p/src': ['README.md'],
    }
    expect(detectStacks(stackEntries('/p', (dir) => tree[dir] ?? []))).toEqual([])
  })

  it('offers API, UI and unit coverage for every stack it knows', () => {
    for (const stack of TEST_STACKS) {
      const kinds = new Set(stack.suites.map((s) => s.kind))
      expect(kinds.has('unit'), `${stack.id} has unit`).toBe(true)
      expect(kinds.has('api') || kinds.has('ui'), `${stack.id} has api or ui`).toBe(true)
      for (const suite of stack.suites) {
        expect(suite.acceptance.length, `${suite.id} acceptance`).toBeGreaterThan(10)
        expect(suite.command.length, `${suite.id} command`).toBeGreaterThan(3)
      }
    }
  })
})

describe('what kind of .NET application a project holds', () => {
  const suiteIds = (entries: string[], files: Record<string, string>): string[] => {
    const stacks = detectStacks(entries, (entry) => files[entry] ?? null)
    return stacks.find((s) => s.stackId === 'dotnet')?.suites.map((s) => s.id) ?? []
  }
  const label = (entries: string[], files: Record<string, string>): string | undefined =>
    detectStacks(entries, (entry) => files[entry] ?? null).find((s) => s.stackId === 'dotnet')
      ?.stackLabel

  it('labels a Web API by its routed endpoints, and offers the endpoint suites', () => {
    const entries = ['Api.sln', 'Program.cs', 'Api.csproj']
    const files = { 'Program.cs': 'builder.Services.AddControllers();\napp.MapControllers();\n' }
    const ids = suiteIds(entries, files)
    expect(ids).toContain('dotnet-http')
    expect(ids).toContain('dotnet-api')
    expect(ids).toContain('dotnet-unit')
    expect(ids).toContain('dotnet-coverage')
    expect(label(entries, files)).toBe('.NET API')
  })

  it('takes a Controllers folder as an API, the asymmetry being deliberate', () => {
    const entries = ['Api.sln', 'Sample.Api.csproj', 'Controllers', 'Controllers/PoliciesController.cs']
    const files = { 'Sample.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' }
    expect(label(entries, files)).toBe('.NET API')
  })

  it('offers everything when the tree was never read at all', () => {
    const all = TEST_STACKS.find((s) => s.id === 'dotnet')?.suites.map((s) => s.id)
    expect(detectStacks(['Service.sln'])[0].suites.map((s) => s.id)).toEqual(all)
  })

  it('keeps the endpoint suites in the default label, even when a reader found no routes to confirm it', () => {
    const ids = suiteIds(['Service.sln', 'Directory.Build.props'], {})
    expect(ids).toContain('dotnet-unit')
    expect(ids).toContain('dotnet-http')
    expect(label(['Service.sln'], {})).toBe('.NET')
  })
})

describe('Angular suites that depend on project configuration', () => {
  const angularSuiteIds = (entries: string[], files: Record<string, string>): string[] => {
    const stacks = detectStacks(entries, (entry) => files[entry] ?? null)
    return stacks.find((s) => s.stackId === 'angular')?.suites.map((s) => s.id) ?? []
  }

  it('always offers the unit, coverage and build suites', () => {
    const ids = angularSuiteIds(['angular.json'], { 'angular.json': '{"projects":{}}' })
    expect(ids).toContain('ng-unit')
    expect(ids).toContain('ng-coverage')
    expect(ids).toContain('ng-build')
  })

  it('offers lint only once angular.json defines a lint target', () => {
    const without = angularSuiteIds(['angular.json'], {
      'angular.json': '{"projects":{"app":{"architect":{"build":{}}}}}',
    })
    expect(without).not.toContain('ng-lint')

    const withLint = angularSuiteIds(['angular.json'], {
      'angular.json': '{"projects":{"app":{"architect":{"build":{},"lint":{}}}}}',
    })
    expect(withLint).toContain('ng-lint')
  })

  it('offers e2e only once Playwright or Cypress is a dependency', () => {
    const without = angularSuiteIds(['angular.json', 'package.json'], {
      'angular.json': '{}',
      'package.json': '{"devDependencies":{"karma":"^6.4.0"}}',
    })
    expect(without).not.toContain('ng-e2e')

    const withPlaywright = angularSuiteIds(['angular.json', 'package.json'], {
      'angular.json': '{}',
      'package.json': '{"devDependencies":{"@playwright/test":"^1.63.0"}}',
    })
    expect(withPlaywright).toContain('ng-e2e')

    const withCypress = angularSuiteIds(['angular.json', 'package.json'], {
      'angular.json': '{}',
      'package.json': '{"devDependencies":{"cypress":"^13.0.0"}}',
    })
    expect(withCypress).toContain('ng-e2e')
  })

  it('offers everything when the tree was never read at all', () => {
    const all = TEST_STACKS.find((s) => s.id === 'angular')?.suites.map((s) => s.id)
    expect(detectStacks(['angular.json'])[0].suites.map((s) => s.id)).toEqual(all)
  })

  it('reads angular.json from disk in the real scan, so a lint target offers the lint suite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ng-scan-'))
    try {
      await writeFile(join(root, 'angular.json'), '{"projects":{"app":{"architect":{"build":{},"lint":{}}}}}')
      await writeFile(join(root, 'package.json'), '{"devDependencies":{"karma":"^6.4.0"}}')
      const angular = (await detectProjectSuites(root)).find((s) => s.stackId === 'angular')
      expect(angular?.suites.map((s) => s.id)).toContain('ng-lint')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
