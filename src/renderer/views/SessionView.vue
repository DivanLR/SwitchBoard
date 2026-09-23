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
import { agentIdOf } from '@shared/domain'
import type { SectionKind, SessionEvent } from '@shared/domain'
import { DIAGRAM_PLUGIN } from '@shared/diagram'
import { activeAgents } from '@shared/agents'
import { parseInlineQuestion } from '@shared/inline-question'
import type { ProjectListItem } from '@shared/ipc-types'
import { errorMessage } from '@renderer/ipc'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import { useProjectRefs } from '@renderer/composables/useProjectRefs'
import { useSessionStart } from '@renderer/composables/useSessionStart'
import { useStopConfirm } from '@renderer/composables/useStopConfirm'
import { toRawLines } from '@shared/stream-lines'
import { useSectionsStore } from '@renderer/stores/sections'
import { useDiffStore } from '@renderer/stores/diff'
import { useFlowStore } from '@renderer/stores/flow'
import { useSpecsStore } from '@renderer/stores/specs'
import { useToastsStore } from '@renderer/stores/toasts'
import Icon from '@renderer/components/Icon.vue'
import SpecsView from '@renderer/views/SpecsView.vue'
import TestsView from '@renderer/views/TestsView.vue'
import DiffView from '@renderer/views/DiffView.vue'
import DiagramsView from '@renderer/views/DiagramsView.vue'
import SkillsView from '@renderer/views/SkillsView.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import ConversationTerminal from '@renderer/components/ConversationTerminal.vue'
import SessionHeader from '@renderer/components/session/SessionHeader.vue'
import SessionStream, { type StreamItem } from '@renderer/components/session/SessionStream.vue'
import SessionStartPanel from '@renderer/components/session/SessionStartPanel.vue'
import SessionComposer from '@renderer/components/session/SessionComposer.vue'

const props = defineProps<{ project: ProjectListItem }>()
const emit = defineEmits<{ (e: 'open-flow'): void; (e: 'open-settings', tab: 'skills'): void }>()

const projects = useProjectsStore()
const active = useActiveSessionStore()
const queue = useQueueStore()
const settingsStore = useSettingsStore()
const sections = useSectionsStore()
const diff = useDiffStore()
const flow = useFlowStore()
const specs = useSpecsStore()

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

const terminalEverOpened = ref(false)
const terminalMode = ref<'chat' | 'shell'>('chat')
const shellEverOpened = ref(false)
const mainTab = ref<
  | 'session'
  | 'terminal'
  | 'tests'
  | 'diff'
  | 'diagrams'
  | 'skills'
  | 'spec'
>('session')
const diffCount = computed(() => diff.resultFor(props.project.id).files.length)
const editTarget = ref<string | null>(null)

watch(mainTab, (tab) => {
  if (tab !== 'spec') editTarget.value = null
})

const composer = ref('')
const restoredDraft = ref<string | null>(null)
const streamCmp = useTemplateRef<InstanceType<typeof SessionStream>>('streamCmp')
const streamEl = computed(() => streamCmp.value?.el ?? null)
const composerCmp = useTemplateRef<InstanceType<typeof SessionComposer>>('composerCmp')
const composerEl = computed(() => composerCmp.value?.input ?? null)

const suggest = useCommandSuggestions({
  composer,
  composerEl,
  onSubmit: () => void send(),
  filterCommands: (commands) => {
    const disabled = settingsStore.settings?.disabledCommands?.[props.project.id] ?? []
    return commands.filter((c) => !disabled.includes(c.name))
  },
})
const {
  availableCommandNames,
  load: loadHistory,
  setCommands: setSuggestionCommands,
  reset: resetSuggestions,
  recordSent,
} = suggest

const liveSession = computed(() =>
  props.project.session && !props.project.session.endedAt ? props.project.session : null,
)
const endedSession = computed(() =>
  props.project.session && props.project.session.endedAt ? props.project.session : null,
)

const terminalSession = computed(() => liveSession.value ?? endedSession.value)

const terminalResumeId = computed(() => {
  const ended = endedSession.value
  if (liveSession.value || !ended?.sdkSessionId) return null
  if (ended.containerised) return null
  return ended.sdkSessionId
})

const { stopConfirm, cancelStop, confirmStop } = useStopConfirm({
  composerEl,
  liveSession: () => liveSession.value,
  interrupt: () => interrupt(),
})

