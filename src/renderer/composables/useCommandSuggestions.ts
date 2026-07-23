// Terminal-style composer suggestions: the project's command history plus its
// available plugin/skill slash commands, surfaced as inline ghost text and a
// dropdown, with up-arrow recall. Extracted from SessionView so the view stays
// focused on rendering the stream.
import { computed, nextTick, ref, type Ref } from 'vue'
import type { ProjectCommand } from '@shared/domain'
import { useProjectsStore } from '@renderer/stores/projects'

// A slash-command search (typing "/") lists every matching skill/command, not
// just the top few — the dropdown scrolls.
const MAX_SLASH_SUGGESTIONS = 50

/** Case- and separator-insensitive key for command matching: "CI/CD" and
 *  "/dotnet-claude-kit:ci-cd" both reduce to comparable letter runs, so typing
 *  one surfaces the other regardless of the namespace, slash, colon or dash. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-_:/\s]/g, '')
}

export interface CommandSuggestions {
  suggestions: Ref<string[]>
  /** All available slash-command names for this project (for install detection). */
  availableCommandNames: Ref<string[]>
  ghostRest: Ref<string>
  /** True when the composer text exactly matches a known slash command. */
  isCommandMatch: Ref<boolean>
  suggestIndex: Ref<number>
  acceptSuggestion: (text: string) => void
  onComposerInput: () => void
  onComposerKeydown: (event: KeyboardEvent) => void
  /** Load history + available commands for a project. */
  load: (projectId: string) => Promise<void>
  /** Replace the available slash commands / skills (e.g. from a live push). */
  setCommands: (commands: ProjectCommand[]) => void
  /** Small explanation of what a suggested /command does, if known. */
  hintFor: (text: string) => string
  /** Reset transient recall/dropdown state (on project switch). */
  reset: () => void
  /** Record a just-sent command at the top of history. */
  recordSent: (text: string) => void
}

