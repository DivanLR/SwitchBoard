// The Coordinator-Implementor-Verifier parts of the eval loop: which suites a
// project can run, the marker that carries a check's real outcome back out of the
// session, the gate that stops a false pass, and the derived stage.
import { describe, expect, it } from 'vitest'
import { canPassEval, evalStage, type EvalRun } from '@shared/domain'
import { detectStacks, stackEntries, TEST_STACKS } from '@shared/test-catalog'
import {
  attemptsPrompt,
  checkPrompt,
  judgePrompt,
  parseEvalMarker,
} from '@main/evals/eval-dispatch'

const line = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: 'e1',
  projectId: 'p1',
  acceptance: 'the button shows a bar',
  checkCmd: 'npm test',
  checkStatus: 'not_run',
  verdict: 'pending',
  rating: null,
  note: null,
  attempts: 1,
  judge: null,
  createdAt: '2026-07-26T00:00:00.000Z',
  ...over,
})

describe('stack detection', () => {
  it('reports every stack present, so an API and its front end both get suites', () => {
    const found = detectStacks(['MyApi.sln', 'angular.json', 'README.md'])
    expect(found.map((s) => s.stackId)).toEqual(['dotnet', 'angular'])
  })

  it('matches an extension pattern anywhere in the root, case-insensitively', () => {
    expect(detectStacks(['Thing.SLNX']).map((s) => s.stackId)).toEqual(['dotnet'])
    expect(detectStacks(['notes.txt'])).toEqual([])
  })

  // Both shapes below are real registered projects that a root-only scan reported
  // as having no stack, which emptied their Tests section and sent their bypass
  // session to the node-only sandbox image.
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
    // ...but not a file that merely ends with the marker's name.
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
      // Every suite must carry both halves: what it proves, and how.
      for (const suite of stack.suites) {
        expect(suite.acceptance.length, `${suite.id} acceptance`).toBeGreaterThan(10)
        expect(suite.command.length, `${suite.id} command`).toBeGreaterThan(3)
      }
    }
  })
})

describe('check marker', () => {
  it('reads the reported outcome', () => {
    expect(parseEvalMarker('all good\nEVAL_CHECK: PASS')).toEqual({ kind: 'check', status: 'pass' })
    expect(parseEvalMarker('EVAL_CHECK: FAIL')).toEqual({ kind: 'check', status: 'fail' })
    expect(parseEvalMarker('EVAL_CHECK: INCONCLUSIVE')).toEqual({
      kind: 'check',
      status: 'inconclusive',
    })
  })

  it('survives markdown emphasis around the marker', () => {
    expect(parseEvalMarker('**EVAL_CHECK**: **PASS**')).toEqual({ kind: 'check', status: 'pass' })
  })

  it('takes the LAST marker, so an echoed instruction cannot pass as the answer', () => {
    const echoed = `${checkPrompt('a line', 'npm test')}\n\nRan it.\nEVAL_CHECK: FAIL`
    expect(parseEvalMarker(echoed)).toEqual({ kind: 'check', status: 'fail' })
  })

  it('reports nothing when the session said nothing readable', () => {
    expect(parseEvalMarker('I ran the tests and they seem fine')).toBeNull()
    expect(parseEvalMarker('EVAL_CHECK: probably ok')).toBeNull()
    expect(parseEvalMarker('')).toBeNull()
  })

  it('reads a judge verdict and caps its length', () => {
    expect(parseEvalMarker('EVAL_JUDGE: satisfies the line, but nothing covers the error path')).toEqual({
      kind: 'judge',
      verdict: 'satisfies the line, but nothing covers the error path',
    })
    const long = parseEvalMarker(`EVAL_JUDGE: ${'x'.repeat(500)}`)
    expect(long?.kind === 'judge' && long.verdict.length).toBe(300)
  })
})

describe('dispatch prompts', () => {
  it('tells the session to report the real outcome and not to fix anything', () => {
    const prompt = checkPrompt('the bar shows', 'npx vitest run x')
    expect(prompt).toContain('npx vitest run x')
    expect(prompt).toContain('do not edit files')
    expect(prompt).toContain('EVAL_CHECK: PASS')
  })

  it('asks for isolated parallel attempts and forbids merging without asking', () => {
    const prompt = attemptsPrompt('the bar shows', 'npm test', 3)
    expect(prompt).toContain('3 INDEPENDENT attempts')
    expect(prompt).toContain('git worktree')
    expect(prompt).toContain('do not merge')
  })

  it('sends the judge to the advisor so it is a second opinion', () => {
    expect(judgePrompt('the bar shows')).toContain('`advisor`')
    expect(judgePrompt('the bar shows')).toContain('Do not change any code')
  })
})

