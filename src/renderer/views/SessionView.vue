<script setup lang="ts">
// Session stream — 1:1 with the design reference: two-row header (identity,
// status pill, clean/raw segments, meta line), clean stream with swallowed
// blocks and a live status line, dark raw log, and the ❯ composer bar
// (FR-014..019a, R2 resume).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ResultPayload, SessionEvent } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import { useSpecsStore } from '@renderer/stores/specs'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import SwallowedBlock from '@renderer/components/SwallowedBlock.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import SpecsView from '@renderer/views/SpecsView.vue'

const props = defineProps<{ project: ProjectListItem }>()
const emit = defineEmits<{ (e: 'open-proj-settings'): void }>()

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const settingsStore = useSettingsStore()
const specs = useSpecsStore()

const queuedTasks = computed(() => queue.forProject(props.project.id))

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

// Main-area tab: the live session stream, or the project's Spec Kit specs.
const mainTab = ref<'session' | 'specs'>('session')
const specCount = computed(() => specs.stateFor(props.project.id).specs.length)

const composer = ref('')
const draftRestored = ref(false)
const busy = ref(false)
const streamEl = ref<HTMLElement | null>(null)
const composerEl = ref<HTMLInputElement | null>(null)

// Terminal-style composer suggestions (history + plugin/skill commands, ghost
// text, dropdown, up-arrow recall) live in a dedicated composable.
const {
  suggestions,
  ghostRest,
  suggestIndex,
  acceptSuggestion,
  onComposerInput,
  onComposerKeydown,
  load: loadHistory,
  setCommands: setSuggestionCommands,
  reset: resetSuggestions,
  recordSent,
} = useCommandSuggestions({ composer, composerEl, onSubmit: () => void send() })

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

