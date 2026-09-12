import { computed, nextTick, ref, type Ref } from 'vue'
import type { ProjectCommand } from '@shared/domain'
import { useProjectsStore } from '@renderer/stores/projects'

const MAX_SLASH_SUGGESTIONS = 50

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-_:/\s]/g, '')
}

export function useCommandSuggestions(opts: {
  composer: Ref<string>
  composerEl: Ref<HTMLTextAreaElement | null>
  onSubmit: () => void
  filterCommands?: (commands: ProjectCommand[]) => ProjectCommand[]
}) {
  const { composer, composerEl, onSubmit } = opts
  const projects = useProjectsStore()
  let latestLoad = ''

  const history = ref<string[]>([]) 
  const availableCommands = ref<ProjectCommand[]>([]) 
  const histIndex = ref(-1) 
  const suggestIndex = ref(-1) 
  const suggestDismissed = ref(false)

  const slashName = (name: string): string => (name.startsWith('/') ? name : `/${name}`)

  const pool = computed<string[]>(() => availableCommands.value.map((c) => slashName(c.name)))

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

  function activeSlashToken(): { token: string; start: number } | null {
    const text = composer.value
    const m = /(^|\s)(\/\S*)$/.exec(text)
    if (!m) return null
    return { token: m[2], start: m.index + m[1].length }
  }

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
          (key.length === 0 ? true : normalizeForMatch(cmd).includes(key)),
        )
    }
    return [...new Set(cmds)].slice(0, MAX_SLASH_SUGGESTIONS)
  })

  const ghostMatch = computed<string | null>(() => {
    if (composer.value.length === 0 || suggestDismissed.value) return null
    return pool.value.find((cmd) => cmd.startsWith(composer.value) && cmd !== composer.value) ?? null
  })

  const ghostRest = computed(() =>
    ghostMatch.value ? ghostMatch.value.slice(composer.value.length) : '',
  )

  const isCommandMatch = computed(() => {
    const first = composer.value.trim().split(/\s+/)[0]
    return first.length > 0 && availableCommands.value.some((c) => slashName(c.name) === first)
  })

  function acceptGhost(): boolean {
    if (!ghostMatch.value) return false
    composer.value = ghostMatch.value
    suggestIndex.value = -1
    suggestDismissed.value = true
    return true
  }

  function acceptSuggestion(text: string): void {
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
    syncGhostScroll()
  }

  function syncGhostScroll(): void {
    const el = composerEl.value
    const ghost = el?.parentElement?.querySelector<HTMLElement>('.ghost')
    if (el && ghost) ghost.scrollTop = el.scrollTop
  }

  function scrollSuggestionIntoView(): void {
    void nextTick(() => {
      const active = composerEl.value?.parentElement?.querySelector('.suggest-item.active')
      active?.scrollIntoView?.({ block: 'nearest' })
    })
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
        if (event.shiftKey) return
        event.preventDefault()
        if (ghostRest.value) {
          acceptGhost()
        } else if (suggestIndex.value >= 0 && list[suggestIndex.value]) {
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
          scrollSuggestionIntoView()
        } else if (histIndex.value >= 0) {
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
          scrollSuggestionIntoView()
        } else if (list.length > 0 && suggestIndex.value === 0) {
          event.preventDefault()
          suggestIndex.value = -1
        } else if (history.value.length > 0 && (composer.value.trim() === '' || histIndex.value >= 0)) {
          event.preventDefault()
          histIndex.value = Math.min(histIndex.value + 1, history.value.length - 1)
          composer.value = history.value[histIndex.value] ?? composer.value
          suggestDismissed.value = true
        }
        return
      case 'Enter':
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
      if (latestLoad !== projectId) return 
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
    onComposerScroll: syncGhostScroll,
    load,
    setCommands,
    hintFor,
    reset,
    recordSent,
  }
}
