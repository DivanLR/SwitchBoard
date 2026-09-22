<script lang="ts">
const composerDrafts = new Map<string, string>()
</script>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  onWatcherCleanup,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { agentIdOf } from '@shared/domain'
import type { SectionKind, SessionEvent } from '@shared/domain'
import type { CleanupGroup } from '@shared/command-catalog'
import { DIAGRAM_PLUGIN } from '@shared/diagram'
import { activeAgents } from '@shared/agents'
import { parseInlineQuestion } from '@shared/inline-question'
import type { ProjectListItem } from '@shared/ipc-types'
import { errorMessage } from '@renderer/ipc'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import { useProjectRefs } from '@renderer/composables/useProjectRefs'
import { formatTokens as fmtTok, useSessionUsage } from '@renderer/composables/useSessionUsage'
import { useQueuedTasks } from '@renderer/composables/useQueuedTasks'
import { useSessionStart } from '@renderer/composables/useSessionStart'
import { useStopConfirm } from '@renderer/composables/useStopConfirm'
import { useNow } from '@renderer/composables/useNow'
import { elapsedClock } from '@renderer/relative-time'
import { toRawLines } from '@shared/stream-lines'
import { useSpecsStore } from '@renderer/stores/specs'
import { useDiffStore } from '@renderer/stores/diff'
import { accentFor } from '@renderer/project-accent'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import SwallowedBlock from '@renderer/components/SwallowedBlock.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import Icon from '@renderer/components/Icon.vue'
import EffortBar from '@renderer/components/EffortBar.vue'
import SpecsView from '@renderer/views/SpecsView.vue'
import CleanupView from '@renderer/views/CleanupView.vue'
import TestsView from '@renderer/views/TestsView.vue'
import DiffView from '@renderer/views/DiffView.vue'
import DiagramsView from '@renderer/views/DiagramsView.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import SkillsView from '@renderer/views/SkillsView.vue'
import ConversationTerminal from '@renderer/components/ConversationTerminal.vue'
import SessionWaitOverlay from '@renderer/components/SessionWaitOverlay.vue'

const props = defineProps<{ project: ProjectListItem }>()
const emit = defineEmits<{ (e: 'open-settings', tab: 'skills'): void; (e: 'open-flow'): void }>()

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const settingsStore = useSettingsStore()
const specs = useSpecsStore()
const diff = useDiffStore()

const queuedTasks = computed(() => queue.forProject(props.project.id))

const headerColor = computed(() => accentFor(props.project.id))

const outputPrefs = computed(() => ({
  fontSize: settingsStore.settings?.fontSize ?? 'md',
  showToolRows: settingsStore.settings?.showToolRows ?? false,
  showInjections: settingsStore.settings?.showInjections ?? false,
  timestamps: settingsStore.settings?.timestamps ?? false,
  autoscroll: settingsStore.settings?.autoscroll ?? true,
}))
const streamZoom = computed(
  () => ({ sm: '0.92', md: '1', lg: '1.1' })[outputPrefs.value.fontSize],
)

const PILL_LABELS: Record<string, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  done: 'Done',
  error: 'Error',
}
function pillLabel(status: string): string {
  return PILL_LABELS[status] ?? status
}

const terminalEverOpened = ref(false)
const terminalMode = ref<'chat' | 'shell'>('chat')
const shellEverOpened = ref(false)
const mainTab = ref<
  | 'session'
  | 'terminal'
  | 'specs'
  | 'tests'
  | 'diff'
  | 'cleanup'
  | 'diagrams'
  | 'skills'
>('session')
const specCount = computed(() => specs.stateFor(props.project.id).specs.length)
const diffCount = computed(() => diff.resultFor(props.project.id).files.length)

const composer = ref('')
const editTarget = ref<string | null>(null)
const restoredDraft = ref<string | null>(null)
const streamEl = ref<HTMLElement | null>(null)
const composerEl = ref<HTMLTextAreaElement | null>(null)

const {
  suggestions,
  availableCommandNames,
  ghostRest,
  isCommandMatch,
  suggestIndex,
  acceptSuggestion,
  onComposerInput,
  onComposerKeydown,
  onComposerScroll,
  load: loadHistory,
  setCommands: setSuggestionCommands,
  hintFor,
  reset: resetSuggestions,
  recordSent,
} = useCommandSuggestions({
  composer,
  composerEl,
  onSubmit: () => void send(),
  filterCommands: (commands) => {
    const disabled = settingsStore.settings?.disabledCommands?.[props.project.id] ?? []
    return commands.filter((c) => !disabled.includes(c.name))
  },
})

const commandParts = computed(() => {
  const text = composer.value
  const lead = text.length - text.trimStart().length
  const first = text.trim().split(/\s+/)[0] ?? ''
  const end = lead + first.length
  return { cmd: text.slice(0, end), rest: text.slice(end) }
})

const liveSession = computed(() =>
  props.project.session && !props.project.session.endedAt ? props.project.session : null,
)
const endedSession = computed(() =>
  props.project.session && props.project.session.endedAt ? props.project.session : null,
)

const pendingCount = computed(
  () => inbox.pending.filter((p) => p.projectId === props.project.id).length,
)

const terminalSession = computed(() => liveSession.value ?? endedSession.value)

const terminalResumeId = computed(() => {
  const ended = endedSession.value
  if (liveSession.value || !ended?.sdkSessionId) return null
  if (ended.bypassPermissions || props.project.useContainers) return null
  return ended.sdkSessionId
})

const now = useNow(1000)

const { stopConfirm, cancelStop, confirmStop } = useStopConfirm({
  composerEl,
  liveSession: () => liveSession.value,
  interrupt: () => interrupt(),
})

let unsubscribeCommands: (() => void) | undefined
onMounted(() => {
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
})
onUnmounted(() => {
  unsubscribeCommands?.()
  composerDrafts.set(props.project.id, composer.value)
})

const sessionTimer = computed(() =>
  liveSession.value ? elapsedClock(liveSession.value.startedAt, now.value) : null,
)

const showTimer = computed(() => settingsStore.settings?.showSessionTimer ?? true)

const sessionStamp = computed(() => {
  const id = liveSession.value?.id ?? endedSession.value?.id ?? null
  return id ? { short: id.slice(0, 8), full: id } : null
})

const workingAgents = computed(() =>
  liveSession.value?.status === 'working' ? activeAgents(active.events) : [],
)

const backgroundTasks = computed(() => liveSession.value?.backgroundTasks ?? [])

let scanned = 0
const interimSummaries = ref<Set<string>>(new Set())
watch(
  [() => active.events.length, backgroundTasks],
  () => {
    const events = active.events
    if (backgroundTasks.value.length > 0) {
      for (let i = scanned; i < events.length; i++) {
        if (events[i].kind === 'summary') interimSummaries.value.add(events[i].id)
      }
    } else if (interimSummaries.value.size > 0) {
      interimSummaries.value = new Set()
    }
    scanned = events.length
  },
)

const SHOW_LIMIT = 6
function useCapped<T>(list: ComputedRef<T[]>): { expanded: Ref<boolean>; shown: ComputedRef<T[]> } {
  const expanded = ref(false)
  return {
    expanded,
    shown: computed(() => (expanded.value ? list.value : list.value.slice(0, SHOW_LIMIT))),
  }
}
const { expanded: agentsExpanded, shown: shownAgents } = useCapped(workingAgents)
const { expanded: tasksExpanded, shown: shownTasks } = useCapped(backgroundTasks)

const selectedAgent = computed(
  () => workingAgents.value.find((a) => a.id === active.selectedAgentId) ?? null,
)

watch(
  [() => active.selectedAgentId, workingAgents],
  ([agentId]) => {
    if (!agentId) return
    if (!workingAgents.value.some((a) => a.id === agentId)) {
      active.selectAgent(null)
    } else {
      mainTab.value = 'session'
    }
  },
)

const sendTo = computed(
  () => selectedAgent.value?.task || selectedAgent.value?.name || props.project.name,
)

const composerPlaceholder = computed(() => {
  if (editTarget.value) return `Describe the change for ${editTarget.value}…`
  return liveSession.value ? `Send a message to ${sendTo.value}…` : 'Start a session first'
})

const composerDead = computed(() => !liveSession.value && !editTarget.value)

const composerEmpty = computed(() => composer.value.trim().length === 0)

const { cacheHitPct, cacheColor, sessionUsage, currentModelLabel } = useSessionUsage(liveSession)

async function openFullUsage(): Promise<void> {
  if (!liveSession.value) return
  mainTab.value = 'session'
  await active.send('/usage')
  scrollToBottom()
}

watch(
  () => (liveSession.value ?? endedSession.value)?.id ?? null,
  async (sessionId) => {
    interimSummaries.value = new Set() 
    let superseded = false
    onWatcherCleanup(() => {
      superseded = true
    })
    await active.open(sessionId)
    if (superseded) return
    if (restoredDraft.value === null && props.project.drafts.length > 0 && composer.value === '') {
      composer.value = props.project.drafts.map((d) => d.text).join('\n')
      restoredDraft.value = composer.value
    }
    scrollToBottom()
  },
  { immediate: true },
)

