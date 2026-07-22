<script setup lang="ts">
// Session stream — 1:1 with the design reference: two-row header (identity,
// status pill, clean/raw segments, meta line), clean stream with swallowed
// blocks and a live status line, dark raw log, and the ❯ composer bar
// (FR-014..019a, R2 resume).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { MODEL_CHOICES } from '@shared/domain'
import type { AgentScopedPayload, SessionEvent, CleanupGroup } from '@shared/domain'
import { activeAgents } from '@shared/agents'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import { useSpecsStore } from '@renderer/stores/specs'
import { accentFor } from '@renderer/project-accent'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import SwallowedBlock from '@renderer/components/SwallowedBlock.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import SpecsView from '@renderer/views/SpecsView.vue'
import CleanupView from '@renderer/views/CleanupView.vue'

const props = defineProps<{ project: ProjectListItem }>()
const emit = defineEmits<{ (e: 'open-proj-settings'): void }>()

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const settingsStore = useSettingsStore()
const specs = useSpecsStore()

const queuedTasks = computed(() => queue.forProject(props.project.id))

// Per-project accent square before the name (design), matching the sidebar row.
const headerColor = computed(() => accentFor(props.project.id))

// Output settings (Terminals tab): font size, tool rows, timestamps, autoscroll.
const outputPrefs = computed(() => ({
  fontSize: settingsStore.settings?.fontSize ?? 'md',
  showToolRows: settingsStore.settings?.showToolRows ?? false,
  timestamps: settingsStore.settings?.timestamps ?? false,
  autoscroll: settingsStore.settings?.autoscroll ?? true,
}))
// ponytail: zoom scales the fixed-px stream typography in one place (Chromium-only, fine in Electron).
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

// Main-area tab: the live session stream, the project's Spec Kit specs, or the
// review/cleanup command launcher.
const mainTab = ref<'session' | 'specs' | 'cleanup'>('session')
const specCount = computed(() => specs.stateFor(props.project.id).specs.length)

const composer = ref('')
// Spec-edit target (design ✎ chip): when set, the composer rewrites this spec
// file/section instead of chatting. Set by SpecsView's Refine actions.
const editTarget = ref<string | null>(null)
const draftRestored = ref(false)
const busy = ref(false)
// Ended-banner restart option: start the next session with all permissions
// bypassed (--dangerously-skip-permissions), mirroring the New session dialog.
const bypassRestart = ref(false)
const streamEl = ref<HTMLElement | null>(null)
const composerEl = ref<HTMLTextAreaElement | null>(null)

// Terminal-style composer suggestions (history + plugin/skill commands, ghost
// text, dropdown, up-arrow recall) live in a dedicated composable.
const {
  suggestions,
  availableCommandNames,
  ghostRest,
  isCommandMatch,
  suggestIndex,
  acceptSuggestion,
  onComposerInput,
  onComposerKeydown,
  load: loadHistory,
  setCommands: setSuggestionCommands,
  hintFor,
  reset: resetSuggestions,
  recordSent,
} = useCommandSuggestions({
  composer,
  composerEl,
  onSubmit: () => void send(),
  // Plugin toggles (Settings → This project) hide a plugin's commands here.
  filterCommands: (commands) => {
    const disabled = settingsStore.settings?.disabledCommands?.[props.project.id] ?? []
    return commands.filter((c) => !disabled.includes(c.name))
  },
})

// Split the composer into the leading command token and the rest, so the ghost
// mirror can colour only the command green while the arguments stay normal.
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
const canResume = computed(() => Boolean(endedSession.value?.sdkSessionId))

const pendingCount = computed(
  () => inbox.pending.filter((p) => p.projectId === props.project.id).length,
)

// Session timer (HH:MM:SS, ticking) and usage figures from loaded result events.
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | undefined

// Ctrl+C interrupts the running session, like a terminal. If text is selected,
// let the browser copy it instead (matching modern terminal behaviour).
function onGlobalKeydown(event: KeyboardEvent): void {
  if (!event.ctrlKey || (event.key !== 'c' && event.key !== 'C') || event.altKey || event.metaKey) {
    return
  }
  const selection = window.getSelection()?.toString() ?? ''
  if (selection.length > 0) return // preserve copy
  if (!liveSession.value) return
  event.preventDefault()
  void interrupt()
}

let unsubscribeCommands: (() => void) | undefined
onMounted(() => {
  tick = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  window.addEventListener('keydown', onGlobalKeydown)
  // A session's init message delivers its slash commands / skills after start;
  // pick them up live so a newly-added project's suggestions load without a
  // project switch.
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
})
onUnmounted(() => {
  clearInterval(tick)
  window.removeEventListener('keydown', onGlobalKeydown)
  unsubscribeCommands?.()
})

