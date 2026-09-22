import { describe, expect, it } from 'vitest'
import { detectStacks, stackEntries, TEST_STACKS } from '@shared/test-catalog'

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

  it('offers a Web API the endpoint suites and none of the browser ones', () => {
    const entries = ['Api.sln', 'Program.cs', 'Api.csproj']
    const files = { 'Program.cs': 'builder.Services.AddControllers();\napp.MapControllers();\n' }
    const ids = suiteIds(entries, files)
    expect(ids).toContain('dotnet-http')
    expect(ids).toContain('dotnet-api')
    expect(ids).not.toContain('blazor-ui')
    expect(ids).not.toContain('blazor-interactive')
    expect(label(entries, files)).toBe('.NET API')
  })

  it('offers a Blazor app the browser suites and never an HTTP smoke of endpoints', () => {
    const entries = ['App.sln', 'Program.cs', 'App.csproj']
    const files = {
      'Program.cs':
        'builder.Services.AddRazorComponents().AddInteractiveServerComponents();\n' +
        'app.MapRazorComponents<App>().AddInteractiveServerRenderMode();\n',
    }
    const ids = suiteIds(entries, files)
    expect(ids).toContain('blazor-ui')
    expect(ids).toContain('blazor-interactive')
    expect(ids).not.toContain('dotnet-http')
    expect(ids).not.toContain('dotnet-api')
    expect(ids).toContain('dotnet-unit')
    expect(ids).toContain('dotnet-coverage')
    expect(label(entries, files)).toBe('.NET Blazor')
  })

  it('recognises a standalone WebAssembly app from its root page and root component', () => {
    const entries = ['Client.sln', 'wwwroot/index.html', 'Program.cs']
    const files = { 'Program.cs': 'builder.RootComponents.Add<App>("#app");\n' }
    expect(suiteIds(entries, files)).toContain('blazor-ui')
    expect(label(entries, files)).toBe('.NET Blazor')
  })

  it('gives a solution holding both an API and a front end all of it', () => {
    const entries = ['Both.sln', 'Api/Program.cs', 'Web/Program.cs']
    const files = {
      'Api/Program.cs': 'app.MapControllers();\napp.MapOpenApi();\n',
      'Web/Program.cs': 'app.MapRazorComponents<App>();\n',
    }
    const ids = suiteIds(entries, files)
    expect(ids).toContain('dotnet-http')
    expect(ids).toContain('blazor-ui')
    expect(label(entries, files)).toBe('.NET API + Blazor')
  })

  it('offers everything only when there is no reader at all', () => {
    const all = TEST_STACKS.find((s) => s.id === 'dotnet')?.suites.map((s) => s.id)
    expect(detectStacks(['Api.sln'])[0].suites.map((s) => s.id)).toEqual(all)
  })

  it('withholds the browser suites once a reader has looked and found no screens', () => {
    const ids = suiteIds(['Api.sln', 'Program.cs'], {})
    expect(ids).not.toContain('blazor-ui')
    expect(ids).not.toContain('blazor-interactive')
    expect(ids).toContain('dotnet-unit')
    expect(ids).toContain('dotnet-http')
    expect(label(['Api.sln'], {})).toBe('.NET')
  })

  it('does not read a class named like a controller as evidence of a routed API', () => {
    const ids = suiteIds(['App.sln', 'Program.cs'], {
      'Program.cs': 'app.MapRazorComponents<App>();\n// class PolicyController lives elsewhere\n',
    })
    expect(ids).not.toContain('dotnet-http')
    expect(ids).toContain('blazor-ui')
  })

  it('takes a Controllers folder as an API, the asymmetry being deliberate', () => {
    const entries = ['Api.sln', 'Sample.Api.csproj', 'Controllers', 'Controllers/PoliciesController.cs']
    const files = { 'Sample.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' }
    expect(label(entries, files)).toBe('.NET API')
    expect(suiteIds(entries, files)).not.toContain('blazor-ui')
  })

  it('withholds the browser suites from a .NET project with no screens at all', () => {
    const entries = ['Service.sln', 'Directory.Build.props', 'src', 'tests']
    const files = { 'Directory.Build.props': '<Project></Project>' }
    const ids = suiteIds(entries, files)
    expect(ids).not.toContain('blazor-ui')
    expect(ids).not.toContain('blazor-interactive')
    expect(ids).toContain('dotnet-unit')
    expect(ids).toContain('dotnet-http')
  })

  it('still offers everything when the tree was never read', () => {
    const ids = detectStacks(['Service.sln']).flatMap((s) => s.suites.map((x) => x.id))
    expect(ids).toContain('blazor-ui')
  })
})

describe('a coverage suite the project cannot run', () => {
  const nodeSuites = (manifest: string): string[] => {
    const stacks = detectStacks(['package.json'], () => manifest)
    return stacks.find((s) => s.stackId === 'node')?.suites.map((s) => s.id) ?? []
  }

  it('is not offered when no coverage provider is installed', () => {
    const ids = nodeSuites('{"devDependencies":{"vitest":"^4.1.0"}}')
    expect(ids).not.toContain('node-coverage')
    expect(ids).toContain('node-unit')
    expect(ids).toContain('node-types')
  })

  it('is offered as soon as a provider is there', () => {
    expect(nodeSuites('{"devDependencies":{"@vitest/coverage-v8":"^4.1.0"}}')).toContain(
      'node-coverage',
    )
    expect(nodeSuites('{"devDependencies":{"jest":"^30.0.0"}}')).toContain('node-coverage')
  })

  it('offers everything when the files cannot be read at all', () => {
    const stacks = detectStacks(['package.json'])
    expect(stacks.find((s) => s.stackId === 'node')?.suites.map((s) => s.id)).toContain(
      'node-coverage',
    )
  })
})