watch(
  [() => liveSession.value?.id ?? null, mainTab, () => props.project.id, () => active.selectedAgentId],
  () => {
    if (!liveSession.value || mainTab.value !== 'session') return
    void nextTick(() => {
      if (document.activeElement?.getAttribute('role') !== 'tab') composerEl.value?.focus()
    })
  },
  { immediate: true },
)

const DERIVE_WINDOW = 1500
const deriveWindow = ref(DERIVE_WINDOW)

const followTail = ref(true)

let sessionStart: ReturnType<typeof useSessionStart> | undefined

watch(
  () => props.project.id,
  (projectId, prevId) => {
    if (prevId) composerDrafts.set(prevId, composer.value)
    composer.value = composerDrafts.get(projectId) ?? ''
    restoredDraft.value = null
    mainTab.value = 'session'
    terminalEverOpened.value = false
    shellEverOpened.value = false
    terminalMode.value = 'chat'
    editTarget.value = null
    sessionStart?.reset()
    cancelStop()
    deriveWindow.value = DERIVE_WINDOW
    followTail.value = true
    resetSuggestions()
    void loadHistory(projectId)
    void specs.loadState(projectId)
    void diff.loadList(projectId)
    void queue.load(projectId)
  },
  { immediate: true },
)

watch(
  [
    () => liveSession.value?.diffAdds ?? null,
    () => liveSession.value?.diffDels ?? null,
    () => liveSession.value?.id ?? null,
  ],
  () => {
    if (mainTab.value !== 'diff') return
    void diff.loadList(props.project.id)
  },
)

watch(mainTab, (tab) => {
  if (tab === 'diff') void diff.loadList(props.project.id)
})

sessionStart = useSessionStart({
  project: () => props.project,
  endedSession,
})
const {
  startMode,
  startEngine,
  modeOpen,
  resumeSession,
  runInContainer,
  containerForced,
  containerOn,
  startError,
  modeChoices,
  startModeLabel,
  startModeDetail,
  canResume,
  busy,
  start,
} = sessionStart

type StreamItem =
  | { type: 'event'; event: SessionEvent }
  | { type: 'block'; noiseKind: string; events: SessionEvent[]; key: string }

const derivedFrom = computed<SessionEvent[]>(() => {
  const all = active.events
  if (all.length <= deriveWindow.value) return all
  let start = all.length - deriveWindow.value
  const floor = Math.max(0, start - 200)
  while (start > floor && all[start].noiseKind) start -= 1
  return all.slice(start)
})

const scopedEvents = computed<SessionEvent[]>(() => {
  const agent = selectedAgent.value
  if (!agent) return derivedFrom.value.filter((e) => agentIdOf(e) === undefined)
  const intro: SessionEvent = {
    id: `agent-intro-${agent.id}`,
    sessionId: active.sessionId ?? '',
    seq: -1,
    kind: 'prompt',
    payload: { text: `[${props.project.name}] ${agent.prompt}` },
    noiseKind: null,
    createdAt: '',
  }
  return [intro, ...derivedFrom.value.filter((e) => agentIdOf(e) === agent.id)]
})

const items = computed<StreamItem[]>(() => {
  const result: StreamItem[] = []
  let block: { noiseKind: string; events: SessionEvent[] } | null = null
  for (const event of scopedEvents.value) {
    if (event.kind === 'tool_activity') {
      const toolName = (event.payload as { toolName?: string }).toolName
      if (toolName === 'Task' || toolName === 'Agent') continue
      if (!outputPrefs.value.showToolRows) continue
    }
    if (event.kind === 'injection' && !outputPrefs.value.showInjections) continue
    if (event.kind === 'summary' && interimSummaries.value.has(event.id)) continue
    if (event.noiseKind) {
      if (block && block.noiseKind === event.noiseKind) {
        block.events.push(event)
      } else {
        if (block) result.push({ type: 'block', ...block, key: block.events[0].id })
        block = { noiseKind: event.noiseKind, events: [event] }
      }
    } else {
      if (block) {
        result.push({ type: 'block', ...block, key: block.events[0].id })
        block = null
      }
      result.push({ type: 'event', event })
    }
  }
  if (block) result.push({ type: 'block', ...block, key: block.events[0].id })
  return result
})

const MAX_RENDER = 500
const renderStart = ref(0)

watch(
  () => items.value.length,
  (length) => {
    const tail = Math.max(0, length - MAX_RENDER)
    if (followTail.value) {
      renderStart.value = tail
      return
    }
    if (renderStart.value > length) renderStart.value = tail
  },
)
const visibleItems = computed(() => items.value.slice(renderStart.value))

watch(
  () => active.events.length,
  (count) => {
    if (!followTail.value && deriveWindow.value < count) deriveWindow.value = count
  },
)

function showEarlier(): void {
  followTail.value = false
  renderStart.value = Math.max(0, renderStart.value - MAX_RENDER)
  if (renderStart.value > 0) return
  if (deriveWindow.value < active.events.length) {
    deriveWindow.value += DERIVE_WINDOW
    return
  }
  if (active.hasMoreHistory) void active.loadEarlier()
}

const rawLines = computed(() => toRawLines(derivedFrom.value, outputPrefs.value.timestamps))

function scrollToBottom(): void {
  void nextTick(() => {
    if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
  })
}

const atBottom = ref(true)

function onStreamScroll(): void {
  const el = streamEl.value
  atBottom.value = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch([() => active.events.length, () => active.view, () => liveSession.value?.id, mainTab], () =>
  void nextTick(onStreamScroll),
)

function switchView(view: 'clean' | 'raw'): void {
  mainTab.value = 'session'
  active.setView(view)
  scrollToBottom()
}

function openTerminal(): void {
  editTarget.value = null
  terminalEverOpened.value = true
  mainTab.value = 'terminal'
}


function openShell(): void {
  shellEverOpened.value = true
  terminalMode.value = 'shell'
}

const convTerm = useTemplateRef<InstanceType<typeof ConversationTerminal>>('convTerm')

async function sendFromTerminal(text: string): Promise<void> {
  busy.value = true
  let delivered = false
  try {
    delivered = await deliver(text)
  } finally {
    busy.value = false
    if (!delivered) convTerm.value?.restore(text)
  }
}

function onViewKeydown(event: KeyboardEvent): void {
  const views = ['clean', 'raw', 'terminal'] as const
  const current = mainTab.value === 'terminal' ? 'terminal' : active.view
  let index = views.indexOf(current)
  if (event.key === 'ArrowRight') index = (index + 1) % views.length
  else if (event.key === 'ArrowLeft') index = (index + views.length - 1) % views.length
  else if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = views.length - 1
  else return
  event.preventDefault()
  const view = views[index]
  if (view === 'terminal') openTerminal()
  else switchView(view)
  const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')
  void nextTick(() => tabs[index]?.focus())
}

watch(mainTab, (tab) => {
  if (tab === 'session') scrollToBottom()
})

watch(
  () => active.events.length,
  () => {
    if (!outputPrefs.value.autoscroll) return
    const el = streamEl.value
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) scrollToBottom()
  },
)

watch(
  () => active.focusEventId,
  (eventId) => {
    if (!eventId) return
    void nextTick(() => {
      const el = streamEl.value?.querySelector(`[data-event-id="${eventId}"]`)
      el?.scrollIntoView({ block: 'center' })
      active.clearFocusEvent()
    })
  },
)

const nameDraft = ref<string | null>(null)
const nameInputEl = ref<HTMLInputElement | null>(null)

function openNameEdit(): void {
  const target = liveSession.value ?? endedSession.value
  if (!target) return
  nameDraft.value = target.label ?? ''
  void nextTick(() => nameInputEl.value?.select())
}

function saveName(): void {
  const draft = nameDraft.value
  const target = liveSession.value ?? endedSession.value
  nameDraft.value = null
  if (draft === null || !target || draft.trim() === (target.label ?? '')) return
  void projects.renameSession(target.id, draft)
}

function startAnother(): void {
  void projects.startSession(props.project.id)
}

function onContainersToggle(e: Event): void {
  void projects.setUseContainers(props.project.id, (e.target as HTMLInputElement).checked)
}