const sessionTimer = computed(() => {
  if (!liveSession.value) return null
  const sec = Math.max(0, Math.floor((now.value - Date.parse(liveSession.value.startedAt)) / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`
})

// Subagents still working this turn — listed under the live line (goal: see
// the agents when multiple are running).
const workingAgents = computed(() =>
  liveSession.value?.status === 'working' ? activeAgents(active.events) : [],
)

// --- Subagent chat view (design: click an agent → its own conversation) ---
const selectedAgent = computed(
  () => workingAgents.value.find((a) => a.id === active.selectedAgentId) ?? null,
)

// A finished/vanished agent closes its chat view; opening one jumps to Session.
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

function agentIdOf(event: SessionEvent): string | undefined {
  return (event.payload as AgentScopedPayload).agentId
}

// Subscription rate-limit usage (the same signal the sidebar meter shows) — a
// truer picture of "current session usage" than a per-run token/cost estimate.
const usagePct = computed(() => {
  const u = liveSession.value?.usageUtilization
  return u != null ? Math.max(0, Math.min(100, Math.round(u))) : null
})
const usageColor = computed(() => {
  const p = usagePct.value ?? 0
  return p > 85 ? 'var(--red)' : p > 60 ? 'var(--amber)' : 'var(--green)'
})
const usageLimitLabel = computed(() => {
  const t = liveSession.value?.usageLimitType
  if (t === 'five_hour') return '5h limit'
  if (t?.startsWith('seven_day')) return '7d limit'
  // Before the SDK reports a window, show the primary (5h) label as a placeholder.
  return '5h limit'
})

// Prompt-cache hit rate for the latest completed turn: cache_read /
// (cache_read + cache_creation + fresh input). A high number means the
// conversation prefix is being reused instead of re-billed at full price.
const cacheHitPct = computed(() => {
  for (let i = active.events.length - 1; i >= 0; i -= 1) {
    const event = active.events[i]
    if (event.kind !== 'result') continue
    const usage = (event.payload as { usage?: Record<string, unknown> }).usage ?? {}
    const num = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
    const read = num('cache_read_input_tokens')
    const total = read + num('cache_creation_input_tokens') + num('input_tokens')
    if (total === 0) return null
    return Math.round((read / total) * 100)
  }
  return null
})

// The model the SDK reported for the latest turn (reflects intent routing live).
const modelLabel = computed(() => {
  const id = liveSession.value?.currentModel
  if (!id) return null
  return MODEL_CHOICES.find((m) => m.id === id)?.label ?? id
})

watch(
  () => liveSession.value?.id ?? null,
  async (sessionId) => {
    await active.open(sessionId)
    if (!draftRestored.value && props.project.drafts.length > 0 && composer.value === '') {
      composer.value = props.project.drafts.map((d) => d.text).join('\n')
      draftRestored.value = true
    }
    scrollToBottom()
  },
  { immediate: true },
)

// Put the caret in the composer as soon as it can take input (session open,
// project switch, returning from the Specs tab) — no click needed to type.
watch(
  [() => liveSession.value?.id ?? null, mainTab, () => props.project.id, () => active.selectedAgentId],
  () => {
    if (!liveSession.value || mainTab.value !== 'session') return
    void nextTick(() => composerEl.value?.focus())
  },
  { immediate: true },
)

watch(
  () => props.project.id,
  (projectId) => {
    composer.value = ''
    draftRestored.value = false
    mainTab.value = 'session'
    editTarget.value = null
    resetSuggestions()
    void loadHistory(projectId)
    void specs.loadState(projectId)
    void queue.load(projectId)
  },
  { immediate: true },
)

// --- Clean view derivation (FR-015): consecutive same-noiseKind grouping ---
type StreamItem =
  | { type: 'event'; event: SessionEvent }
  | { type: 'block'; noiseKind: string; events: SessionEvent[]; key: string }

// The main stream hides subagent internals (they live in the agent chat view);
// the agent view shows only that agent's events, opened by its delegating
// prompt (synthesized — the Task tool input is the conversation opener).
const scopedEvents = computed<SessionEvent[]>(() => {
  const agent = selectedAgent.value
  if (!agent) return active.events.filter((e) => agentIdOf(e) === undefined)
  const intro: SessionEvent = {
    id: `agent-intro-${agent.id}`,
    sessionId: active.sessionId ?? '',
    seq: -1,
    kind: 'prompt',
    payload: { text: `[${props.project.name}] ${agent.prompt}` },
    noiseKind: null,
    createdAt: '',
  }
  return [intro, ...active.events.filter((e) => agentIdOf(e) === agent.id)]
})

const items = computed<StreamItem[]>(() => {
  const result: StreamItem[] = []
  let block: { noiseKind: string; events: SessionEvent[] } | null = null
  for (const event of scopedEvents.value) {
    // Clean view narrative: subagents are represented by the AGENTS card, never
    // as raw tool rows; other tool activity (commands being run) shows unless the
    // "Show tool activity" setting is off. The raw view always keeps everything.
    if (event.kind === 'tool_activity') {
      const toolName = (event.payload as { toolName?: string }).toolName
      if (toolName === 'Task' || toolName === 'Agent') continue
      if (!outputPrefs.value.showToolRows) continue
    }
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

// Simple windowing keeps the DOM bounded on flood-heavy sessions (SC-007).
const MAX_RENDER = 500
const renderStart = ref(0)
watch(
  () => items.value.length,
  (length) => {
    renderStart.value = Math.max(0, length - MAX_RENDER)
  },
)
const visibleItems = computed(() => items.value.slice(renderStart.value))

function showEarlier(): void {
  renderStart.value = Math.max(0, renderStart.value - MAX_RENDER)
  if (renderStart.value === 0 && active.hasMoreHistory) void active.loadEarlier()
}

// --- Raw view: complete session output as mono lines (FR-018) ---
function rawLinesOf(event: SessionEvent): string[] {
  // The payload is the EventPayloadMap union; this raw-view formatter reads a
  // fixed set of optional string fields across kinds, so type it as exactly that
  // rather than an untyped `unknown` cast.
  const p = event.payload as Partial<{
    text: string
    toolName: string
    inputPreview: string
    resultPreview: string
    status: string
    title: string
  }>
  switch (event.kind) {
    case 'prompt':
      return [`❯ ${p.text}`]
    case 'assistant_text':
    case 'summary':
      return String(p.text ?? '')
        .split('\n')
        .map((line, i) => (event.kind === 'summary' && i === 0 ? `✦ ${line}` : line))
    case 'tool_activity': {
      const lines = [`⏺ ${p.toolName}(${p.inputPreview ?? ''})`]
      if (p.resultPreview) lines.push(`  ⎿ ${p.resultPreview}`)
      return lines
    }
    case 'permission_marker':
    case 'plan_marker': {
      const status = String(p.status)
      if (status === 'pending') return [`? Permission: ${p.title}`, '⏸ Waiting for approval…']
      const mark = status === 'approved' || status === 'rule_approved' ? '✓' : '✗'
      return [`${mark} ${status} · ${p.title}`]
    }
    case 'question':
      return [`? ${p.text}`]
    case 'error':
      return [`✗ ${p.text}`]
    case 'result':
      return ['✓ turn complete']
    default:
      return String(p.text ?? '').split('\n')
  }
}

function hhmm(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Stable keys per raw line (event id + line offset) so streaming updates key
// correctly rather than by array index. When Timestamps is on, the event's HH:MM
// sits in a gutter on its first line (matching the clean view).
const rawLines = computed(() => {
  const stamps = outputPrefs.value.timestamps
  return active.events.flatMap((event) => {
    const stamp = stamps ? hhmm(event.createdAt) : null
    return rawLinesOf(event).map((text, i) => ({
      key: `${event.id}:${i}`,
      text,
      stamp: i === 0 ? stamp : '',
    }))
  })
})

function scrollToBottom(): void {
  void nextTick(() => {
    if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
  })
}

// Clean/Raw toggle re-pins to the newest line — the two views have separate
// scroll containers, so switching would otherwise land wherever the other was.
function switchView(view: 'clean' | 'raw'): void {
  active.setView(view)
  scrollToBottom()
}

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
      active.focusEventId = null
    })
  },
)

// --- Actions ---
// A Refine action in SpecsView sets a spec-edit target. Stay on the Specs tab
// (the composer footer is shared across tabs) and focus it, so the developer can
// type the change in place instead of being pulled back to the session stream.
function onSetTarget(label: string): void {
  editTarget.value = label
  void nextTick(() => composerEl.value?.focus())
}

// A Cleanup card sends its slash command straight to the session; output lands
// in the Session tab, so switch there to watch it run.
function runCleanup(command: string): void {
  mainTab.value = 'session'
  void specs.runInSession(props.project.id, command)
}

// "Download to project" adds the plugin's marketplace then installs it — two
// slash commands run in order in the session.
async function installCleanup(group: CleanupGroup): Promise<void> {
  mainTab.value = 'session'
  await specs.runInSession(props.project.id, group.marketplace)
  await specs.runInSession(props.project.id, group.pkg)
}

async function send(): Promise<void> {
  const text = composer.value.trim()
  if (!text) return
  busy.value = true
  try {
    // Spec-edit target: the message rewrites the referenced spec via the session.
    if (editTarget.value) {
      const target = editTarget.value
      composer.value = ''
      editTarget.value = null
      await specs.runInSession(props.project.id, `✎ Spec edit → ${target}: ${text}`)
      scrollToBottom()
      return
    }
    if (!liveSession.value) return
    const agent = selectedAgent.value
    // Attach any REFS as @path mentions so the model reads them this turn. The
    // chips stay (they also grant the session folder access) — user setting.
    const refs = props.project.refs
    // One @path per line so multiple refs (and paths containing spaces) stay
    // unambiguous rather than running together on one space-delimited line.
    const withRefs =
      refs.length > 0 ? `${text}\n\n${refs.map((r) => `@${r.path}`).join('\n')}` : text
    // Agent chat: the message goes to the session addressed at the subagent
    // (the SDK has no direct subagent input channel; the main loop relays).
    if (agent) await active.send(`[to ${agent.name}] ${withRefs}`, agent.id)
    else await active.send(withRefs)
    composer.value = ''
    // Surface the just-sent command at the top of the suggestion history at once.
    recordSent(text)
    scrollToBottom()
  } finally {
    busy.value = false
  }
}

async function enqueue(): Promise<void> {
  const text = composer.value.trim()
  if (!text) return
  await queue.add(props.project.id, text)
  composer.value = ''
  resetSuggestions()
}

async function removeQueued(id: string): Promise<void> {
  await queue.remove(props.project.id, id)
}

async function start(resume: boolean): Promise<void> {
  busy.value = true
  try {
    await projects.startSession(props.project.id, resume, bypassRestart.value)
  } finally {
    busy.value = false
  }
}

// Ctrl+C, like a terminal (the design has no interrupt button).
async function interrupt(): Promise<void> {
  await active.interrupt()
}

// End the session outright (distinct from Ctrl+C, which only interrupts the turn).
async function stop(): Promise<void> {
  await active.stop()
}

function answerQuestion(eventId: string, choice: string): void {
  void active.answerQuestion(eventId, choice)
}

function openInbox(requestId: string): void {
  inbox.focusRequest(requestId)
}

// A file dropped on this project's sidebar row lands here as @path text.
watch(
  () => active.composerInsert,
  (text) => {
    if (!text) return
    composer.value = composer.value ? `${composer.value} ${text}` : text
    active.composerInsert = null
    composerEl.value?.focus()
  },
)

// --- REFS row (design): folders this project's sessions may read ---
const addingRef = ref(false)
const refInput = ref('')
const refError = ref<string | null>(null)

async function commitRef(): Promise<void> {
  const target = refInput.value.trim()
  addingRef.value = false
  refInput.value = ''
  if (!target) return
  try {
    refError.value = null
    await projects.addRef(props.project.id, target)
  } catch (e) {
    refError.value = e instanceof Error ? e.message : ((e as { message?: string })?.message ?? String(e))
  }
}

function cancelRef(): void {
  addingRef.value = false
  refInput.value = ''
}

async function removeRef(path: string): Promise<void> {
  await projects.removeRef(props.project.id, path)
}

// --- Drag & drop onto the pane (design): sidebar project → REF chip;
// OS file → its path inserted into the composer as @path. ---
const dragKind = ref<null | 'project' | 'file'>(null)

function onPaneDragOver(event: DragEvent): void {
  const types = event.dataTransfer?.types ?? []
  const kind = types.includes('text/x-sb-project')
    ? 'project'
    : types.includes('Files')
      ? 'file'
      : null
  if (!kind) return
  event.preventDefault()
  dragKind.value = kind
}

function onPaneDragLeave(event: DragEvent): void {
  const related = event.relatedTarget as Node | null
  if (!related || !(event.currentTarget as Node).contains(related)) dragKind.value = null
}

async function onPaneDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  const kind = dragKind.value
  dragKind.value = null
  if (kind === 'project') {
    const path = event.dataTransfer?.getData('text/x-sb-project-path') ?? ''
    if (path) await projects.addRef(props.project.id, path).catch(() => {})
  } else if (kind === 'file') {
    // A dropped FOLDER becomes a reference; a dropped FILE inserts its @path.
    for (const item of [...(event.dataTransfer?.items ?? [])]) {
      if (item.kind !== 'file') continue
      const isDir = item.webkitGetAsEntry?.()?.isDirectory ?? false
      const file = item.getAsFile()
      const path = file ? window.switchboard.pathForFile?.(file) : undefined
      if (!path) continue
      if (isDir) {
        await projects.addRef(props.project.id, path).catch(() => {})
      } else {
        composer.value = composer.value ? `${composer.value} @${path}` : `@${path}`
      }
    }
  }
}
</script>

<template>
  <div
    class="session-view"
    @dragover="onPaneDragOver"
    @dragleave="onPaneDragLeave"
    @drop="onPaneDrop"
  >
    <!-- Header -->
    <header class="head">
      <div class="head-row">
        <span class="h-dot" :style="{ background: headerColor }"></span>
        <span class="h-name mono" data-testid="session-project-name">{{ project.name }}</span>
        <span class="h-path mono" data-testid="session-project-path">{{ project.path }}</span>
        <span style="flex: 1"></span>
        <span
          v-if="liveSession?.bypassPermissions"
          class="pill bypass-pill"
          data-testid="bypass-pill"
          title="Started with --dangerously-skip-permissions"
        >
          ⚠ Bypass
        </span>
        <span
          v-if="workingAgents.length > 1"
          class="pill agents-pill"
          data-testid="agents-pill"
        >
          ⑂ {{ workingAgents.length }} agents
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
          v-if="liveSession?.status === 'working'"
          class="stop-btn mono"
          data-testid="stop-session"
          title="Interrupt the current turn (Ctrl+C)"
          @click="interrupt()"
        >
          ■
        </button>
        <button
          v-if="liveSession"
          class="ctl mono"
          data-testid="end-session"
          title="End the session (resumable later)"
          @click="stop()"
        >
          End
        </button>
        <button
          class="ctl mono"
          data-testid="open-proj-settings"
          title="Project settings"
          @click="emit('open-proj-settings')"
        >
          ⚙
        </button>
        <div class="segments mono" data-testid="view-toggle">
          <div
            class="seg"
            :class="{ on: active.view === 'clean' }"
            data-testid="view-clean"
            @click="switchView('clean')"
          >
            Clean
          </div>
          <div
            class="seg"
            :class="{ on: active.view === 'raw' }"
            data-testid="view-raw"
            @click="switchView('raw')"
          >
            Raw
          </div>
        </div>
      </div>
      <div class="head-meta mono">
        <span style="white-space: nowrap">⎇ {{ liveSession?.branch ?? endedSession?.branch ?? '—' }}</span>
        <span
          v-if="modelLabel"
          data-testid="session-model"
          style="color: var(--text-faint); white-space: nowrap"
        >
          {{ modelLabel }}
        </span>
        <span
          v-if="liveSession && liveSession.diffAdds != null"
          data-testid="diff-stats"
          style="white-space: nowrap"
        >
          <span style="color: var(--green)">+{{ liveSession.diffAdds }}</span>
          <span style="color: var(--red)"> −{{ liveSession.diffDels ?? 0 }}</span>
        </span>
        <span v-if="sessionTimer" style="color: var(--text-faint); white-space: nowrap">
          session <span style="color: var(--text-meta)">{{ sessionTimer }}</span>
        </span>
        <span
          v-if="liveSession"
          data-testid="session-usage"
          style="color: var(--text-faint); white-space: nowrap"
        >
          <span v-if="usagePct != null" :style="{ color: usageColor }">{{ usagePct }}%</span>
          <span v-else>—</span>
          {{ usageLimitLabel }}
        </span>
        <span
          v-if="cacheHitPct != null"
          data-testid="session-cache"
          style="color: var(--text-faint); white-space: nowrap"
          title="Prompt-cache hit rate for the latest turn (cached prefix reused vs. re-billed)"
        >
          cache
          <span :style="{ color: cacheHitPct > 50 ? 'var(--green)' : 'var(--amber)' }">{{ cacheHitPct }}%</span>
        </span>
      </div>
    </header>

    <!-- Drag-over overlay (design): dashed frame naming the drop action -->
    <div v-if="dragKind" class="drop-overlay mono" data-testid="drop-overlay">
      <div class="drop-box">
        <div class="drop-title">
          {{ dragKind === 'project' ? '⇗ Reference this project' : '@ Reference file path' }}
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

    <!-- Session / Specs / Cleanup tabs -->
    <div class="main-tabs mono">
      <button
        class="mt"
        :class="{ sel: mainTab === 'session' }"
        data-testid="tab-session"
        @click="mainTab = 'session'"
      >
        Session
      </button>
      <button class="mt" :class="{ sel: mainTab === 'specs' }" data-testid="tab-specs" @click="mainTab = 'specs'">
        Specs
        <span v-if="specCount > 0" class="mt-badge">{{ specCount }}</span>
      </button>
      <button
        class="mt"
        :class="{ sel: mainTab === 'cleanup' }"
        data-testid="tab-cleanup"
        @click="mainTab = 'cleanup'"
      >
        Cleanup
      </button>
    </div>

    <SpecsView v-if="mainTab === 'specs'" :project-id="project.id" @set-target="onSetTarget" />
    <CleanupView
      v-else-if="mainTab === 'cleanup'"
      :project-name="project.name"
      :available="availableCommandNames"
      @run="runCleanup"
      @install="installCleanup"
    />

    <!-- Clean stream (an open agent chat always renders clean) -->
    <div
      v-else-if="active.view === 'clean' || selectedAgent"
      ref="streamEl"
      class="stream"
      data-testid="stream"
      :style="{ zoom: streamZoom }"
    >
      <div class="stream-inner">
        <!-- Agent chat banner: ← back │ ● name · subagent -->
        <div v-if="selectedAgent" class="agent-banner mono" data-testid="agent-banner">
          <span class="ab-back" data-testid="agent-back" @click="active.selectAgent(null)">
            ← {{ project.name }}
          </span>
          <span class="ab-sep">│</span>
          <span class="ab-dot">●</span>
          <span class="ab-name">{{ selectedAgent.task || selectedAgent.name }}</span>
          <span class="ab-chip">subagent</span>
          <span style="flex: 1"></span>
        </div>

        <div v-if="!liveSession && !endedSession" class="stream-empty">
          <div class="mono faint" data-testid="no-session-hint">
            No session yet — press + in the sidebar and point New session at this folder.
          </div>
        </div>

        <div v-if="endedSession" class="ended" data-testid="ended-banner">
          <div class="mono" style="font-size: 12px; color: var(--text-mid)">
            Session ended <span class="faint">({{ endedSession.endReason ?? 'unknown' }})</span>
            <span v-if="endedSession.statusDetail" class="faint"> — {{ endedSession.statusDetail }}</span>
          </div>
          <div class="ended-actions">
            <button class="btn-solid" data-testid="start-session" :disabled="busy" @click="start(false)">
              Start new session
            </button>
            <button
              v-if="canResume"
              class="btn-quiet"
              data-testid="resume-session"
              :disabled="busy"
              title="Start a session resuming the previous conversation context"
              @click="start(true)"
            >
              Resume previous conversation
            </button>
            <span class="bypass-inline mono">
              <button
                class="switch danger"
                :class="{ on: bypassRestart }"
                data-testid="bypass-restart-toggle"
                role="switch"
                :aria-checked="bypassRestart"
                title="Start with all permissions bypassed (--dangerously-skip-permissions)"
                @click="bypassRestart = !bypassRestart"
              >
                <span class="knob"></span>
              </button>
              <span :class="{ armed: bypassRestart }">Bypass permissions</span>
            </span>
          </div>
        </div>

        <div
          v-if="renderStart > 0 || active.hasMoreHistory"
          class="load-earlier mono"
          @click="showEarlier()"
        >
          ▴ show earlier activity
        </div>

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
          />
        </template>

        <!-- Agent chat: the live line is the agent's task -->
        <div v-if="selectedAgent" class="live mono" data-testid="live-line">
          <span class="blink" style="color: var(--green)">▊</span>
          {{ selectedAgent.task || selectedAgent.label }}
        </div>

        <!-- Subagents working in parallel (design: replaces the live line) -->
        <div v-else-if="workingAgents.length > 1" class="agents mono" data-testid="agent-list">
          <div class="agents-head">
            <span class="agents-label">⑂ AGENTS</span>
            <span class="agents-count">{{ workingAgents.length }} working in parallel</span>
          </div>
          <div class="agents-rows">
            <div
              v-for="agent in workingAgents"
              :key="agent.id"
              class="agent-row"
              data-testid="agent-row"
              @click="active.selectAgent(agent.id)"
            >
              <span class="agent-dot">●</span>
              <span class="agent-name">{{ agent.name }}</span>
              <span class="agent-task">{{ agent.task || agent.label }}</span>
              <span class="agent-chat">chat →</span>
            </div>
          </div>
        </div>

        <!-- Live status line -->
        <div
          v-else-if="liveSession?.status === 'working'"
          class="live mono"
          data-testid="live-line"
        >
          <span class="blink" style="color: var(--green)">▊</span>
          {{ liveSession.statusDetail || 'Working…' }}
        </div>
        <div
          v-else-if="liveSession?.status === 'needs_you'"
          class="live live-blocked mono"
          data-testid="live-line"
        >
          <span class="blink">▊</span>
          Blocked — {{ pendingCount > 0 ? `${pendingCount} pending` : 'needs your answer' }}
        </div>
      </div>
    </div>

    <!-- Raw view -->
    <div v-else ref="streamEl" class="raw-view" data-testid="stream" :style="{ zoom: streamZoom }">
      <div
        v-for="line in rawLines"
        :key="line.key"
        class="raw-line mono"
        :class="{ stamped: outputPrefs.timestamps }"
        data-testid="raw-line"
      >
        <span v-if="outputPrefs.timestamps" class="raw-stamp" data-testid="raw-stamp">{{ line.stamp }}</span>
        <span>{{ line.text }}</span>
      </div>
    </div>

    <!-- Composer -->
    <footer class="composer">
      <!-- REFS (design): folders this session may read — floats just above the
           composer, overlapping the bottom of the stream. -->
      <div class="refs-row mono" data-testid="refs-row">
        <span class="refs-label">REFS</span>
        <span
          v-for="r in project.refs"
          :key="r.path"
          class="ref-chip"
          :title="r.path"
          :data-testid="`ref-chip-${r.label}`"
        >
          <span class="ref-ico">⇗</span>
          <span class="ref-name">{{ r.label }}</span>
          <button class="ref-x" :data-testid="`ref-remove-${r.label}`" @click="removeRef(r.path)">
            ✕
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
          + reference
        </button>
        <span v-if="refError" class="ref-error" data-testid="ref-error">{{ refError }}</span>
      </div>
      <!-- Planned task queue ("UP NEXT"): runs each item in order as the session goes idle -->
      <div v-if="queuedTasks.length > 0" class="queue" data-testid="task-queue">
        <span class="queue-label mono">UP NEXT</span>
        <span
          v-for="(task, index) in queuedTasks"
          :key="task.id"
          class="queue-chip mono"
          :data-testid="`queue-item-${index}`"
        >
          <span class="queue-num">{{ index + 1 }}</span>
          <span class="queue-text">{{ task.text }}</span>
          <button
            class="queue-x"
            :data-testid="`queue-remove-${index}`"
            title="Remove from the queue"
            @click="removeQueued(task.id)"
          >
            ✕
          </button>
        </span>
        <span class="queue-note mono">Runs automatically when the current goal finishes</span>
      </div>
      <div v-if="draftRestored && composer" class="draft-note mono" data-testid="draft-note">
        Restored draft from the previous run — send to deliver it.
      </div>
      <div class="composer-row">
        <span v-if="editTarget" class="caret target mono">✎</span>
        <span v-else class="caret mono">❯</span>
        <span
          v-if="editTarget"
          class="target-chip mono"
          data-testid="composer-target"
          title="Spec edit target — your message rewrites this file"
        >
          → {{ editTarget }}
          <button class="target-x" data-testid="composer-target-clear" @click="editTarget = null">
            ✕
          </button>
        </span>
        <div class="input-wrap">
          <!-- Suggestion dropdown (terminal-style), above the input -->
          <div v-if="suggestions.length > 0" class="suggest-list mono" data-testid="suggest-list">
            <div
              v-for="(cmd, index) in suggestions"
              :key="cmd"
              class="suggest-item"
              :class="{ active: index === suggestIndex }"
              :data-testid="`suggest-item-${index}`"
              @mousedown.prevent="acceptSuggestion(cmd)"
              @mouseenter="suggestIndex = index"
            >
              <span class="suggest-typed">{{ composer }}</span
              ><span class="suggest-rest">{{ cmd.slice(composer.length) }}</span>
              <span v-if="hintFor(cmd)" class="suggest-desc">{{ hintFor(cmd) }}</span>
            </div>
          </div>
          <!-- Inline ghost-text completion behind the input. When the first token
               is a command, the input text is transparent and this mirror colours
               only the command green, leaving the arguments normal. -->
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
            :placeholder="
              editTarget
                ? `Describe the change for ${editTarget}…`
                : liveSession
                  ? `Send a message to ${sendTo}…`
                  : 'Start a session first'
            "
            :disabled="!liveSession && !editTarget"
            spellcheck="false"
            autocomplete="off"
            @input="onComposerInput"
            @keydown="onComposerKeydown"
          ></textarea>
        </div>
        <span class="to mono" data-testid="composer-to">to {{ sendTo }}</span>
        <button
          v-if="!editTarget"
          class="queue-btn mono"
          data-testid="composer-queue"
          title="Add to the queue — runs after the current goal finishes"
          :disabled="composer.trim().length === 0"
          @click="enqueue()"
        >
          + Queue
        </button>
        <button
          class="send-btn mono"
          data-testid="composer-send"
          :disabled="(!liveSession && !editTarget) || busy || composer.trim().length === 0"
          @click="send()"
        >
          Send ⏎
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}

.head {
  padding: 14px 22px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.main-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.mt {
  padding: 9px 13px;
  font-size: 11.5px;
  color: var(--text-tab);
  cursor: pointer;
  display: flex;
  gap: 6px;
  align-items: center;
  background: transparent;
}

.mt:hover {
  color: var(--text-body);
}

.mt.sel {
  color: var(--text-strong);
  box-shadow: inset 0 -2px 0 var(--green);
}

.mt-badge {
  font-size: 10px;
  color: var(--text-meta);
  background: var(--bg-chip);
  border: 1px solid var(--border-strong);
  border-radius: 99px;
  padding: 0 6px;
  line-height: 15px;
}

.head-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.h-dot {
  width: 10px;
  min-width: 10px;
  height: 10px;
}

.h-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  white-space: nowrap;
}

.h-path {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.segments {
  display: flex;
  flex-shrink: 0;
  white-space: nowrap;
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  overflow: hidden;
  font-size: 11px;
}

.seg {
  padding: 5px 12px;
  color: var(--text-tab);
  cursor: pointer;
}

.seg:hover {
  color: var(--text-body);
}

.seg.on {
  background: var(--bg-seg);
  color: var(--text-strong);
  cursor: default;
}

.ctl {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  padding: 5px 12px;
}

.ctl:hover {
  color: var(--text-body);
}

.pill.agents-pill {
  color: var(--blue);
  border: 1px solid rgba(58, 98, 145, 0.3);
}

.pill.bypass-pill {
  color: var(--red);
  border: 1px solid rgba(143, 59, 44, 0.35);
}

/* REFS row (design): chips + dashed add pill under the meta line. */
/* REFS row (design): floats just above the composer, overlapping the bottom of
   the stream. The container ignores pointer events so the stream stays usable;
   the chips/buttons re-enable them. */
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
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 10.5px;
  color: var(--text-body);
  background: var(--bg-card);
  border: 1px solid var(--surface-line);
  padding: 3px 9px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}

.ref-ico {
  color: var(--green);
}

.ref-x {
  color: var(--text-faint);
  font-size: 10px;
  padding: 0 1px;
}

.ref-x:hover {
  color: var(--red);
}

.ref-add {
  font-size: 10.5px;
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
  padding: 2px 10px;
  background: var(--bg-panel);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}

.ref-add:hover {
  color: var(--green);
  border-color: var(--green);
}

.ref-input {
  width: 300px;
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--green);
  outline: none;
  color: var(--text-strong);
  padding: 3px 9px;
  font-family: var(--sans);
  pointer-events: auto;
}

.ref-error {
  font-size: 10.5px;
  color: var(--red);
  pointer-events: auto;
}

/* Drag-over overlay (design): full-pane dashed frame naming the drop action. */
.session-view {
  position: relative;
}

.drop-overlay {
  position: absolute;
  inset: 6px;
  z-index: 60;
  border: 1px dashed var(--green);
  background: rgba(52, 211, 153, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.drop-box {
  text-align: center;
}

.drop-title {
  font-size: 14px;
  color: var(--green);
}

.drop-sub {
  font-size: 11px;
  color: var(--text-mid);
  margin-top: 5px;
}

.head-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 7px;
  font-size: 11.5px;
  color: var(--text-meta);
  flex-wrap: wrap;
}

.stream-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 80px;
}


.ended {
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 11px 13px;
  margin-bottom: 13px;
}

.ended-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.bypass-inline {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}

.bypass-inline .armed {
  color: var(--red);
}

.load-earlier {
  font-size: 11px;
  color: var(--text-faint);
  cursor: pointer;
  text-align: center;
  margin-bottom: 12px;
}

.load-earlier:hover {
  color: var(--text-mid);
}

/* Agent chat banner (design: ← project │ ● name · subagent). */
.agent-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 9px 12px;
  background: var(--surface-inset);
  border: 1px solid var(--surface-inset-line);
  flex-wrap: wrap;
}

.ab-back {
  font-size: 11px;
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
  font-size: 11px;
  color: var(--blue);
  animation: sbFade 1.6s ease infinite;
}

.ab-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-strong);
}

.ab-chip {
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--border-seg);
  padding: 1px 7px;
  white-space: nowrap;
}

/* Parallel-agents card (design: ⑂ AGENTS · N working in parallel). */
.agents {
  border: 1px solid var(--border-card-alt);
  background: var(--surface-inset);
  padding: 11px 13px;
  margin-top: 6px;
}

.agents-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}

.agents-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--blue);
}

.agents-count {
  font-size: 10px;
  color: var(--text-faint);
}

.agents-rows {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 -6px;
  padding: 4px 6px;
  cursor: pointer;
}

.agent-row:hover {
  background: var(--bg-card);
}

.agent-chat {
  font-size: 10.5px;
  color: var(--green);
  white-space: nowrap;
}

.agent-dot {
  font-size: 11px;
  color: var(--blue);
  animation: sbFade 1.6s ease infinite;
}

.agent-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-body);
  white-space: nowrap;
}

.agent-task {
  flex: 1;
  font-size: 12px;
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
  padding: 16px 22px;
  background: var(--bg-code);
}

.raw-line {
  font-family: var(--mono);
  font-size: 11.8px;
  line-height: 1.75;
  color: var(--text-mid);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Timestamps setting: dim HH:MM gutter to the left of each raw line. */
.raw-line.stamped {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 8px;
}

.raw-stamp {
  font-size: 10px;
  color: var(--text-ghost);
  white-space: nowrap;
}

/* Positioning context for the floating REFS row; base composer chrome is global. */
.composer {
  position: relative;
}

.draft-note {
  font-size: 11px;
  color: var(--amber);
  margin-bottom: 6px;
}

/* "UP NEXT": a horizontal strip of queued-goal chips above the composer. */
.queue {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 18px 0;
}

.queue-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.queue-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--text-body);
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 4px 10px;
  max-width: 280px;
}

.queue-num {
  color: var(--text-faint);
}

.queue-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-x {
  cursor: pointer;
  color: var(--text-faint);
  font-size: 11px;
}

.queue-x:hover {
  color: var(--red);
}

.queue-note {
  font-size: 10.5px;
  color: var(--text-ghost);
}

.queue-btn {
  flex-shrink: 0;
  white-space: nowrap;
  border: 1px solid var(--border-seg);
  color: var(--text-tab);
  font-size: 11px;
  padding: 7px 12px;
  border-radius: 10px;
}

.queue-btn:hover:not(:disabled) {
  color: var(--text-body);
}

.queue-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.caret {
  flex-shrink: 0;
  color: var(--green);
  font-weight: 700;
}

.caret.target {
  color: var(--amber);
}

/* Spec-edit target chip in the composer (design ✎ → file). */
.target-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 10.5px;
  color: var(--green);
  background: rgba(52, 211, 153, 0.07);
  border: 1px solid rgba(52, 211, 153, 0.35);
  border-radius: 10px;
  padding: 3px 9px;
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

.input-wrap {
  position: relative;
  flex: 1;
  min-width: 60px;
  display: flex;
}

/* Sits above the ghost-text overlay; base composer-input chrome is global. */
/* Auto-growing multi-line composer (base transparent/borderless chrome is
   global). CSS field-sizing grows it with content up to max-height, then it
   scrolls. */
.composer-input {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  resize: none;
  overflow-y: auto;
  field-sizing: content;
  max-height: 160px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Typed text exactly matches a known /command — tint it so the match is clear. */
/* First token is a command: hide the input's own text (keep the caret) and let
   the ghost mirror colour the command green while the arguments stay normal. */
.composer-input.is-command {
  color: transparent;
  caret-color: var(--text);
}

.ghost-cmd {
  color: var(--green);
}

.ghost-args {
  color: var(--text);
}

/* Extra bottom room so the live "working" line clears the floating REFS row. */
.stream {
  padding-bottom: 46px;
}

/* Inline ghost text: mirrors the input box exactly, typed part transparent,
   remainder greyed, sitting directly under the live caret. */
.ghost {
  position: absolute;
  inset: 0;
  z-index: 0;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  pointer-events: none;
}

.ghost-typed {
  color: transparent;
}

.ghost-rest {
  color: var(--text-ghost);
}

/* Suggestion dropdown, opening upward like a terminal completion menu. */
.suggest-list {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 190px;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 4px;
  z-index: 5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.suggest-item {
  font-size: 12.5px;
  padding: 5px 8px;
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.suggest-item.active {
  background: var(--bg-active);
}

.suggest-typed {
  color: var(--text);
  font-weight: 600;
}

.suggest-rest {
  color: var(--text-mid);
}

/* Small what-it-does explanation next to a suggested /command. */
.suggest-desc {
  margin-left: 12px;
  float: right;
  color: var(--text-faint);
  font-size: 10.5px;
  max-width: 55%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

</style>
