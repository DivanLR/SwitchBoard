export interface SpecKitCommand {
  command: string 
  label: string
  hint: string
}

export const SPEC_KIT_COMMANDS: readonly SpecKitCommand[] = [
  { command: 'speckit-clarify', label: '/speckit.clarify', hint: 'Scan the spec for ambiguity and ask up to 5 new clarification questions' },
  { command: 'speckit-plan', label: '/speckit.plan', hint: 'Regenerate plan.md from the current spec and answers' },
  { command: 'speckit-tasks', label: '/speckit.tasks', hint: 'Rebuild tasks.md from the plan, phase by phase' },
  { command: 'speckit-analyze', label: '/speckit.analyze', hint: 'Cross-check spec, plan, and tasks for drift or contradictions' },
  { command: 'speckit-implement', label: '/speckit.implement', hint: 'Execute every remaining task in tasks.md' },
  { command: 'speckit-checklist', label: '/speckit.checklist', hint: 'Generate a review checklist for the finished work' },
]

export interface CleanupCommand {
  command: string
  label: string
  hint: string
}

export interface CleanupGroup {
  stackSpecific?: boolean
  source: string
  tag: string
  blurb: string
  marketplace: string
  pkg: string
  commands: readonly CleanupCommand[]
}

export const CLEANUP_GROUPS: readonly CleanupGroup[] = [
  {
    stackSpecific: true,
    source: 'dotnet-claude-kit',
    tag: 'Roslyn-powered · .NET review & quality',
    blurb: 'Multi-dimensional review, health grading, and systematic cleanup for .NET projects.',
    marketplace: 'codewithmukesh/dotnet-claude-kit',
    pkg: 'dotnet-claude-kit@dotnet-claude-kit',
    commands: [
      { command: 'code-review', label: '/code-review', hint: 'Blast-radius-prioritized code review' },
      { command: 'de-sloppify', label: '/de-sloppify', hint: 'Format, remove dead code, fix analyzers, seal types' },
      { command: 'security-scan', label: '/security-scan', hint: 'OWASP, secrets, and CVE auditing' },
      { command: 'verify', label: '/verify', hint: 'Build, analyzers, tests, and security in one pass' },
      { command: 'health-check', label: '/health-check', hint: 'Letter-grade project assessment (A–F)' },
      { command: 'migrate', label: '/migrate', hint: 'EF Core migrations, .NET upgrades, NuGet updates' },
    ],
  },
  {
    source: 'ponytail',
    tag: 'the laziest senior dev · kill over-engineering',
    blurb: 'Find and delete code that never needed to exist — the best code is the code you never wrote.',
    marketplace: 'DietrichGebert/ponytail',
    pkg: 'ponytail@ponytail',
    commands: [
      { command: 'ponytail-review', label: '/ponytail-review', hint: 'Review the current diff for over-engineering' },
      { command: 'ponytail-audit', label: '/ponytail-audit', hint: 'Audit the whole repo, not just the diff' },
      { command: 'ponytail-debt', label: '/ponytail-debt', hint: 'Collect deferred ponytail: shortcuts into a ledger' },
    ],
  },
]