const suggestGroups = computed<{ label: string; items: { cmd: string; index: number }[] }[]>(() => {
  const groups = new Map<string, { cmd: string; index: number }[]>()
  suggestions.value.forEach((cmd, index) => {
    const bare = cmd.replace(/^\//, '')
    const colon = bare.indexOf(':')
    const label = colon === -1 ? 'Commands' : bare.slice(0, colon)
    const list = groups.get(label)
    if (list) list.push({ cmd, index })
    else groups.set(label, [{ cmd, index }])
  })
  return [...groups].map(([label, items]) => ({ label, items }))
})

const typedToken = computed<string>(() => {
  const match = /(?:^|\s)\/([^\s]*)$/.exec(composer.value)
  return match ? match[1].toLowerCase() : ''
})

function matchParts(cmd: string): { before: string; hit: string; after: string } {
  const token = typedToken.value
  if (token === '') return { before: cmd, hit: '', after: '' }
  const at = cmd.toLowerCase().indexOf(token)
  if (at === -1) return { before: cmd, hit: '', after: '' }
  return { before: cmd.slice(0, at), hit: cmd.slice(at, at + token.length), after: cmd.slice(at + token.length) }
}

function onSetTarget(label: string): void {
  editTarget.value = label
  void nextTick(() => composerEl.value?.focus())
}

const sectionSessionIds = ref<Partial<Record<SectionKind, string>>>({})

function runPluginCommand(text: string, kind: SectionKind, watchDiagrams = false): void {
  void specs.runInSession(props.project.id, text, true, watchDiagrams, kind).then((id) => {
    sectionSessionIds.value = { ...sectionSessionIds.value, [kind]: id }
  })
}

function runDiagramCommand(text: string): void {
  runPluginCommand(text, 'diagram', true)
}

function onRanInSection(): void {
  scrollToBottom()
}

const installing = ref<string | null>(null)
const installError = ref<string | null>(null)

async function installPlugin(marketplace: string, pkg: string): Promise<void> {
  if (installing.value) return
  installing.value = pkg
  installError.value = null
  try {
    const commands = await projects.installPlugin(props.project.id, marketplace, pkg)
    setSuggestionCommands(commands)
  } catch (e) {
    installError.value = errorMessage(e)
  } finally {
    installing.value = null
  }
}

const installCleanup = (group: CleanupGroup): Promise<void> =>
  installPlugin(group.marketplace, group.pkg)

const installDiagramPlugin = (): Promise<void> =>
  installPlugin(DIAGRAM_PLUGIN.marketplace, DIAGRAM_PLUGIN.pkg)

async function send(): Promise<void> {
  const text = composer.value.trim()
  if (!text) return
  busy.value = true
  try {
    if (editTarget.value) {
      const target = editTarget.value
      composer.value = ''
      editTarget.value = null
      await specs.runSpecCommand(
        props.project.id,
        `✎ Spec edit → ${target}: ${text}`,
        'spec-edit',
        'Applying your edit',
      )
      return
    }
    if (await deliver(text)) composer.value = ''
  } finally {
    busy.value = false
  }
}

// The one path a message takes to the live session, from the composer or the
// Terminal view alike, so agent addressing and @refs cannot drift between them.
async function deliver(text: string): Promise<boolean> {
  if (!liveSession.value) return false
  const agent = selectedAgent.value
  const refs = props.project.refs
  const withRefs =
    refs.length > 0 ? `${text}\n\n${refs.map((r) => `@${r.path}`).join('\n')}` : text
  if (agent) await active.send(`[to ${agent.name}] ${withRefs}`, agent.id)
  else await active.send(withRefs)
  recordSent(text)
  scrollToBottom()
  return true
}

async function enqueue(): Promise<void> {
  const text = composer.value.trim()
  if (!text) return
  await addQueued(text)
  composer.value = ''
  resetSuggestions()
}


async function interrupt(): Promise<void> {
  await active.interrupt()
}

const endingFor = ref<string | null>(null)
const ending = computed(() => endingFor.value === props.project.id)

async function stop(): Promise<void> {
  endingFor.value = props.project.id
  try {
    await active.stop()
  } finally {
    endingFor.value = null
  }
}

function answerQuestion(eventId: string, choice: string): void {
  void active.answerQuestion(eventId, choice)
}

const inlineAnswered = ref<string | null>(null)

const inlineQuestion = computed(() => {
  if (!liveSession.value || liveSession.value.status === 'working') return null
  const events = scopedEvents.value
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind === 'prompt') return null 
    if (event.kind === 'assistant_text' || event.kind === 'summary') {
      if (event.id === inlineAnswered.value) return null
      const text = (event.payload as { text?: string }).text ?? ''
      const payload = parseInlineQuestion(text)
      return payload ? { eventId: event.id, payload } : null
    }
  }
  return null
})

function onInlineAnswer(eventId: string, choice: string): void {
  inlineAnswered.value = eventId
  const text = choice.replace(/\s*\(recommended\)\s*$/i, '')
  const agent = selectedAgent.value
  if (agent) void active.send(`[to ${agent.name}] ${text}`, agent.id)
  else void active.send(text)
}

function openInbox(requestId: string): void {
  inbox.focusRequest(requestId)
}

const queuedEditError = ref('')
async function editQueued(eventId: string, text: string): Promise<void> {
  queuedEditError.value = ''
  try {
    await active.editQueued(eventId, text)
  } catch (error) {
    queuedEditError.value = errorMessage(error, 'That message could not be changed')
  }
}

watch(
  () => active.composerInsert,
  (text) => {
    if (!text) return
    composer.value = composer.value ? `${composer.value} ${text}` : text
    active.clearComposerInsert()
    composerEl.value?.focus()
  },
)

const {
  addingRef,
  refInput,
  refError,
  commitRef,
  cancelRef,
  removeRef,
  dragKind,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
} = useProjectRefs({
  projectId: () => props.project.id,
  onInsertPath: (path) => {
    composer.value = composer.value ? `${composer.value} @${path}` : `@${path}`
  },
})

const {
  editingQueued,
  queuedDraft,
  addQueued,
  removeQueued,
  beginEditQueued,
  saveQueued,
  cancelEditQueued,
} = useQueuedTasks(() => props.project.id)
</script>