describe('the verifier gate', () => {
  it('blocks a pass until the check has passed', () => {
    expect(canPassEval(line({ checkStatus: 'not_run' }))).toBe(false)
    expect(canPassEval(line({ checkStatus: 'fail' }))).toBe(false)
    expect(canPassEval(line({ checkStatus: 'inconclusive' }))).toBe(false)
    expect(canPassEval(line({ checkStatus: 'pass' }))).toBe(true)
  })

  it('does not block a line that has no check — the manual pass is its gate', () => {
    expect(canPassEval(line({ checkCmd: null }))).toBe(true)
  })
})

describe('derived stage', () => {
  it('walks implement → verify → review → done', () => {
    expect(evalStage(line())).toBe('implement')
    expect(evalStage(line({ checkStatus: 'pass' }))).toBe('verify')
    expect(evalStage(line({ checkStatus: 'pass', judge: 'looks right' }))).toBe('review')
    expect(evalStage(line({ checkStatus: 'pass', judge: 'looks right', verdict: 'pass' }))).toBe('done')
  })

  it('is done once the developer has ruled, even on a failure', () => {
    expect(evalStage(line({ verdict: 'fail' }))).toBe('done')
  })
})

// ".NET" is not one thing to verify. An HTTP smoke pass over the endpoints is the
// strongest evidence there is for a Web API, and close to worthless for a Blazor
// front end: every interactive render mode prerenders first, so the server's HTML
// is the same whether or not the component ever became interactive.
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
    // The core suites are shape-agnostic and must survive the narrowing.
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

  it('offers everything when the shape cannot be read, rather than hiding a suite on a guess', () => {
    // No reader at all (the sandbox image decision), and a reader that cannot open
    // anything, must both leave the catalog untouched.
    const all = TEST_STACKS.find((s) => s.id === 'dotnet')?.suites.map((s) => s.id)
    expect(detectStacks(['Api.sln'])[0].suites.map((s) => s.id)).toEqual(all)
    expect(suiteIds(['Api.sln', 'Program.cs'], {})).toEqual(all)
    expect(label(['Api.sln'], {})).toBe('.NET')
  })

  it('does not read a class named like a controller as evidence of a routed API', () => {
    // Naming a type is not registering it. Only the framework call, or the
    // Controllers folder convention, counts.
    const ids = suiteIds(['App.sln', 'Program.cs'], {
      'Program.cs': 'app.MapRazorComponents<App>();\n// class PolicyController lives elsewhere\n',
    })
    expect(ids).not.toContain('dotnet-http')
    expect(ids).toContain('blazor-ui')
  })

  it('takes a Controllers folder as an API, the asymmetry being deliberate', () => {
    // The shape this project really has on disk: a web SDK csproj whose Program.cs
    // is a level deeper than detection reads. Without the folder convention it
    // would fall through to "offer everything" and the narrowing would never fire.
    const entries = ['Api.sln', 'Sample.Api.csproj', 'Controllers', 'Controllers/PoliciesController.cs']
    const files = { 'Sample.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' }
    expect(label(entries, files)).toBe('.NET API')
    expect(suiteIds(entries, files)).not.toContain('blazor-ui')
  })
})

// A suite the project is not equipped for is worse than a missing figure: a
// verification run stops at its first failure, so one suite that cannot work took
// the rest of the run down with it and every later suite reported "not run".
describe('a coverage suite the project cannot run', () => {
  const nodeSuites = (manifest: string): string[] => {
    const stacks = detectStacks(['package.json'], () => manifest)
    return stacks.find((s) => s.stackId === 'node')?.suites.map((s) => s.id) ?? []
  }

  it('is not offered when no coverage provider is installed', () => {
    const ids = nodeSuites('{"devDependencies":{"vitest":"^4.1.0"}}')
    expect(ids).not.toContain('node-coverage')
    // Everything else the stack offers is untouched.
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
    // No reader is the sandbox-image question, which only asks whether .NET is
    // needed. Hiding a suite on no evidence would be a guess.
    const stacks = detectStacks(['package.json'])
    expect(stacks.find((s) => s.stackId === 'node')?.suites.map((s) => s.id)).toContain(
      'node-coverage',
    )
  })
})