let unsubscribeCommands: (() => void) | undefined
let unsubscribeFlow: (() => void) | undefined
onMounted(() => {
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
  unsubscribeFlow = window.switchboard.on('push.flowChanged', (push) => {
    if (push.projectId === props.project.id) flow.applyPush(push.projectId, push.runs, push.stages, push.listing)
  })
})
onUnmounted(() => {
  unsubscribeCommands?.()
  unsubscribeFlow?.()
  composerDrafts.set(props.project.id, composer.value)
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

const agentsExpanded = ref(false)
const tasksExpanded = ref(false)

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

let resetStart: (() => void) | undefined

watch(
  () => props.project.id,
  (projectId, prevId) => {
    if (prevId) composerDrafts.set(prevId, composer.value)
    composer.value = composerDrafts.get(projectId) ?? ''
    restoredDraft.value = null
    mainTab.value = 'session'
    editTarget.value = null
    terminalEverOpened.value = false
    shellEverOpened.value = false
    terminalMode.value = 'chat'
    resetStart?.()
    cancelStop()
    deriveWindow.value = DERIVE_WINDOW
    followTail.value = true
    resetSuggestions()
    void loadHistory(projectId)
    void diff.loadList(projectId)
    void queue.load(projectId)
    void flow.load(projectId)
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

const sessionStart = useSessionStart({
  project: () => props.project,
  endedSession,
})
resetStart = sessionStart.reset
const { busy, startEngine } = sessionStart

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

const canShowEarlier = computed(
  () => renderStart.value > 0 || deriveWindow.value < active.events.length || active.hasMoreHistory,
)

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

const sectionSessionsByProject = ref<Record<string, Partial<Record<SectionKind, string>>>>({})
const sectionSessionIds = computed(() => sectionSessionsByProject.value[props.project.id] ?? {})

function noteSectionSession(projectId: string, kind: SectionKind, id: string): void {
  const byProject = sectionSessionsByProject.value
  sectionSessionsByProject.value = { ...byProject, [projectId]: { ...byProject[projectId], [kind]: id } }
}

function runPluginCommand(text: string, kind: SectionKind, watchDiagrams = false): void {
  const projectId = props.project.id
  void sections.runInSession(projectId, text, true, watchDiagrams, kind).then((id) => {
    noteSectionSession(projectId, kind, id)
  })
}

function runDiagramCommand(text: string): void {
  runPluginCommand(text, 'diagram', true)
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

const installDiagramPlugin = (): Promise<void> =>
  installPlugin(DIAGRAM_PLUGIN.marketplace, DIAGRAM_PLUGIN.pkg)

function onSetTarget(label: string): void {
  editTarget.value = label
  void nextTick(() => composerEl.value?.focus())
}

async function send(): Promise<void> {
  const text = composer.value.trim()
  if (!text) return
  busy.value = true
  try {
    const target = editTarget.value
    if (target) {
      await specs.run(props.project.id, `✎ Spec edit → ${target}: ${text}`, 'spec-edit', 'Applying your edit')
      composer.value = ''
      editTarget.value = null
      return
    }
    if (await deliver(text)) composer.value = ''
  } catch (error) {
    useToastsStore().show('error', 'Could not start that edit', errorMessage(error))
  } finally {
    busy.value = false
  }
}

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

const projectRefs = useProjectRefs({
  projectId: () => props.project.id,
  onInsertPath: (path) => {
    composer.value = composer.value ? `${composer.value} @${path}` : `@${path}`
  },
})
const { dragKind, onPaneDragOver, onPaneDragLeave, onPaneDrop } = projectRefs
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
    <SessionHeader
      v-if="!active.fullScreenSection"
      :project="project"
      :live-session="liveSession"
      :ended-session="endedSession"
      :agent-count="workingAgents.length"
      :background-count="backgroundTasks.length"
      :ending="ending"
      @open-flow="emit('open-flow')"
      @end="stop()"
      @usage="openFullUsage()"
    />

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
      <button
        class="ui-tab"
        :class="{ sel: mainTab === 'spec', 'is-selected': mainTab === 'spec' }"
        data-testid="tab-sdd"
        @click="mainTab = 'spec'"
      >
        SDD
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
      :engine="terminalSession?.engine ?? startEngine"
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
      :can-take-over="!liveSession?.containerised"
      :visible="mainTab === 'terminal' && terminalMode === 'shell'"
      @takeover="stop()"
      @chat="terminalMode = 'chat'"
    />

    <SpecsView
      v-if="mainTab === 'spec'"
      :project-id="project.id"
      @set-target="onSetTarget"
      @open-flow="emit('open-flow')"
    />
    <TestsView
      v-else-if="mainTab === 'tests'"
      :project-id="project.id"
      :project-name="project.name"
      :branch="liveSession?.branch ?? endedSession?.branch ?? null"
    />
    <DiffView v-else-if="mainTab === 'diff'" :project-id="project.id" />
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
      @ran="(id: string) => noteSectionSession(project.id, 'skills', id)"
      @manage="emit('open-settings', 'skills')"
    />
    <SessionStream
      v-else-if="mainTab === 'session'"
      ref="streamCmp"
      v-model:agents-expanded="agentsExpanded"
      v-model:tasks-expanded="tasksExpanded"
      :project="project"
      :live-session="liveSession"
      :ended-session="endedSession"
      :selected-agent="selectedAgent"
      :working-agents="workingAgents"
      :background-tasks="backgroundTasks"
      :items="visibleItems"
      :can-show-earlier="canShowEarlier"
      :inline-question="inlineQuestion"
      :raw-lines="rawLines"
      :stamps="outputPrefs.timestamps"
      :zoom="streamZoom"
      @show-earlier="showEarlier()"
      @inline-answer="onInlineAnswer"
      @edit-queued="editQueued"
      @scroll="onStreamScroll()"
    >
      <SessionStartPanel v-if="endedSession" :session="endedSession" :starter="sessionStart" />
    </SessionStream>

    <SessionComposer
      v-if="mainTab === 'session' || editTarget"
      ref="composerCmp"
      v-model="composer"
      :target="editTarget"
      :project="project"
      :live="!!liveSession"
      :send-to="sendTo"
      :busy="busy"
      :at-bottom="atBottom"
      :restored-draft="restoredDraft"
      :stop-confirm="stopConfirm"
      :queued-edit-error="queuedEditError"
      :suggest="suggest"
      :ref-editor="projectRefs"
      @send="send()"
      @clear-target="editTarget = null"
      @to-bottom="scrollToBottom()"
      @confirm-stop="confirmStop()"
      @cancel-stop="cancelStop()"
    />
  </div>
</template>

<style scoped>
.session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  position: relative;
}

.session-view.is-ended {
  --end-card-w: 520px;
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
</style>
