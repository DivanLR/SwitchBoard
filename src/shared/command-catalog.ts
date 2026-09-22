interface SpecKitCommand {
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