const usage = computed(() => {
  let cost = 0
  let tokens = 0
  for (const event of active.events) {
    if (event.kind !== 'result') continue
    const payload = event.payload as ResultPayload
    cost += payload.totalCostUsd ?? 0
    tokens += (payload.usage.inputTokens ?? 0) + (payload.usage.outputTokens ?? 0)
  }
  return { cost, tokens }
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

watch(
  () => props.project.id,
  (projectId) => {
    composer.value = ''
    draftRestored.value = false
    mainTab.value = 'session'
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

const items = computed<StreamItem[]>(() => {
  const result: StreamItem[] = []
  let block: { noiseKind: string; events: SessionEvent[] } | null = null
  for (const event of active.events) {
    // Clean view is a readable narrative: tool activity (commands being run)
    // is hidden unless the "Show tool activity" setting is on, in which case
    // it collapses into "worked quietly" rows. The raw view keeps everything.
    if (event.kind === 'tool_activity' && !outputPrefs.value.showToolRows) continue
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
  const p = event.payload as unknown as Record<string, unknown>
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

// Stable keys per raw line (event id + line offset) so streaming updates key
// correctly rather than by array index.
const rawLines = computed(() =>
  active.events.flatMap((event) =>
    rawLinesOf(event).map((text, i) => ({ key: `${event.id}:${i}`, text })),
  ),
)

function scrollToBottom(): void {
  void nextTick(() => {
    if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
  })
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
async function send(): Promise<void> {
  const text = composer.value.trim()
  if (!text || !liveSession.value) return
  busy.value = true
  try {
    await active.send(text)
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

async function start(resume: boolean, bypassPermissions = false): Promise<void> {
  busy.value = true
  try {
    await projects.startSession(props.project.id, resume, bypassPermissions)
  } finally {
    busy.value = false
  }
}

async function interrupt(): Promise<void> {
  await active.interrupt()
}

async function stop(): Promise<void> {
  await active.stop()
  await projects.refresh()
}

function answerQuestion(eventId: string, choice: string): void {
  void active.answerQuestion(eventId, choice)
}

function openInbox(requestId: string): void {
  inbox.focusRequest(requestId)
}
</script>

<template>
  <div class="session-view">
    <!-- Header -->
    <header class="head">
      <div class="head-row">
        <span class="h-name mono" data-testid="session-project-name">{{ project.name }}</span>
        <span class="h-path mono" data-testid="session-project-path">{{ project.path }}</span>
        <span style="flex: 1"></span>
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
            @click="active.setView('clean')"
          >
            Clean
          </div>
          <div
            class="seg"
            :class="{ on: active.view === 'raw' }"
            data-testid="view-raw"
            @click="active.setView('raw')"
          >
            Raw
          </div>
        </div>
        <template v-if="liveSession">
          <button class="ctl mono" data-testid="interrupt-btn" title="Interrupt the current activity" @click="interrupt()">
            Interrupt
          </button>
          <button class="ctl ctl-stop mono" data-testid="stop-btn" title="Stop the session" @click="stop()">
            Stop
          </button>
        </template>
      </div>
      <div class="head-meta mono">
        <span style="white-space: nowrap">⎇ {{ liveSession?.branch ?? endedSession?.branch ?? '—' }}</span>
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
        <span v-if="usage.tokens > 0 || usage.cost > 0" style="color: var(--text-faint); white-space: nowrap">
          {{ Math.round(usage.tokens / 1000) }}k tok ·
          <span style="color: var(--text-meta)">${{ usage.cost.toFixed(2) }}</span>
        </span>
      </div>
    </header>

    <!-- Session / Specs tabs -->
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
    </div>

    <SpecsView v-if="mainTab === 'specs'" :project-id="project.id" />

    <!-- Clean stream -->
    <div
      v-else-if="active.view === 'clean'"
      ref="streamEl"
      class="stream"
      data-testid="stream"
      :style="{ zoom: streamZoom }"
    >
      <div class="stream-inner">
        <div v-if="!liveSession && !endedSession" class="stream-empty">
          <div class="mono faint">No session yet for this project.</div>
          <div class="start-row">
            <button class="btn-solid" data-testid="start-session" :disabled="busy" @click="start(false)">
              Start session
            </button>
            <button
              class="btn-quiet"
              data-testid="start-session-bypass"
              :disabled="busy"
              title="Start with all permission checks bypassed — every tool is auto-approved. Use only in trusted projects."
              @click="start(false, true)"
            >
              Start · bypass permissions
            </button>
          </div>
          <div class="bypass-note mono faint">
            Bypass auto-approves every tool without inbox prompts. Only for folders you fully trust.
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

        <!-- Live status line -->
        <div v-if="liveSession?.status === 'working'" class="live mono" data-testid="live-line">
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
      <div v-for="line in rawLines" :key="line.key" class="raw-line mono" data-testid="raw-line">
        {{ line.text }}
      </div>
    </div>

    <!-- Composer -->
    <footer v-if="mainTab === 'session'" class="composer">
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
        <span class="caret mono">❯</span>
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
            </div>
          </div>
          <!-- Inline ghost-text completion behind the input -->
          <div class="ghost mono" aria-hidden="true">
            <span class="ghost-typed">{{ composer }}</span
            ><span class="ghost-rest" data-testid="ghost-suggestion">{{ ghostRest }}</span>
          </div>
          <input
            ref="composerEl"
            v-model="composer"
            class="composer-input mono"
            data-testid="composer-input"
            :placeholder="liveSession ? `Send a message to ${project.name}…` : 'Start a session first'"
            :disabled="!liveSession"
            spellcheck="false"
            autocomplete="off"
            @input="onComposerInput"
            @keydown="onComposerKeydown"
          />
        </div>
        <span class="to mono">to {{ project.name }}</span>
        <button
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
          :disabled="!liveSession || busy || composer.trim().length === 0"
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
  border-radius: 6px;
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
  border-radius: 6px;
  padding: 5px 12px;
}

.ctl:hover {
  color: var(--text-body);
}

.ctl-stop:hover {
  color: var(--red);
  border-color: rgba(224, 108, 85, 0.5);
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

.stream {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px;
}

.stream-inner {
  max-width: 840px;
}

.stream-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 80px;
}

.start-row {
  display: flex;
  gap: 8px;
}

.bypass-note {
  font-size: 10.5px;
  max-width: 360px;
  text-align: center;
  line-height: 1.5;
}

.ended {
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 11px 13px;
  margin-bottom: 13px;
}

.ended-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
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

.live {
  font-size: 12.5px;
  color: var(--text-meta);
  margin-top: 4px;
}

.live-blocked {
  color: var(--amber);
}

.blink {
  animation: sbBlink 1.1s steps(1) infinite;
}

.raw-view {
  flex: 1;
  overflow-y: auto;
  padding: 16px 22px;
  background: var(--bg-code);
}

.raw-line {
  font-size: 11.8px;
  line-height: 1.75;
  color: #969ca8;
  white-space: pre-wrap;
  word-break: break-word;
}

.composer {
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  padding: 11px 18px;
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
  border-radius: 8px;
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
  border-radius: 6px;
}

.queue-btn:hover:not(:disabled) {
  color: var(--text-body);
}

.queue-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.composer-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.caret {
  flex-shrink: 0;
  color: var(--green);
  font-weight: 700;
}

.input-wrap {
  position: relative;
  flex: 1;
  min-width: 60px;
  display: flex;
}

.composer-input {
  flex: 1;
  min-width: 60px;
  position: relative;
  z-index: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 13px;
  padding: 0;
}

.composer-input:focus {
  outline: none;
}

/* Inline ghost text: mirrors the input box exactly, typed part transparent,
   remainder greyed, sitting directly under the live caret. */
.ghost {
  position: absolute;
  inset: 0;
  z-index: 0;
  font-size: 13px;
  line-height: normal;
  display: flex;
  align-items: center;
  white-space: pre;
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
  border-radius: 8px;
  padding: 4px;
  z-index: 5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.suggest-item {
  font-size: 12.5px;
  padding: 5px 8px;
  border-radius: 5px;
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

.to {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--text-faint);
}

.send-btn {
  flex-shrink: 0;
  white-space: nowrap;
  background: var(--green);
  color: var(--green-ink);
  font-weight: 600;
  font-size: 11.5px;
  padding: 7px 16px;
  border-radius: 6px;
  user-select: none;
}

.send-btn:hover:not(:disabled) {
  background: var(--green-hover);
}

.send-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
