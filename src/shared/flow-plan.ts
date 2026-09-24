import type { FlowKind, FlowStage, SessionMode } from './domain'

export interface FlowPlannedCommand {
  name: string
  only: string | null
}

export interface FlowStagePlan {
  work: string
  commands: FlowPlannedCommand[]
}

const IDEA_WORK: Readonly<Record<string, string>> = {
  intake: 'Captures the idea as an intake note.',
  research: 'Gathers evidence for and against the idea.',
  define: 'Defines the problem, the goals and the success metrics.',
  shape: 'Shapes the concept options, the appetite and the trade offs.',
  decide: 'Decides go, needs clarification or kill. A go decision can start a feature.',
}

function command(name: string, only: string | null = null): FlowPlannedCommand {
  return { name, only }
}

export function flowStagePlan(
  kind: FlowKind,
  stage: FlowStage,
  stacks: readonly string[],
  checklist = false,
): FlowStagePlan {
  const dotnet = stacks.includes('dotnet')
  const angular = stacks.includes('angular')
  if (kind === 'idea') {
    return { work: IDEA_WORK[stage] ?? '', commands: [command(`speckit-assess-${stage}`)] }
  }
  switch (stage) {
    case 'spec':
      return {
        work: 'Writes the spec from the source and answers its clarification questions.',
        commands: [
          command('speckit-constitution', 'when the project has no constitution yet'),
          command('speckit-specify'),
          command('speckit-clarify'),
        ],
      }
    case 'plan':
      return {
        work: 'Writes the plan and the task list, then cross checks the spec, the plan and the tasks.',
        commands: [
          command('speckit-plan'),
          command('speckit-tasks'),
          command('speckit-analyze'),
          ...(checklist ? [command('speckit-checklist')] : []),
        ],
      }
    case 'build':
      return {
        work: 'Builds every task, then runs converge until nothing is left unbuilt, at most three rounds.',
        commands: [
          ...(dotnet ? [command('speckit-implement-scaffold')] : []),
          ...(angular ? [command('speckit-implement')] : []),
          command('speckit-converge'),
        ],
      }
    case 'clean':
      return {
        work: 'Cleans up the changes on the branch and applies the safe review findings, with the tests kept green.',
        commands: [...(dotnet ? [command('dotnet-claude-kit:de-sloppify')] : []), command('ponytail:ponytail-review')],
      }
    case 'test':
      return kind === 'bug'
        ? { work: 'Verifies the fix. The stage passes only when the bug test records verified.', commands: [command('speckit-bug-test')] }
        : { work: 'Writes the missing tests, then runs the test suites and reports what they measured.', commands: [] }
    case 'review':
      return {
        work: 'Reviews the branch against the acceptance criteria and the stack conventions, and gives a verdict.',
        commands: dotnet ? [command('dotnet-claude-kit:code-review'), command('dotnet-claude-kit:security-scan')] : [],
      }
    case 'ship':
      return {
        work: 'Commits, pushes and opens one pull request per repository. It never merges, approves or adds reviewers.',
        commands: [],
      }
    case 'assess':
      return { work: 'Assesses the symptom against the code and proposes a remediation.', commands: [command('speckit-bug-assess')] }
    case 'fix':
      return { work: 'Applies the remediation and commits the fix.', commands: [command('speckit-bug-fix')] }
    default:
      return { work: '', commands: [] }
  }
}

export function slashCommandOf(step: string): string | null {
  const match = /^\/([\w:.-]+)/.exec(step.trimStart())
  return match ? match[1] : null
}

export function missingCommands(needed: readonly string[], available: readonly string[]): string[] {
  return [...new Set(needed)].filter((name) => !available.some((have) => have === name || have.endsWith(`:${name}`)))
}

export function commandSource(name: string): string {
  if (name.startsWith('dotnet-claude-kit:')) return 'the dotnet-claude-kit plugin (marketplace codewithmukesh/dotnet-claude-kit)'
  if (name.startsWith('ponytail:')) return 'the ponytail plugin'
  if (name === 'speckit-implement-scaffold') return 'the speckit-implement-scaffold skill and its scaffold-implementer agent'
  if (name.startsWith('speckit-bug-')) return 'the Spec Kit bug extension, which the SDD tab installs'
  if (name.startsWith('speckit-assess-')) return 'the Spec Kit assess extension, which the SDD tab installs'
  if (name.startsWith('speckit-')) return 'the Spec Kit skills (run specify init in the project, or install a Spec Kit plugin)'
  return 'a Claude Code plugin or skill'
}

export function flowModeNote(mode: SessionMode, autopilot: boolean): string | null {
  if (mode === 'plan') return 'Stages run in accept edits, not plan first, because each stage has to write files.'
  if (!autopilot || mode === 'auto') return null
  const why =
    mode === 'default'
      ? 'Default mode asks you before each command'
      : mode === 'dontAsk'
        ? 'Don’t ask mode refuses each command that no rule allows, so a stage cannot build or test'
        : 'accept edits approves file edits only, and each command still asks you unless a standing rule allows it'
  return `Autopilot runs without you, but ${why}. Set this project’s session mode to Auto for an unattended run.`
}
