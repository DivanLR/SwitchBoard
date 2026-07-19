// Terminal-style composer suggestions: the project's command history plus its
// available plugin/skill slash commands, surfaced as inline ghost text and a
// dropdown, with up-arrow recall. Extracted from SessionView so the view stays
// focused on rendering the stream.
import { computed, nextTick, ref, type Ref } from 'vue'

const MAX_SUGGESTIONS = 6
// A slash-command search (typing "/") lists every matching skill/command, not
// just the top few — the dropdown scrolls.
const MAX_SLASH_SUGGESTIONS = 50

export interface CommandSuggestions {
  suggestions: Ref<string[]>
  ghostRest: Ref<string>
  suggestIndex: Ref<number>
  acceptSuggestion: (text: string) => void
  onComposerInput: () => void
  onComposerKeydown: (event: KeyboardEvent) => void
  /** Load history + available commands for a project. */
  load: (projectId: string) => Promise<void>
  /** Reset transient recall/dropdown state (on project switch). */
  reset: () => void
  /** Record a just-sent command at the top of history. */
  recordSent: (text: string) => void
}

export function useCommandSuggestions(opts: {
  composer: Ref<string>
  composerEl: Ref<HTMLInputElement | null>
  onSubmit: () => void
}): CommandSuggestions {
  const { composer, composerEl, onSubmit } = opts

  const history = ref<string[]>([]) // past composer messages (also drives up-arrow recall)
  const availableCommands = ref<string[]>([]) // slash commands / skills for this project
  const histIndex = ref(-1) // up-arrow recall position when the composer is empty
  const suggestIndex = ref(-1) // highlighted dropdown row (-1 = none)
  const suggestDismissed = ref(false)

  /** Suggestion pool: available /commands (plugins + skills) first, then history. */
  const pool = computed<string[]>(() => {
    const cmds = availableCommands.value.map((c) => (c.startsWith('/') ? c : `/${c}`))
    return [...new Set([...cmds, ...history.value])]
  })

  /** Case-insensitive prefix matches for the dropdown (excludes the exact text). */
  const suggestions = computed<string[]>(() => {
    const typed = composer.value.trim()
    if (typed.length === 0 || suggestDismissed.value) return []
    const lower = typed.toLowerCase()
    // Typing "/" is a command palette: show all matching skills/commands.
    const cap = typed.startsWith('/') ? MAX_SLASH_SUGGESTIONS : MAX_SUGGESTIONS
    const seen = new Set<string>()
    const out: string[] = []
    for (const cmd of pool.value) {
      if (cmd === composer.value) continue
      if (!cmd.toLowerCase().startsWith(lower)) continue
      if (seen.has(cmd)) continue
      seen.add(cmd)
      out.push(cmd)
      if (out.length >= cap) break
    }
    return out
  })

  /** The single best case-sensitive continuation, rendered inline as ghost text. */
  const ghostMatch = computed<string | null>(() => {
    if (composer.value.length === 0 || suggestDismissed.value) return null
    return pool.value.find((cmd) => cmd.startsWith(composer.value) && cmd !== composer.value) ?? null
  })

  const ghostRest = computed(() =>
    ghostMatch.value ? ghostMatch.value.slice(composer.value.length) : '',
  )

  function acceptGhost(): boolean {
    if (!ghostMatch.value) return false
    composer.value = ghostMatch.value
    suggestIndex.value = -1
    return true
  }

  function acceptSuggestion(text: string): void {
    composer.value = text
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
    try {
      const [past, commands] = await Promise.all([
        window.switchboard.invoke('sessions.promptHistory', { projectId }),
        window.switchboard.invoke('projects.commands', { projectId }),
      ])
      history.value = past
      availableCommands.value = commands
    } catch {
      history.value = []
      availableCommands.value = []
    }
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

  return {
    suggestions,
    ghostRest,
    suggestIndex,
    acceptSuggestion,
    onComposerInput,
    onComposerKeydown,
    load,
    reset,
    recordSent,
  }
}