<template>
  <div
    class="session-view"
    :class="{ 'is-ended': !!endedSession }"
    :data-session-ended="endedSession ? 'true' : 'false'"
    @dragover="onPaneDragOver"
    @dragleave="onPaneDragLeave"
    @drop="onPaneDrop"
  >
    <header v-if="!active.fullScreenSection" class="head">
      <div class="head-row">
        <div class="ident ui-chip">
          <span class="h-dot" :style="{ background: headerColor }"></span>
          <span class="h-name" data-testid="session-project-name">{{ project.name }}</span>
          <span class="h-path code" data-testid="session-project-path">{{ project.path }}</span>
        </div>
        <span class="spacer"></span>
        <span
          v-if="liveSession?.bypassPermissions"
          class="pill bypass-pill"
          data-testid="bypass-pill"
          title="Started with --dangerously-skip-permissions"
        >
          <Icon name="warning" :size="12" /> Bypass
        </span>
        <button
          v-if="liveSession && !liveSession.bypassPermissions"
          class="pill plan-pill"
          :class="{ on: liveSession.inPlanMode }"
          data-testid="plan-mode-toggle"
          role="switch"
          :aria-checked="!!liveSession.inPlanMode"
          :title="
            liveSession.inPlanMode
              ? 'Read-only until a plan is approved. Click to leave plan mode; it applies from the next tool call.'
              : 'Switch to planning: read-only until a plan is approved. It applies from the next tool call.'
          "
          @click="active.setPlanMode(!liveSession.inPlanMode)"
        >
          <Icon name="panel" :size="12" /> {{ liveSession.inPlanMode ? 'Planning' : 'Plan' }}
        </button>
        <template v-if="settingsStore.settings">
          <EffortBar
            :model-value="settingsStore.settings.effort"
            label="Effort"
            icon="spark"
            testid="effort-bar"
            title="Reasoning effort for the main loop. Applies from the next message, to every session. Subagents exist only at max."
            @update:model-value="(effort) => settingsStore.save({ effort })"
          />
          <EffortBar
            v-if="settingsStore.settings.effort === 'max'"
            :model-value="settingsStore.settings.subagentEffort"
            label="Subagents"
            icon="fork"
            testid="subagent-effort-bar"
            title="Reasoning effort for the subagents a session creates. Max also switches on divide and conquer. Read at session start."
            @update:model-value="(subagentEffort) => settingsStore.save({ subagentEffort })"
          />
        </template>
        <span
          v-if="liveSession?.bypassPermissions && project.gitNotice"
          class="pill nogit-pill"
          data-testid="nogit-pill"
          :title="project.gitNotice"
        >
          <Icon name="warning" :size="12" /> No git
        </span>
        <span
          v-if="liveSession?.heavySubagents"
          class="pill fanout-pill"
          data-testid="fanout-pill"
          title="Started with the subagent effort bar at max: this session is told to split work across as many subagents as it can. Moving the bar applies from the next session."
        >
          <Icon name="fork" :size="12" /> Fan-out
        </span>
        <span
          v-if="workingAgents.length > 1"
          class="pill agents-pill"
          data-testid="agents-pill"
        >
          <Icon name="fork" :size="12" /> {{ workingAgents.length }} agents
        </span>
        <span
          v-if="backgroundTasks.length > 0"
          class="pill bg-pill"
          data-testid="bg-pill"
          title="Background tasks running"
        >
          <Icon name="clock" :size="12" /> {{ backgroundTasks.length }} background
        </span>
        <span
          v-if="liveSession"
          class="pill"
          :class="liveSession.status"
          data-testid="session-pill"
        >
          {{ pillLabel(liveSession.status) }}
        </span>
        <span v-else-if="endedSession" class="pill ended">Ended</span>

        <button
          class="ctl"
          data-testid="new-session"
          title="Start another session in this project, on its own defaults"
          :disabled="projects.starting"
          @click="startAnother()"
        >
          + Session
        </button>
        <button
          class="ctl"
          data-testid="open-flow"
          title="Take an Azure DevOps feature from scoping to pull requests"
          @click="emit('open-flow')"
        >
          Flow
        </button>
        <button
          v-if="liveSession?.status === 'working'"
          class="stop-btn"
          data-testid="stop-session"
          aria-label="Interrupt the current turn"
          title="Interrupt the current turn (Ctrl+C)"
          @click="interrupt()"
        >
          <span class="stop-block" aria-hidden="true"></span>
        </button>
        <button
          v-if="liveSession"
          class="ctl"
          data-testid="end-session"
          title="End the session (resumable later)"
          :disabled="ending"
          @click="stop()"
        >
          {{ ending ? 'Ending…' : 'End session' }}
        </button>
        <SessionWaitOverlay
          v-if="ending"
          testid="ending-overlay"
          :title="`Ending ${project.name}…`"
          sub="Draining the session and tearing its container down."
          ring-testid="ending-bar"
        />
      </div>
      <div class="head-meta">
        <div class="name-block ui-chip">
          <span class="name-cap" aria-hidden="true">session</span>
          <input
            v-if="nameDraft !== null"
            ref="nameInputEl"
            v-model="nameDraft"
            class="name-input"
            data-testid="session-name-input"
            maxlength="60"
            placeholder="Name this session"
            @keydown.enter="saveName()"
            @keydown.esc="nameDraft = null"
            @blur="saveName()"
          />
          <button
            v-else-if="liveSession || endedSession"
            class="name-btn"
            data-testid="session-name"
            title="Name this session"
            @click="openNameEdit()"
          >
            {{ (liveSession ?? endedSession)?.name ?? 'Name this session' }}
          </button>
        </div>
        <div class="run-block ui-chip">
          <span class="run-cap" aria-hidden="true">run</span>
          <label class="wsl-check" data-testid="project-containers">
            <input
              type="checkbox"
              data-testid="project-containers-input"
              :checked="project.useContainers"
              :title="
                project.useContainers
                  ? 'This project runs its work inside WSL containers: the project folder is mounted read-write, and your Claude credentials, plugins and skills read-only. Nothing else of yours is. Slower to start, and only two containers may run at once machine-wide.'
                  : 'This project runs its work on this machine. Tick to run it inside WSL containers instead: isolated from the rest of your drive, slower to start, two at a time. Needs WSL 2.9.3 or newer.'
              "
              @change="onContainersToggle"
            />
            Run in Container
          </label>
        </div>
        <span style="white-space: nowrap"><Icon name="branch" :size="12" /> <span class="mono">{{ liveSession?.branch ?? endedSession?.branch ?? '—' }}</span></span>
        <span
          v-if="currentModelLabel"
          data-testid="session-model"
          style="color: var(--text-faint); white-space: nowrap"
        >
          {{ currentModelLabel }}
        </span>
        <span
          v-if="liveSession?.currentMode"
          class="ui-chip"
          data-testid="session-mode"
          :title="
            liveSession.currentMode === 'advisor'
              ? 'Advisor mode: cheap model executing, strong model consulted at decision points'
              : 'Orchestrator mode: strong model planning, cheap workers executing in parallel'
          "
        >
          <Icon :name="liveSession.currentMode === 'advisor' ? 'scales' : 'layers'" :size="12" />
          {{ liveSession.currentMode === 'advisor' ? 'Advisor' : 'Orchestrator' }}
        </span>
        <span
          v-if="liveSession && liveSession.diffAdds != null"
          data-testid="diff-stats"
          class="mono"
          style="white-space: nowrap"
        >
          <span style="color: var(--green)">+{{ liveSession.diffAdds }}</span>
          <span style="color: var(--red)"> −{{ liveSession.diffDels ?? 0 }}</span>
        </span>
        <span
          v-if="sessionTimer && showTimer"
          style="color: var(--text-faint); white-space: nowrap"
        >
          session <span class="mono" style="color: var(--text-meta)">{{ sessionTimer }}</span>
        </span>
        <span
          v-if="cacheHitPct != null"
          data-testid="session-cache"
          style="color: var(--text-faint); white-space: nowrap"
          title="Prompt-cache hit rate for the latest turn (cached prefix reused vs. re-billed)"
        >
          cache
          <span class="mono" :style="{ color: cacheColor }">{{ cacheHitPct }}%</span>
        </span>
        <button
          v-if="sessionUsage"
          class="usage-widget ui-chip"
          data-testid="session-model-usage"
          title="Session usage by model — click for the full /usage picture"
          @click="openFullUsage()"
        >
          <span class="uw-total">{{ fmtTok(sessionUsage.total) }} tok</span>
          <span v-if="sessionUsage.cost > 0" class="uw-cost">${{ sessionUsage.cost.toFixed(2) }}</span>
          <span v-for="m in sessionUsage.top" :key="m.id" class="uw-model">
            {{ m.label }} <span class="uw-model-tok">{{ fmtTok(m.tokens) }}</span>
          </span>
        </button>
        <span
          v-if="sessionStamp"
          class="head-stamp"
          data-testid="session-stamp"
          :title="sessionStamp.full"
        >
          #{{ sessionStamp.short }}
        </span>
      </div>
    </header>

    <div v-if="dragKind" class="drop-overlay overlay" data-testid="drop-overlay">
      <div class="drop-box dialog">
        <div class="drop-title">
          <template v-if="dragKind === 'project'"><Icon name="external" :size="14" /> Reference this project</template>
          <template v-else>@ Reference file path</template>
        </div>
        <div class="drop-sub">
          {{
            dragKind === 'project'
              ? `Drop to let ${project.name} read it for context`
              : `Drop to insert its path into the prompt for ${project.name}`
          }}
        </div>
      </div>
    </div>

    <div v-if="!active.fullScreenSection" class="main-tabs ui-tabs">
      <button
        class="ui-tab"
        :class="{ sel: mainTab === 'session' || mainTab === 'terminal', 'is-selected': mainTab === 'session' || mainTab === 'terminal' }"
        data-testid="tab-session"
        @click="mainTab = 'session'"
      >
        Session
      </button>
      <button class="ui-tab" :class="{ sel: mainTab === 'specs', 'is-selected': mainTab === 'specs' }" data-testid="tab-specs" @click="mainTab = 'specs'">
        Specs
        <span v-if="specCount > 0" class="mt-badge">{{ specCount }}</span>
      </button>
      <button
        class="ui-tab"
        :class="{ sel: mainTab === 'tests', 'is-selected': mainTab === 'tests' }"
        data-testid="tab-tests"
        @click="mainTab = 'tests'"
      >
        Tests
      </button>
      <button class="ui-tab" :class="{ sel: mainTab === 'diff', 'is-selected': mainTab === 'diff' }" data-testid="tab-diff" @click="mainTab = 'diff'">
        Diff
        <span v-if="diffCount > 0" class="mt-badge">{{ diffCount }}</span>
      </button>
      <button
        class="ui-tab"
        :class="{ sel: mainTab === 'cleanup', 'is-selected': mainTab === 'cleanup' }"
        data-testid="tab-cleanup"
        @click="mainTab = 'cleanup'"
      >
        Cleanup
      </button>
      <button
        class="ui-tab"
        :class="{ sel: mainTab === 'diagrams', 'is-selected': mainTab === 'diagrams' }"
        data-testid="tab-diagrams"
        @click="mainTab = 'diagrams'"
      >
        Diagrams
      </button>
      <button
        class="ui-tab"
        :class="{ sel: mainTab === 'skills', 'is-selected': mainTab === 'skills' }"
        data-testid="tab-skills"
        @click="mainTab = 'skills'"
      >
        Skills
      </button>
    </div>
    <div v-if="!active.fullScreenSection && (mainTab === 'session' || mainTab === 'terminal')" class="view-toolbar ui-toolbar">
      <span class="view-label">Workspace</span>
      <div
        class="segments view-segments ui-segments"
        data-testid="view-toggle"
        role="tablist"
        aria-label="Stream view"
        @keydown="onViewKeydown"
      >
        <button
          type="button"
          class="seg ui-seg"
          :class="{ on: mainTab === 'session' && active.view === 'clean', 'is-on': mainTab === 'session' && active.view === 'clean' }"
          data-testid="view-clean"
          role="tab"
          :aria-selected="mainTab === 'session' && active.view === 'clean'"
          :tabindex="mainTab === 'session' && active.view === 'clean' ? 0 : -1"
          @click="switchView('clean')"
        >
          Clean
        </button>
        <button
          type="button"
          class="seg ui-seg"
          :class="{ on: mainTab === 'session' && active.view === 'raw', 'is-on': mainTab === 'session' && active.view === 'raw' }"
          data-testid="view-raw"
          role="tab"
          :aria-selected="mainTab === 'session' && active.view === 'raw'"
          :tabindex="mainTab === 'session' && active.view === 'raw' ? 0 : -1"
          @click="switchView('raw')"
        >
          Raw
        </button>
        <button
          type="button"
          class="seg ui-seg"
          :class="{ on: mainTab === 'terminal', 'is-on': mainTab === 'terminal' }"
          data-testid="tab-terminal"
          role="tab"
          :aria-selected="mainTab === 'terminal'"
          :tabindex="mainTab === 'terminal' ? 0 : -1"
          @click="openTerminal()"
        >
          <Icon name="terminal" :size="13" /> Terminal
        </button>
      </div>
    </div>

    <ConversationTerminal
      v-if="terminalEverOpened"
      v-show="mainTab === 'terminal' && terminalMode === 'chat'"
      ref="convTerm"
      :lines="rawLines"
      :session-key="terminalSession?.id ?? project.id"
      :live="!!liveSession"
      :visible="mainTab === 'terminal' && terminalMode === 'chat'"
      :sending="busy"
      @send="sendFromTerminal"
      @interrupt="interrupt()"
      @shell="openShell()"
    />
    <TerminalPane
      v-if="shellEverOpened"
      v-show="mainTab === 'terminal' && terminalMode === 'shell'"
      :id="terminalSession?.id ?? project.id"
      :cwd="project.path"
      :engine="terminalSession?.engine ?? startEngine"
      :resume-session-id="terminalResumeId"
      :live="!!liveSession"
      :visible="mainTab === 'terminal' && terminalMode === 'shell'"
      @takeover="stop()"
      @chat="terminalMode = 'chat'"
    />

    <SpecsView
      v-if="mainTab === 'specs'"
      :project-id="project.id"
      @set-target="onSetTarget"
      @ran="onRanInSection"
    />
    <TestsView
      v-else-if="mainTab === 'tests'"
      :project-id="project.id"
      :project-name="project.name"
      :branch="liveSession?.branch ?? endedSession?.branch ?? null"
    />
    <DiffView v-else-if="mainTab === 'diff'" :project-id="project.id" />
    <CleanupView
      v-else-if="mainTab === 'cleanup'"
      :project-name="project.name"
      :available="availableCommandNames"
      :session-id="sectionSessionIds.cleanup ?? null"
      :installing="installing !== null"
      :install-error="installError"
      @run="(text: string) => runPluginCommand(text, 'cleanup')"
      @install="installCleanup"
    />
    <DiagramsView
      v-else-if="mainTab === 'diagrams'"
      :project-id="project.id"
      :available="availableCommandNames"
      :session-id="sectionSessionIds.diagram ?? null"
      :installing="installing === DIAGRAM_PLUGIN.pkg"
      :install-error="installError"
      @install="installDiagramPlugin"
      @run="runDiagramCommand"
    />
    <SkillsView
      v-else-if="mainTab === 'skills'"
      :project-id="project.id"
      :project-name="project.name"
      :session-id="sectionSessionIds.skills ?? null"
      @ran="(id: string) => (sectionSessionIds = { ...sectionSessionIds, skills: id })"
      @manage="emit('open-settings', 'skills')"
    />
    <div
      v-else-if="mainTab === 'session' && (active.view === 'clean' || selectedAgent)"
      ref="streamEl"
      class="stream"
      data-testid="stream"
      :style="{ zoom: streamZoom }"
      @scroll.passive="onStreamScroll"
    >

      <div class="stream-inner">
        <div v-if="selectedAgent" class="agent-banner" data-testid="agent-banner">
          <button
            type="button"
            class="ab-back"
            data-testid="agent-back"
            :aria-label="`Back to ${project.name}`"
            @click="active.selectAgent(null)"
          >
            <Icon name="arrow-left" :size="12" /> {{ project.name }}
          </button>
          <span class="ab-sep">│</span>
          <span class="ab-dot"><Icon name="dot" :size="8" /></span>
          <span class="ab-name">{{ selectedAgent.task || selectedAgent.name }}</span>
          <span class="ab-chip ui-chip">subagent</span>
          <span class="spacer"></span>
        </div>

        <div v-if="!liveSession && !endedSession" class="stream-empty">
          <div class="faint" data-testid="no-session-hint">
            No session yet — press + in the sidebar and point New session at this folder.
          </div>
        </div>

        <div v-if="endedSession" class="ended ui-card" data-testid="ended-banner">
          <div class="ended-line">
            Session ended <span class="faint">({{ endedSession.endReason ?? 'unknown' }})</span>
            <span v-if="endedSession.statusDetail" class="faint"> — {{ endedSession.statusDetail }}</span>
          </div>
          <div class="ended-actions">
            <div
              class="segments"
              data-testid="start-engine"
              role="radiogroup"
              aria-label="Engine"
            >
              <button
                type="button"
                class="seg"
                :class="{ on: startEngine === 'claude' }"
                data-testid="start-engine-claude"
                role="radio"
                :aria-checked="startEngine === 'claude'"
                :disabled="busy"
                title="Claude Code: the permission inbox, plan mode, containers and subagent pairing."
                @click="startEngine = 'claude'"
              >
                Claude
              </button>
              <button
                type="button"
                class="seg"
                :class="{ on: startEngine === 'codex' }"
                data-testid="start-engine-codex"
                role="radio"
                :aria-checked="startEngine === 'codex'"
                :disabled="busy"
                title="OpenAI Codex CLI. No permission inbox, no plan mode and no container — Codex decides inside its own sandbox, and the mode below chooses which sandbox."
                @click="startEngine = 'codex'"
              >
                Codex
              </button>
            </div>

            <div class="mode-pick">
              <button
                type="button"
                class="mode-dd"
                :class="{ armed: startMode === 'bypass' }"
                data-testid="start-mode-picker"
                :aria-expanded="modeOpen"
                aria-haspopup="listbox"
                :title="startModeDetail"
                :disabled="busy"
                @click="modeOpen = !modeOpen"
              >
                <span class="mode-dd-eyebrow">Mode</span>
                <span class="mode-dd-name">{{ startModeLabel }}</span>
                <span class="mode-dd-arrow" aria-hidden="true">
                  <Icon :name="modeOpen ? 'chevron-up' : 'chevron-down'" :size="10" />
                </span>
              </button>
              <div v-if="modeOpen" class="mode-list" role="listbox" data-testid="start-mode-list">
                <button
                  v-for="m in modeChoices"
                  :key="m.value"
                  type="button"
                  class="mode-item"
                  :class="{ sel: m.value === startMode, armed: m.value === 'bypass' }"
                  role="option"
                  :aria-selected="m.value === startMode"
                  :data-testid="`start-mode-${m.value}`"
                  :title="m.detail"
                  @click="((startMode = m.value), (modeOpen = false))"
                >
                  <span class="mode-item-name">{{ m.label }}</span>
                  <span class="mode-item-detail">{{ m.detail }}</span>
                </button>
                <div v-if="resumeSession" class="mode-note">
                  Resuming keeps the last session's sandbox: its transcript lives
                  {{ endedSession.bypassPermissions ? 'inside the container' : 'on this machine' }},
                  so only matching modes are offered.
                </div>
              </div>
            </div>

            <span class="bypass-inline">
              <button
                class="switch"
                :class="{ on: resumeSession }"
                data-testid="resume-session"
                role="switch"
                :aria-checked="resumeSession"
                :disabled="!canResume"
                :title="
                  canResume
                    ? 'Carry on the conversation that just ended: the new session opens with the previous one\'s context, so you can pick up mid-thought instead of re-explaining. Off starts an empty session in the same folder.'
                    : 'Nothing to resume — this session never reached the point of having a conversation to carry on.'
                "
                @click="canResume && (resumeSession = !resumeSession)"
              >
                <span class="knob"></span>
              </button>
              <span :class="{ faint: !canResume }">Resume session</span>
            </span>

            <span v-if="startEngine === 'claude'" class="bypass-inline">
              <button
                class="switch"
                :class="{ on: containerOn }"
                data-testid="run-in-container"
                role="switch"
                :aria-checked="containerOn"
                :disabled="containerForced"
                :title="
                  containerForced
                    ? 'Bypass always runs in a container: it approves every tool call, so the container is the only thing left standing between it and your files.'
                    : 'The same setting as the WSL box in the header, for the whole project: every session and every section run goes into a WSL container. Your project folder is mounted read-write, and your Claude credentials, plugins and skills read-only. Nothing else of yours is. Slower to start, only two containers at once, and it needs WSL 2.9.3 or newer.'
                "
                @click="containerForced || (runInContainer = !runInContainer)"
              >
                <span class="knob"></span>
              </button>
              <span :class="{ faint: containerForced }">Use WSL containers</span>
            </span>

            <button class="btn-solid" data-testid="start-session" :disabled="busy" @click="start()">
              {{ resumeSession ? 'Resume' : 'Start session' }}
            </button>
          </div>
          <div
            v-if="startMode === 'bypass'"
            class="bypass-warn"
            data-testid="bypass-warning"
          >
            <Icon name="warning" :size="12" /> Nothing will ask for approval — only use this in throwaway or fully trusted folders.
          </div>
          <div v-if="startError" class="ui-err" data-testid="start-error">
            <Icon name="cross" :size="12" /> {{ startError }}
          </div>
        </div>

        <button
          v-if="renderStart > 0 || deriveWindow < active.events.length || active.hasMoreHistory"
          type="button"
          class="load-earlier"
          data-testid="show-earlier"
          @click="showEarlier()"
        >
          <Icon name="chevron-up" :size="11" /> show earlier activity
        </button>

        <template
          v-for="item in visibleItems"
          :key="item.type === 'event' ? item.event.id : item.key"
        >
          <SwallowedBlock
            v-if="item.type === 'block'"
            :events="item.events"
            :noise-kind="item.noiseKind"
            @open-raw="active.setView('raw')"
          />
          <QuestionEvent
            v-else-if="item.event.kind === 'question'"
            :event-id="item.event.id"
            :payload="item.event.payload as never"
            @answer="answerQuestion"
          />
          <StreamEvent
            v-else
            :event="item.event"
            :stamps="outputPrefs.timestamps"
            @open-inbox="openInbox"
            @edit-queued="editQueued"
          />
        </template>

        <QuestionEvent
          v-if="inlineQuestion"
          :event-id="inlineQuestion.eventId"
          :payload="inlineQuestion.payload"
          data-testid="inline-question"
          @answer="onInlineAnswer"
        />

        <div v-if="selectedAgent" class="live" data-testid="live-line">
          <span class="blink" style="color: var(--green)">▊</span>
          {{ selectedAgent.task || selectedAgent.label }}
        </div>

        <div v-else-if="workingAgents.length > 1" class="agents ui-card is-warn" data-testid="agent-list">
          <div class="agents-head">
            <span class="agents-label"><Icon name="fork" :size="12" /> AGENTS</span>
            <span class="agents-count">{{ workingAgents.length }} working in parallel</span>
            <span class="spacer"></span>
            <button
              v-if="workingAgents.length > SHOW_LIMIT"
              class="agents-toggle"
              data-testid="agents-toggle"
              @click="agentsExpanded = !agentsExpanded"
            >
              {{ agentsExpanded ? 'show fewer' : `show all ${workingAgents.length}` }}
            </button>
          </div>
          <div class="agents-rows">
            <button
              v-for="agent in shownAgents"
              :key="agent.id"
              type="button"
              class="agent-row ui-row"
              data-testid="agent-row"
              :aria-label="`Open ${agent.name}'s chat`"
              @click="active.selectAgent(agent.id)"
            >
              <span class="agent-dot"><Icon name="dot" :size="8" /></span>
              <span class="agent-name">{{ agent.name }}</span>
              <span class="agent-task">{{ agent.task || agent.label }}</span>
              <span class="agent-chat">chat <Icon name="arrow-right" :size="11" /></span>
            </button>
            <div
              v-if="!agentsExpanded && workingAgents.length > SHOW_LIMIT"
              class="agents-more"
              data-testid="agents-more"
              role="button"
              tabindex="0"
              @click="agentsExpanded = true"
              @keydown.enter="agentsExpanded = true"
              @keydown.space.prevent="agentsExpanded = true"
            >
              <Icon name="plus" :size="11" /> {{ workingAgents.length - SHOW_LIMIT }} more
            </div>
          </div>
        </div>

        <div
          v-else-if="liveSession?.status === 'working'"
          class="live"
          data-testid="live-line"
          role="status"
        >
          <span class="blink" style="color: var(--green)" aria-hidden="true">▊</span>
          {{ liveSession.statusDetail || 'Working…' }}
        </div>
        <div
          v-else-if="liveSession?.status === 'needs_you'"
          class="live live-blocked"
          data-testid="live-line"
          role="alert"
        >
          <span class="blink" aria-hidden="true">▊</span>
          Blocked — {{ pendingCount > 0 ? `${pendingCount} pending` : 'needs your answer' }}
        </div>

        <div
          v-if="backgroundTasks.length > 0"
          class="agents bg-tasks ui-card is-danger"
          data-testid="bg-task-list"
        >
          <div class="agents-head">
            <span class="agents-label bg"><Icon name="clock" :size="12" /> BACKGROUND</span>
            <span class="agents-count">{{ backgroundTasks.length }} running</span>
            <span class="spacer"></span>
            <button
              v-if="backgroundTasks.length > SHOW_LIMIT"
              class="agents-toggle"
              data-testid="bg-task-toggle"
              @click="tasksExpanded = !tasksExpanded"
            >
              {{ tasksExpanded ? 'show fewer' : `show all ${backgroundTasks.length}` }}
            </button>
            <button
              class="agents-toggle"
              data-testid="bg-task-clear"
              title="Forget these tasks. Use it when the work has clearly finished but the session still lists it: the session can then finish, and its planned queue can run. Work that is genuinely running reappears the moment the CLI next reports."
              @click="active.clearBackgroundTasks()"
            >
              clear
            </button>
          </div>
          <div class="agents-rows">
            <div
              v-for="task in shownTasks"
              :key="task.taskId"
              class="agent-row bg-row ui-row"
              data-testid="bg-task-row"
            >
              <span class="agent-dot bg"><Icon name="clock" :size="8" /></span>
              <span class="agent-task">{{ task.description || task.taskId }}</span>
            </div>
            <div
              v-if="!tasksExpanded && backgroundTasks.length > SHOW_LIMIT"
              class="agents-more"
              data-testid="bg-task-more"
              role="button"
              tabindex="0"
              @click="tasksExpanded = true"
              @keydown.enter="tasksExpanded = true"
              @keydown.space.prevent="tasksExpanded = true"
            >
              <Icon name="plus" :size="11" /> {{ backgroundTasks.length - SHOW_LIMIT }} more
            </div>
          </div>
        </div>
      </div>

    </div>

    <div v-else-if="mainTab === 'session'" ref="streamEl" class="raw-view" data-testid="stream" :style="{ zoom: streamZoom }" @scroll.passive="onStreamScroll">
      <div
        v-for="line in rawLines"
        :key="line.key"
        class="raw-line mono"
        :class="[`t-${line.tone}`, { stamped: outputPrefs.timestamps }]"
        data-testid="raw-line"
      >
        <span v-if="outputPrefs.timestamps" class="raw-stamp" data-testid="raw-stamp">{{ line.stamp }}</span>
        <span>{{ line.text }}</span>
      </div>
      <div v-if="liveSession?.status === 'working'" class="raw-line mono term-caret" data-testid="term-caret">
        <span class="blink">█</span>
      </div>
    </div>

        <footer
          v-if="mainTab === 'session' || editTarget"
          class="composer"
          :class="{ dead: composerDead, term: mainTab === 'session' && active.view === 'raw' }"
          :data-testid="composerDead ? 'composer-dead' : 'composer-live'"
        >
      <button
        v-if="!atBottom"
        type="button"
        class="to-bottom"
        data-testid="scroll-to-bottom"
        title="Jump to the newest line"
        aria-label="Jump to the newest line"
        @click="scrollToBottom()"
      >
        <Icon name="arrow-down" :size="14" />
      </button>
      <div class="refs-row" data-testid="refs-row">
        <span class="refs-label">REFS</span>
        <span
          v-for="r in project.refs"
          :key="r.path"
          class="ref-chip ui-chip"
          :title="r.path"
          :data-testid="`ref-chip-${r.label}`"
        >
          <span class="ref-ico"><Icon name="external" :size="12" /></span>
          <span class="ref-name mono">{{ r.label }}</span>
          <button
            class="ref-x"
            :data-testid="`ref-remove-${r.label}`"
            :aria-label="`Remove reference ${r.label}`"
            @click="removeRef(r.path)"
          >
            <Icon name="close" :size="11" />
          </button>
        </span>
        <input
          v-if="addingRef"
          v-model="refInput"
          class="ref-input"
          data-testid="ref-input"
          autofocus
          placeholder="~/path/to/folder or a project name — Enter to add"
          @keydown.enter="commitRef"
          @keydown.esc="cancelRef"
          @blur="cancelRef"
        />
        <button
          v-else
          class="ref-add"
          data-testid="ref-add"
          title="Give this session read access to another folder or project — or drag a project from the sidebar onto this view"
          @click="addingRef = true"
        >
          <Icon name="plus" :size="11" /> reference
        </button>
        <span v-if="refError" class="ref-error" data-testid="ref-error">{{ refError }}</span>
      </div>
      <div v-if="queuedTasks.length > 0" class="queue" data-testid="task-queue">
        <span class="queue-label">UP NEXT</span>
        <span
          v-for="(task, index) in queuedTasks"
          :key="task.id"
          class="queue-chip"
          :data-testid="`queue-item-${index}`"
        >
          <span class="queue-num">{{ index + 1 }}</span>
          <input
            v-if="editingQueued === task.id"
            v-model="queuedDraft"
            class="queue-edit"
            :data-testid="`queue-edit-${index}`"
            :aria-label="`Edit queued task ${index + 1}`"
            @keydown.enter.prevent="saveQueued()"
            @keydown.esc.prevent="cancelEditQueued()"
            @blur="saveQueued()"
          />
          <button
            v-else
            type="button"
            class="queue-text"
            :data-testid="`queue-text-${index}`"
            title="Click to edit this task"
            @click="beginEditQueued(task)"
          >
            {{ task.text }}
          </button>
          <button
            class="queue-x"
            :data-testid="`queue-remove-${index}`"
            title="Remove from the queue"
            @click="removeQueued(task.id)"
          >
            <Icon name="close" :size="11" />
          </button>
        </span>
        <span class="queue-note">Runs automatically when the current goal finishes</span>
      </div>
      <div v-if="queuedEditError" class="queued-edit-error" data-testid="queued-edit-error">
        {{ queuedEditError }}
      </div>
      <div v-if="restoredDraft !== null && composer === restoredDraft" class="draft-float" data-testid="draft-note">
        Restored draft from the previous run — send to deliver it.
      </div>

      <div v-if="stopConfirm" class="stop-confirm" data-testid="stop-confirm">
        <span class="sc-text"><Icon name="stop" :size="12" /> Ctrl+C again to stop the chat — are you sure?</span>
        <button class="sc-stop" data-testid="stop-confirm-yes" @click="confirmStop()">Stop</button>
        <button class="sc-cancel" data-testid="stop-confirm-no" @click="cancelStop()">Cancel</button>
      </div>

      <div class="composer-row">
        <span v-if="editTarget" class="caret target mono"><Icon name="pencil" :size="12" /></span>
        <span v-else class="caret mono"><Icon name="chevron-right" :size="14" /></span>
        <span
          v-if="editTarget"
          class="target-chip ui-chip is-on"
          data-testid="composer-target"
          title="Spec edit target — your message rewrites this file"
        >
          <Icon name="arrow-right" :size="11" /> <span class="mono">{{ editTarget }}</span>
          <button
            class="target-x"
            data-testid="composer-target-clear"
            aria-label="Clear spec edit target"
            @click="editTarget = null"
          >
            <Icon name="close" :size="11" />
          </button>
        </span>
        <div class="input-wrap">
          <div
            v-if="suggestions.length > 0"
            class="suggest-list mono"
            data-testid="suggest-list"
            role="listbox"
            aria-label="Commands"
          >
            <div v-for="group in suggestGroups" :key="group.label" class="suggest-group">
              <div class="suggest-label">{{ group.label }}</div>
              <div
                v-for="row in group.items"
                :id="`suggest-opt-${row.index}`"
                :key="row.cmd"
                class="suggest-item"
                :class="{ active: row.index === suggestIndex }"
                :data-testid="`suggest-item-${row.index}`"
                role="option"
                :aria-selected="row.index === suggestIndex"
                @mousedown.prevent="acceptSuggestion(row.cmd)"
                @mouseenter="suggestIndex = row.index"
              >
                <span class="suggest-typed"
                  >{{ matchParts(row.cmd).before
                  }}<span class="suggest-hit">{{ matchParts(row.cmd).hit }}</span
                  >{{ matchParts(row.cmd).after }}</span
                >
                <span v-if="hintFor(row.cmd)" class="suggest-desc">{{ hintFor(row.cmd) }}</span>
              </div>
            </div>
          </div>
          <div class="ghost mono" aria-hidden="true">
            <template v-if="isCommandMatch"
              ><span class="ghost-cmd">{{ commandParts.cmd }}</span
              ><span class="ghost-args">{{ commandParts.rest }}</span></template
            ><span v-else class="ghost-typed">{{ composer }}</span
            ><span class="ghost-rest" data-testid="ghost-suggestion">{{ ghostRest }}</span>
          </div>
          <textarea
            ref="composerEl"
            v-model="composer"
            class="composer-input mono"
            :class="{ 'is-command': isCommandMatch }"
            data-testid="composer-input"
            rows="1"
            :placeholder="composerPlaceholder"
            :disabled="composerDead"
            spellcheck="false"
            autocomplete="off"
            @input="onComposerInput"
            @keydown="onComposerKeydown"
            @scroll="onComposerScroll"
          ></textarea>
        </div>
        <span class="to-inline" data-testid="composer-to">to {{ sendTo }}</span>
        <button
          v-if="!editTarget"
          class="queue-btn"
          data-testid="composer-queue"
          title="Add to the queue — runs after the current goal finishes"
          :disabled="composerEmpty"
          @click="enqueue()"
        >
          <Icon name="plus" :size="11" /> Queue
        </button>
        <button
          class="send-btn"
          data-testid="composer-send"
          :disabled="composerDead || busy || composerEmpty"
          @click="send()"
        >
          Send <Icon name="send" :size="12" />
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.draft-float {
  margin-bottom: 5px;
  padding: 4px 8px;
  font-size: var(--fs-micro);
  color: var(--amber);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  box-shadow: var(--shadow-dd);
}

