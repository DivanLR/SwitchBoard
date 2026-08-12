/**
 * Static catalogues of slash commands the UI offers: Spec Kit's stage commands
 * and the curated cleanup/review plugins.
 *
 * Kept out of domain.ts because nothing here mirrors a database column. domain.ts
 * is the single source of truth for PERSISTED shapes, and mixing display copy
 * into it makes it impossible to tell, at a glance, which types a migration has
 * to care about. This is the same reason test-catalog.ts is its own file.
 *
 * Editing these lists is a code change on purpose: the labels and hints are
 * design copy reviewed alongside the views that render them, not user settings.
 */

/**
 * Spec Kit stage commands (the Commands part tab). `label` is the design's
 * display form (/speckit.clarify); `command` is the real installed skill the
 * session receives (/speckit-clarify).
 */
export interface SpecKitCommand {
  command: string // e.g. "speckit-clarify"
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

/**
 * Curated code-review / cleanup commands for the Cleanup section, sourced from
 * the Ponytail and Dotnet Claude Kit plugins. `command` is the dash-form slash
 * command the session receives (the section sends `/${command}`); availability
 * depends on the project having the relevant plugin installed.
 */
export interface CleanupCommand {
  command: string
  label: string
  hint: string
}

export interface CleanupGroup {
  /**
   * Whether this plugin only makes sense for one ecosystem.
   *
   * A stack-specific plugin is offered only once it is actually installed. The
   * .NET toolkit was advertised, with a download button, on every project
   * regardless of language — and PRODUCT.md names "a developer who installs the
   * release without ever having seen the source" as a real audience, most of whom
   * do not write .NET. Installing it remains the way in; the app just stops
   * recommending one ecosystem's tooling to everyone.
   */
  stackSpecific?: boolean
  /** Plugin slug, shown as the group name (design: "dotnet-claude-kit"). */
  source: string
  /** Short tag line shown after the name. */
  tag: string
  blurb: string
  /**
   * The marketplace source, as `claude plugin marketplace add` takes it: a
   * GitHub repo, a URL or a path. NOT a slash command. These held
   * `/plugin marketplace add …` strings that were sent to a session as chat, and
   * `/plugin` does not exist in an Agent SDK session, so no install ever ran.
   * See main/sessions/plugin-install.ts.
   */
  marketplace: string
  /** Package id for `claude plugin install`, as `<plugin>@<marketplace>`. */
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
      // Every entry must name a command the plugin actually ships. /outdated and
      // /arch-check sat here through several releases and never existed in any
      // version of the toolkit, so both rows sent a command that could only ever
      // answer "Unknown command". /migrate is the real dependency and upgrade
      // workflow; architecture conformance has no one-shot command to point at.
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