export function useCommandSuggestions(opts: {
  composer: Ref<string>
  composerEl: Ref<HTMLTextAreaElement | null>
  onSubmit: () => void
  /** Drops disabled plugin/skill commands (Settings → This project toggles). */
  filterCommands?: (commands: ProjectCommand[]) => ProjectCommand[]
}): CommandSuggestions {
  const { composer, composerEl, onSubmit } = opts
  const projects = useProjectsStore()
  // Guards against out-of-order responses: a rapid project switch must not leave
  // a previous project's history/commands showing for the new one.
  let latestLoad = ''

  const history = ref<string[]>([]) // past composer messages (also drives up-arrow recall)
  const availableCommands = ref<ProjectCommand[]>([]) // slash commands / skills for this project
  const histIndex = ref(-1) // up-arrow recall position when the composer is empty
  const suggestIndex = ref(-1) // highlighted dropdown row (-1 = none)
  const suggestDismissed = ref(false)

  const slashName = (name: string): string => (name.startsWith('/') ? name : `/${name}`)

  /** Suggestion pool: available /commands (plugins + skills) first, then history. */
  // Ghost-completion pool is COMMANDS ONLY — never past prompts. (History is
  // still kept for explicit up-arrow recall, just never auto-suggested.)
  const pool = computed<string[]>(() => availableCommands.value.map((c) => slashName(c.name)))

  /** Suggested /command text → its small what-it-does explanation. */
  const hints = computed<Map<string, string>>(() => {
    const map = new Map<string, string>()
    for (const c of availableCommands.value) {
      if (c.description) map.set(slashName(c.name), c.description)
    }
    return map
  })

  function hintFor(text: string): string {
    return hints.value.get(text) ?? ''
  }

  /** The slash token being typed: the trailing token when it starts with "/"
   *  and sits at the start of the input or right after whitespace. Command
   *  suggestions ONLY appear for such a token — plain prose never triggers
   *  them (typing "c" must not offer "/claude-api"). */
  function activeSlashToken(): { token: string; start: number } | null {
    const text = composer.value
    const m = /(^|\s)(\/\S*)$/.exec(text)
    if (!m) return null
    return { token: m[2], start: m.index + m[1].length }
  }

  /** Dropdown matches: commands (separator-insensitive substring, so "/cicd"
   *  finds "/dotnet-claude-kit:ci-cd") only for an active slash token;
   *  history stays prefix-only on the whole input. Commands first. */
  const suggestions = computed<string[]>(() => {
    const typed = composer.value.trim()
    if (typed.length === 0 || suggestDismissed.value) return []
    const slash = activeSlashToken()
    let cmds: string[] = []
    if (slash) {
      const key = normalizeForMatch(slash.token)
      cmds = availableCommands.value
        .map((c) => slashName(c.name))
        .filter((cmd) =>
          cmd !== slash.token &&
          // Empty key (typing only "/") lists the whole palette.
          (key.length === 0 ? true : normalizeForMatch(cmd).includes(key)),
        )
    }
    // Commands only — never past prompts in the dropdown.
    return [...new Set(cmds)].slice(0, MAX_SLASH_SUGGESTIONS)
  })

  /** The single best case-sensitive continuation, rendered inline as ghost text. */
  const ghostMatch = computed<string | null>(() => {
    if (composer.value.length === 0 || suggestDismissed.value) return null
    return pool.value.find((cmd) => cmd.startsWith(composer.value) && cmd !== composer.value) ?? null
  })

  const ghostRest = computed(() =>
    ghostMatch.value ? ghostMatch.value.slice(composer.value.length) : '',
  )

  /** The first token is a known slash command — stays true once arguments follow
   *  (e.g. "/foo do the thing"), so the command highlight persists past the space. */
  const isCommandMatch = computed(() => {
    const first = composer.value.trim().split(/\s+/)[0]
    return first.length > 0 && availableCommands.value.some((c) => slashName(c.name) === first)
  })

  function acceptGhost(): boolean {
    if (!ghostMatch.value) return false
    composer.value = ghostMatch.value
    suggestIndex.value = -1
    return true
  }

  function acceptSuggestion(text: string): void {
    // Accepting a command for a mid-sentence slash token replaces just that
    // token ("run /spec…" → "run /speckit-plan "); everything else (history,
    // a command typed from the start) replaces the whole input.
    const slash = activeSlashToken()
    if (text.startsWith('/') && slash && slash.start > 0) {
      composer.value = `${composer.value.slice(0, slash.start)}${text} `
    } else {
      composer.value = text
    }
    suggestIndex.value = -1
    suggestDismissed.value = true
    void nextTick(() => composerEl.value?.focus())
  }

  function onComposerInput(): void {
    histIndex.value = -1
    suggestIndex.value = -1
    suggestDismissed.value = false
  }

  function caretAtEnd(): boolean {
    const el = composerEl.value
    return (
      !!el &&
      el.selectionStart === composer.value.length &&
      el.selectionEnd === composer.value.length
    )
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    const list = suggestions.value
    switch (event.key) {
      case 'Tab':
        if (ghostRest.value) {
          event.preventDefault()
          acceptGhost()
        } else if (suggestIndex.value >= 0 && list[suggestIndex.value]) {
          event.preventDefault()
          acceptSuggestion(list[suggestIndex.value])
        }
        return
      case 'ArrowRight':
        if (ghostRest.value && caretAtEnd()) {
          event.preventDefault()
          acceptGhost()
        }
        return
      case 'ArrowDown':
        if (list.length > 0) {
          event.preventDefault()
          suggestIndex.value = Math.min(suggestIndex.value + 1, list.length - 1)
        } else if (histIndex.value >= 0) {
          // Recall mode: step toward newer commands, back to an empty line.
          event.preventDefault()
          histIndex.value -= 1
          composer.value = histIndex.value >= 0 ? (history.value[histIndex.value] ?? '') : ''
          suggestDismissed.value = true
        }
        return
      case 'ArrowUp':
        if (list.length > 0 && suggestIndex.value > 0) {
          event.preventDefault()
          suggestIndex.value -= 1
        } else if (list.length > 0 && suggestIndex.value === 0) {
          event.preventDefault()
          suggestIndex.value = -1
        } else if (history.value.length > 0 && (composer.value.trim() === '' || histIndex.value >= 0)) {
          // Recall older commands; stays in recall mode until the developer types.
          event.preventDefault()
          histIndex.value = Math.min(histIndex.value + 1, history.value.length - 1)
          composer.value = history.value[histIndex.value] ?? composer.value
          suggestDismissed.value = true
        }
        return
      case 'Enter':
        // Shift+Enter inserts a newline in the multi-line composer.
        if (event.shiftKey) return
        if (suggestIndex.value >= 0 && list[suggestIndex.value]) {
          event.preventDefault()
          acceptSuggestion(list[suggestIndex.value])
        } else {
          event.preventDefault()
          onSubmit()
        }
        return
      case 'Escape':
        if (list.length > 0 || ghostRest.value) {
          event.preventDefault()
          suggestIndex.value = -1
          suggestDismissed.value = true
        }
        return
      default:
        return
    }
  }

  async function load(projectId: string): Promise<void> {
    latestLoad = projectId
    try {
      const [past, commands] = await Promise.all([
        projects.promptHistory(projectId),
        projects.commands(projectId),
      ])
      if (latestLoad !== projectId) return // superseded by a newer project switch
      history.value = past
      availableCommands.value = opts.filterCommands?.(commands) ?? commands
    } catch {
      if (latestLoad !== projectId) return
      history.value = []
      availableCommands.value = []
    }
  }

  function setCommands(commands: ProjectCommand[]): void {
    availableCommands.value = opts.filterCommands?.(commands) ?? commands
  }

  function reset(): void {
    histIndex.value = -1
    suggestIndex.value = -1
    suggestDismissed.value = false
  }

  function recordSent(text: string): void {
    history.value = [text, ...history.value.filter((c) => c !== text)]
    reset()
  }

  const availableCommandNames = computed<string[]>(() =>
    availableCommands.value.map((c) => slashName(c.name)),
  )

  return {
    suggestions,
    availableCommandNames,
    ghostRest,
    isCommandMatch,
    suggestIndex,
    acceptSuggestion,
    onComposerInput,
    onComposerKeydown,
    load,
    setCommands,
    hintFor,
    reset,
    recordSent,
  }
}