.to-inline {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
}

.session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  position: relative; 
}


.session-view.is-ended .raw-view {
  opacity: 0.7;
  filter: saturate(0.4);
}

.session-view.is-ended .stream-inner > *:not(.ended):not(.load-earlier) {
  opacity: 0.7;
}

.session-view.is-ended .stream-inner:hover > *:not(.ended),
.session-view.is-ended .stream-inner:focus-within > *:not(.ended) {
  opacity: 1;
}

.session-view.is-ended .stream-inner > .ended {
  position: sticky;
  top: 0;
  z-index: 2;
  border-color: var(--border-strong);
}

.session-view.is-ended
  .stream-inner:not(:hover):not(:focus-within)
  > *:not(.ended):not(.load-earlier) {
  --green: var(--text-mid);
  --green-hover: var(--text-strong);
  --green2: var(--text-mid);
  --running: var(--text-mid);
  --amber: var(--text-meta);
  --amber-hover: var(--text-mid);
  --idle: var(--text-meta);
  --blue: var(--text-meta);
  --red: var(--text-mid);
  --red-hover: var(--text-strong);
  --teal: var(--text-meta);
  --purple: var(--text-meta);
}


.head {
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
}

.main-tabs {
  padding: 0 20px;
  flex-shrink: 0;
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
  min-width: 0;
}

.view-toolbar {
  flex-shrink: 0;
  justify-content: space-between;
  margin-bottom: 0;
  padding: 10px 24px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg);
}

.view-label {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  font-weight: 500;
}

.segments.view-segments.ui-segments {
  padding: 3px;
  gap: 3px;
  background: var(--bg-panel);
  border-color: var(--border-soft);
  border-radius: var(--rc);
}

.view-segments .ui-seg.on {
  background: color-mix(in srgb, var(--green) 12%, var(--bg-panel));
  color: var(--green);
}

.mt-badge {
  font-size: var(--fs-micro);
  color: var(--text-meta);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  border-radius: var(--rp);
  padding: 0 6px;
  line-height: 15px;
}

.head-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.h-dot {
  width: 10px;
  min-width: 10px;
  height: 10px;
}

.h-name {
  font-size: var(--fs-head);
  font-weight: var(--w-em);
  color: var(--text-bright);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.h-path {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex-shrink: 6;
}

.segments {
  display: flex;
  flex-shrink: 0;
  white-space: nowrap;
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  overflow: hidden;
  font-size: var(--fs-ui);
  margin: auto 0 auto auto;
}

.seg {
  padding: 4px 12px;
  line-height: 15px;
  font-weight: var(--w-em);
  color: var(--text-tab);
  cursor: pointer;
}

.seg:hover {
  color: var(--text-body);
}

.seg.on {
  background: var(--bg-active);
  color: var(--text-strong);
  font-weight: var(--w-em);
  cursor: default;
}

.ctl {
  flex-shrink: 0;
  font-size: var(--fs-ui);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 3px 9px;
}

.ctl:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.ctl:disabled {
  opacity: 0.7;
  cursor: default;
}

.wsl-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 9px;
  font-size: var(--fs-ui);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  cursor: pointer;
  user-select: none;
}

.wsl-check:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.wsl-check input {
  accent-color: var(--green);
  cursor: pointer;
  margin: 0;
}

.wsl-check:has(input:checked) {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 8%, transparent);
  border-color: color-mix(in srgb, var(--green) 45%, transparent);
}

.name-btn {
  font-family: var(--sans);
  font-size: var(--fs-meta);
  color: var(--text-body);
  border-bottom: 1px dashed transparent;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.name-btn:hover {
  color: var(--text-strong);
  border-bottom-color: var(--border-strong);
}

.name-input {
  font-family: var(--sans);
  font-size: var(--fs-meta);
  color: var(--text-strong);
  background: var(--bg-panel);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 1px 6px;
  width: 220px;
}

.name-input:focus {
  outline: none;
  border-color: var(--blue);
}

.stop-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--red);
  border: 1px solid var(--red);
  border-radius: var(--rp);
  cursor: pointer;
}

.stop-btn:hover {
  color: var(--red-ink);
  background: var(--red);
}

.stop-block {
  width: 9px;
  height: 9px;
  background: currentColor;
}


.pill.fanout-pill {
  color: var(--purple);
  border: 1px solid color-mix(in srgb, var(--purple) 30%, transparent);
  background: color-mix(in srgb, var(--purple) 10%, transparent);
}

.pill.agents-pill {
  color: var(--blue);
  border: 1px solid color-mix(in srgb, var(--blue) 30%, transparent);
}

.pill.bg-pill {
  color: var(--amber);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
}

.pill.bypass-pill {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
}

.pill.plan-pill {
  cursor: pointer;
  color: var(--text-tab);
  border: 1px solid var(--border-strong);
}

.pill.plan-pill:hover {
  color: var(--text-strong);
}

.pill.plan-pill.on {
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 9%, transparent);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
}

.pill.nogit-pill {
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
}

.refs-row {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 18px 10px;
  flex-wrap: wrap;
  pointer-events: none;
}

.refs-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.ref-chip {
  box-shadow: var(--elev);
  pointer-events: auto;
}

.ref-ico {
  color: var(--green);
}

.ref-x {
  color: var(--text-faint);
  font-size: var(--fs-micro);
  padding: 0 1px;
}

.ref-x:hover {
  color: var(--red);
}

.ref-add {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  padding: 2px 10px;
  background: var(--bg-panel);
  box-shadow: var(--elev);
  pointer-events: auto;
}

.ref-add:hover {
  color: var(--green);
  border-color: var(--green);
}

.ref-input {
  width: 300px;
  font-size: var(--fs-meta);
  background: var(--bg);
  border: 1px solid var(--green);
  border-radius: var(--rc);
  outline: none;
  color: var(--text-strong);
  padding: 3px 9px;
  font-family: var(--sans);
  pointer-events: auto;
}

.ref-error {
  font-size: var(--fs-micro);
  color: var(--red);
  pointer-events: auto;
}

.drop-overlay {
  position: absolute;
  inset: 8px;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--surface-sunken) 88%, transparent);
  pointer-events: none;
}

.drop-box {
  text-align: center;
  border: 1px dashed var(--green);
}

.drop-title {
  font-size: var(--fs-body);
  color: var(--green);
}

.drop-sub {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  margin-top: 6px;
}

.head-meta {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  margin-top: 7px;
  font-size: var(--fs-meta);
  color: var(--text-meta);
  flex-wrap: wrap;
}

.head-stamp {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  white-space: nowrap;
}

.usage-widget {
  gap: 9px;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.uw-total {
  color: var(--text-body);
  font-weight: var(--w-em);
  font-family: var(--mono);
}

.uw-cost {
  color: var(--text-faint);
  font-family: var(--mono);
}

.uw-model {
  color: var(--text-tab);
}

.uw-model-tok {
  color: var(--green);
  font-family: var(--mono);
}

.stream-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 80px;
}


.stream-inner > .ended {
  margin-bottom: 13px;
}

.ended-actions {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 12px;
  align-items: center;
  margin-top: 10px;
}

.ended-actions .mode-pick {
  grid-column: 1;
  grid-row: 1;
}

.ended-actions .btn-solid {
  grid-column: 2;
  grid-row: 1;
}

.bypass-inline {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: row-reverse;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.ended-actions .bypass-inline:nth-of-type(1) {
  grid-row: 2;
  margin-top: 14px;
  border-radius: var(--rc) var(--rc) 0 0;
}

.ended-actions .bypass-inline:nth-of-type(2) {
  grid-row: 3;
  border-top: none;
  border-radius: 0 0 var(--rc) var(--rc);
}

.bypass-inline .switch {
  background: var(--bg-seg);
  border: 1px solid var(--border-strong);
}

.bypass-inline .switch .knob {
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  background: var(--text-mid);
}

.bypass-inline .switch.on {
  background: var(--green);
  border-color: var(--green);
}

.bypass-inline .switch.on .knob {
  left: auto;
  right: 2px;
  background: var(--green-ink);
}

.bypass-inline .switch:disabled {
  opacity: 0.45;
  cursor: default;
}

.bypass-inline .switch:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: 2px;
}

.mode-pick {
  position: relative;
}

.mode-dd {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 9px;
  background: var(--bg-seg);
  border: 1px solid var(--border-seg);
  border-radius: var(--rc);
  cursor: pointer;
  color: var(--text-body);
}

.mode-dd:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.mode-dd:disabled {
  opacity: 0.6;
  cursor: default;
}

.mode-dd.armed .mode-dd-name {
  color: var(--red);
}

.mode-dd-eyebrow {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: var(--track-label);
  color: var(--text-ghost);
}

.mode-dd-name {
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.mode-dd-arrow {
  color: var(--text-ghost);
}

.mode-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  box-shadow: var(--shadow-menu);
  overflow: hidden;
}

.mode-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 11px;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 1px solid transparent;
  cursor: pointer;
}

.mode-item:hover {
  background: var(--bg-hover);
}

.mode-item.sel {
  background: var(--bg-active);
  border-left-color: var(--green);
}

.mode-item-name {
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.mode-item.sel .mode-item-name {
  color: var(--green);
}

.mode-item.armed .mode-item-name {
  color: var(--red);
}

.mode-item-detail {
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-faint);
}

.mode-note {
  padding: 7px 11px;
  border-top: 1px solid var(--border-soft);
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-ghost);
}

.bypass-warn {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: var(--fs-meta);
  line-height: 1.5;
  color: var(--red-hover);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
  background: color-mix(in srgb, var(--red) 6%, transparent);
  border-radius: var(--rc);
}

html.sb-light .bypass-warn {
  color: var(--red);
}

.load-earlier {
  display: block;
  width: 100%;
  font-size: var(--fs-meta);
  color: var(--text-faint);
  cursor: pointer;
  text-align: center;
  margin-bottom: 12px;
}

.load-earlier:hover {
  color: var(--text-mid);
}

.agent-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--surface-inset) 55%, transparent);
  border: 1px solid var(--surface-inset-line);
  flex-wrap: wrap;
}

.ab-back {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.ab-back:hover {
  color: var(--text-strong);
}

.ab-sep {
  color: var(--border-seg);
}

.ab-dot {
  font-size: var(--fs-meta);
  color: var(--blue);
  animation: sbFade 1.6s var(--ease) infinite;
}

.ab-name {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-strong);
}

.ab-chip {
  white-space: nowrap;
}

.agents {
  margin-top: 6px;
}

.agents-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}

.agents-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--blue);
}

.agents-count {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.agents-toggle {
  font-size: var(--fs-micro);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 1px 9px;
  background: transparent;
  cursor: pointer;
}

.agents-toggle:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.agents-more {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  cursor: pointer;
  padding: 3px 6px;
}

.agents-more:hover {
  color: var(--green);
}

.bg-tasks {
  margin-top: 8px;
}

.agents-label.bg {
  color: var(--amber);
}

.agent-dot.bg {
  color: var(--amber);
  animation: sbFade 1.6s var(--ease) infinite;
}

.agents-rows {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.agent-row {
  margin: 0 -6px;
}

.agent-row:hover {
  box-shadow: var(--elev);
}

.agent-chat {
  font-size: var(--fs-micro);
  color: var(--green);
  white-space: nowrap;
}

.agent-dot {
  font-size: var(--fs-meta);
  color: var(--blue);
  animation: sbFade 1.6s var(--ease) infinite;
}

.agent-name {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-body);
  white-space: nowrap;
}

.agent-task {
  flex: 1;
  font-size: var(--fs-ui);
  color: var(--text-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.live-blocked {
  color: var(--amber);
}

.raw-view {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 52px;
  background: var(--bg-code);
}

.raw-line {
  font-family: var(--mono);
  font-size: var(--fs-meta);
  line-height: 1.65;
  color: var(--text-mid);
  white-space: pre-wrap;
  word-break: break-word;
}

.raw-line.t-prompt {
  color: var(--text-bright);
  font-weight: var(--w-em);
}

.raw-line.t-text {
  color: var(--text-body);
}

.raw-line.t-tool {
  color: var(--teal);
}

.raw-line.t-result {
  color: var(--text-ghost);
}

.raw-line.t-ok {
  color: var(--green);
}

.raw-line.t-warn {
  color: var(--amber);
}

.raw-line.t-err {
  color: var(--red);
}

.raw-line.t-inject {
  color: var(--text-noise);
  border-left: 1px solid var(--border);
  padding-left: 9px;
  margin-left: 1px;
}

.term-caret {
  color: var(--green);
}

.raw-line.stamped {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 12px;
  align-items: baseline;
}

.raw-stamp {
  color: var(--text-ghost);
  white-space: nowrap;
}

.composer {
  position: relative;
  box-shadow: var(--hairline-shine);
}

.composer.term {
  background: var(--bg-code);
  border-top-color: var(--border-code);
}

.composer.dead {
  background: var(--bg);
  box-shadow: none;
}

.composer.dead .composer-row {
  opacity: 0.55;
}

.composer.dead .composer-input,
.composer.dead .ghost-typed,
.composer.dead .to-inline {
  color: var(--text-ghost);
}

.composer.dead .composer-input::placeholder {
  color: var(--text-ghost);
}

.composer.dead .composer-input {
  caret-color: transparent;
}

.to-bottom {
  position: absolute;
  top: -44px;
  right: 22px;
  z-index: 5;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-body);
  color: var(--text-body);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  box-shadow: var(--shadow-dd);
  cursor: pointer;
}

.to-bottom:hover {
  color: var(--green);
  border-color: var(--green);
}

.caret {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  color: var(--green);
  font-weight: var(--w-em);
}

.caret.target {
  color: var(--amber);
}

.target-chip {
  flex-shrink: 0;
  white-space: nowrap;
}

.target-x {
  cursor: pointer;
  color: var(--text-faint);
  background: transparent;
}

.target-x:hover {
  color: var(--red);
}


.ident {
  min-width: 0;
}

.ident .h-dot {
  border-radius: var(--rp);
}

.name-block,
.run-block {
  min-width: 0;
}

.run-block {
  order: 9;
  margin-left: auto;
}

.run-block .wsl-check {
  padding: 0;
  background: transparent;
  border: 0;
}

.run-block .wsl-check:hover {
  border-color: transparent;
}

.name-cap,
.run-cap {
  flex: none;
  margin-right: 7px;
  font-family: var(--sans);
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-ghost);
}


.session-view.is-ended
  .stream-inner
  > *:not(.ended):not(.agent-banner):not(.load-earlier) {
  display: none;
}

.session-view.is-ended .stream-inner {
  margin-top: auto;
  margin-bottom: auto;
}

.session-view.is-ended {
  --end-card-w: 520px;
}

.session-view.is-ended .stream-inner > .ended {
  width: 100%;
  max-width: var(--end-card-w);
  margin-inline: auto;
  background: var(--bg-panel);
}

.session-view.is-ended .ended-actions {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
}

.session-view.is-ended .load-earlier {
  max-width: var(--end-card-w);
  margin-inline: auto;
}

.ended-line {
  font-size: var(--fs-title);
  color: var(--text-bright);
}

.session-view.is-ended .ended-line .faint {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}
</style>
