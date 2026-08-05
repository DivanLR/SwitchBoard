<script lang="ts">
// Unsent composer text kept per project for the app's lifetime, so switching
// projects (or opening another view) never loses what you typed. Module-level
// so it survives this component unmounting/remounting. In-memory only — distinct
// from the persisted `drafts` table, which holds undelivered *queued* sends.
// ponytail: in-memory Map; add DB persistence only if drafts must survive restart.
const composerDrafts = new Map<string, string>()
</script>

<script setup lang="ts">
// Session stream — 1:1 with the design reference: two-row header (identity,
// status pill, clean/raw segments, meta line), clean stream with swallowed
// blocks and a live status line, dark raw log, and the ❯ composer bar
// (FR-014..019a, R2 resume).
import { computed, nextTick, onMounted, onUnmounted, onWatcherCleanup, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { agentIdOf } from '@shared/domain'
import type { SessionEvent } from '@shared/domain'
import type { CleanupGroup } from '@shared/command-catalog'
import { activeAgents } from '@shared/agents'
import { parseInlineQuestion } from '@shared/inline-question'
import { errorMessage, isIpcError, type ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTranscriptsStore } from '@renderer/stores/transcripts'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import { useProjectRefs } from '@renderer/composables/useProjectRefs'
import { formatTokens as fmtTok, useSessionUsage } from '@renderer/composables/useSessionUsage'
import { useQueuedTasks } from '@renderer/composables/useQueuedTasks'
import { useNow } from '@renderer/composables/useNow'
import { elapsedClock } from '@renderer/relative-time'
import { toRawLines } from '@shared/stream-lines'
import { useSpecsStore } from '@renderer/stores/specs'
import { useDiffStore } from '@renderer/stores/diff'
import { accentFor } from '@renderer/project-accent'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import SwallowedBlock from '@renderer/components/SwallowedBlock.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import SpecsView from '@renderer/views/SpecsView.vue'
import CleanupView from '@renderer/views/CleanupView.vue'
import TestsView from '@renderer/views/TestsView.vue'
import DiffView from '@renderer/views/DiffView.vue'

const props = defineProps<{ project: ProjectListItem }>()
const emit = defineEmits<{ (e: 'open-proj-settings'): void }>()

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const settingsStore = useSettingsStore()
const specs = useSpecsStore()
const diff = useDiffStore()

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

// Main-area tab: the live session stream, the project's Spec Kit specs, the
// verification section, the working-tree diff, or the review/cleanup command
// launcher.
const mainTab = ref<'session' | 'specs' | 'tests' | 'diff' | 'cleanup'>('session')
const specCount = computed(() => specs.stateFor(props.project.id).specs.length)
const diffCount = computed(() => diff.resultFor(props.project.id).files.length)

const composer = ref('')
// Spec-edit target (design ✎ chip): when set, the composer rewrites this spec
// file/section instead of chatting. Set by SpecsView's Refine actions.
const editTarget = ref<string | null>(null)
const draftRestored = ref(false)
const busy = ref(false)
// Ended-banner restart option: start the next session with all permissions
// bypassed (--dangerously-skip-permissions), mirroring the New session dialog.
const bypassRestart = ref(false)
/** Ended-banner restart option: start the next session read-only, planning first. */
const planRestart = ref(false)
/** Session-start failure (e.g. Docker down for a bypass session), ended banner. */
const startError = ref<string | null>(null)
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
const now = useNow(1000)

// Ctrl+C stop-confirm: the first Ctrl+C (composer focused, session working)
// shows a confirmation above the input; a second Ctrl+C (or the Stop button)
// actually interrupts. Auto-dismisses so a stray press never lingers.
const stopConfirm = ref(false)
let stopConfirmTimer: ReturnType<typeof setTimeout> | undefined

function askStop(): void {
  stopConfirm.value = true
  clearTimeout(stopConfirmTimer)
  stopConfirmTimer = setTimeout(() => (stopConfirm.value = false), 4000)
}
function cancelStop(): void {
  stopConfirm.value = false
  clearTimeout(stopConfirmTimer)
}
async function confirmStop(): Promise<void> {
  cancelStop()
  await interrupt()
}

// Ctrl+C only acts when the COMPOSER is focused (elsewhere it's a normal copy).
// If text is selected it copies as usual; otherwise it opens the stop-confirm.
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && stopConfirm.value) {
    cancelStop()
    return
  }
  if (!event.ctrlKey || (event.key !== 'c' && event.key !== 'C') || event.altKey || event.metaKey) {
    return
  }
  if (document.activeElement !== composerEl.value) return // must be in the text box
  const selection = window.getSelection()?.toString() ?? ''
  if (selection.length > 0) return // preserve copy of a selection
  if (!liveSession.value || liveSession.value.status !== 'working') return
  event.preventDefault()
  if (stopConfirm.value) void confirmStop()
  else askStop()
}

let unsubscribeCommands: (() => void) | undefined
onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  // Which transcripts are still in temp, so the start panel can offer to carry
  // the last one. Expired files are swept by the main process on every read.
  void transcripts.refresh()
  // A session's init message delivers its slash commands / skills after start;
  // pick them up live so a newly-added project's suggestions load without a
  // project switch.
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
})
onUnmounted(() => {
  clearTimeout(stopConfirmTimer)
  window.removeEventListener('keydown', onGlobalKeydown)
  unsubscribeCommands?.()
  // Opening another view (MCP, no selection) unmounts us without firing the
  // project-switch watcher — save the draft here so it survives the round-trip.
  composerDrafts.set(props.project.id, composer.value)
})

const sessionTimer = computed(() =>
  liveSession.value ? elapsedClock(liveSession.value.startedAt, now.value) : null,
)

/**
 * The run's id, quoted short the way a commit hash is. Eight characters is
 * enough to name one run in conversation or to match this pane against a log
 * line; the header keeps the full id on its title attribute rather than
 * spending header width on it.
 */
const sessionStamp = computed(() => {
  const id = liveSession.value?.id ?? endedSession.value?.id ?? null
  return id ? { short: id.slice(0, 8), full: id } : null
})

// Subagents still working this turn — listed under the live line (goal: see
// the agents when multiple are running).
const workingAgents = computed(() =>
  liveSession.value?.status === 'working' ? activeAgents(active.events) : [],
)

// Live background tasks (deep-research workflows, backgrounded subagents/bash).
const backgroundTasks = computed(() => liveSession.value?.backgroundTasks ?? [])

// Summaries produced WHILE background work runs are interim noise — record their
// ids so they stay hidden even after the tasks drain (only the final,
// post-settle summary renders). Cleared when the session changes.
const interimSummaries = ref<Set<string>>(new Set())
watch(
  [() => active.events.length, backgroundTasks],
  () => {
    if (backgroundTasks.value.length === 0) return
    for (const event of active.events) {
      if (event.kind === 'summary') interimSummaries.value.add(event.id)
    }
  },
)

// Cap how many parallel agents / background tasks are shown at once so a big
// fan-out doesn't fill the pane; a toggle expands to all and collapses back.
//
// The state is shared through one helper rather than two hand-copied ref/computed
// pairs. The MARKUP stays written out twice on purpose: a shared component would
// need six props and a slot to cover two uses that differ in four data-testids
// and their whole row content, which is more machinery than the repetition costs.
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

/** What the composer invites: a spec edit, a message, or nothing yet. */
const composerPlaceholder = computed(() => {
  if (editTarget.value) return `Describe the change for ${editTarget.value}…`
  return liveSession.value ? `Send a message to ${sendTo.value}…` : 'Start a session first'
})

/** Nothing to send. Both buttons ask the same question, so they ask it once. */
const composerEmpty = computed(() => composer.value.trim().length === 0)

// The header's usage strip: rate-limit meter, prompt-cache hit rate, per-model
// totals. All reported figures, never estimates (see the composable).
const {
  usagePct,
  usageColor,
  usageLimitLabel,
  cacheHitPct,
  cacheColor,
  sessionUsage,
  currentModelLabel,
} = useSessionUsage(liveSession)

/** The full view = exactly what /usage reports, rendered as the ✦ USAGE card. */
async function openFullUsage(): Promise<void> {
  if (!liveSession.value) return
  mainTab.value = 'session'
  await active.send('/usage')
  scrollToBottom()
}

watch(
  () => liveSession.value?.id ?? null,
  async (sessionId) => {
    interimSummaries.value = new Set() // reset per session
    // A session can be superseded while its history is still loading (starting a
    // session, switching project, a restart). Everything after the await touches
    // the COMPOSER, so an unguarded late callback restores one session's draft
    // over another's, then scrolls a stream that has already moved on.
    let superseded = false
    onWatcherCleanup(() => {
      superseded = true
    })
    await active.open(sessionId)
    if (superseded) return
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

/**
 * How many raw events the clean and raw views derive from: a tail window, not the
 * whole session.
 *
 * Measured, deriving over the full history: 5.0 ms of scripting per incoming event
 * at 200 events, 6.4 at 1000, 14.0 at 3000, 41.7 at 6000 — because BOTH passes
 * (scopedEvents, then items) re-scanned every event from the start, and the render
 * then threw all but the last MAX_RENDER items away. Past roughly 3000 events each
 * arriving event cost more than a frame, on a stream whose whole job is to keep up
 * with output. The DOM was never the problem: node count was already flat at ~2004
 * thanks to MAX_RENDER.
 *
 * Generous on purpose: 1500 raw events to produce 500 rendered items leaves room
 * for grouping and filtering to collapse a lot, and `showEarlier` widens it before
 * falling back to the store.
 */
const DERIVE_WINDOW = 1500
const deriveWindow = ref(DERIVE_WINDOW)

watch(
  () => props.project.id,
  (projectId, prevId) => {
    // Stash the project we're leaving, restore the one we're entering, so unsent
    // composer text is preserved across switches instead of being wiped.
    if (prevId) composerDrafts.set(prevId, composer.value)
    composer.value = composerDrafts.get(projectId) ?? ''
    draftRestored.value = false
    mainTab.value = 'session'
    editTarget.value = null
    // Per-project, both of these: a start failure from the project we left must
    // not read as this one's, and an armed bypass toggle must never carry over
    // and silently start the NEXT project's session with permissions skipped.
    startError.value = null
    busy.value = false
    bypassRestart.value = false
    // Also per-project: this component instance is reused across projects, so an
    // armed "press Ctrl+C again to stop" left over from the project being left
    // would otherwise sit above the composer of the project being entered, where
    // a second Ctrl+C means to stop a session the developer never asked about.
    cancelStop()
    // Per-project too: a window widened by paging through one long session must
    // not carry into the next project and derive over its whole history.
    deriveWindow.value = DERIVE_WINDOW
    resetSuggestions()
    void loadHistory(projectId)
    void specs.loadState(projectId)
    void diff.loadList(projectId)
    void queue.load(projectId)
  },
  { immediate: true },
)

// Diff tab refresh: the same turn-complete cadence that already refreshes the
// header's +adds/−dels counter (session-manager.ts observeBranch) re-derives
// the per-file list too. A same-project refresh leaves the current selection
// alone (see stores/diff.ts) so a session that keeps working doesn't yank the
// developer's open diff out from under them.
//
// liveSession's id is watched too, and separately from diffAdds/diffDels:
// starting a session on an already-open project changes neither counter (both
// stay null until the first turn completes), so without this the tab would
// sit on its pre-session "not live" read until then. The same id transition
// covers ending a session, so a stale list doesn't linger once liveSession
// drops to null.
watch(
  [
    () => liveSession.value?.diffAdds ?? null,
    () => liveSession.value?.diffDels ?? null,
    () => liveSession.value?.id ?? null,
  ],
  () => {
    void diff.loadList(props.project.id)
  },
)

// The bypass toggle follows whatever session the banner is offering to resume:
// a bypass session's transcript lives in that project's container volume, so
// resuming it as a native session would look on the host and find nothing (and
// the reverse). Declared after the project watcher so it wins on a switch.
watch(
  () => endedSession.value?.id ?? null,
  (id) => {
    if (!id) return
    bypassRestart.value = endedSession.value?.bypassPermissions ?? false
    // How the last one began, not where it ended up: a session that was toggled
    // out of plan mode mid-flight still started as one, and offering that again
    // is the choice the developer actually made.
    planRestart.value = endedSession.value?.planMode ?? false
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
const derivedFrom = computed<SessionEvent[]>(() => {
  const all = active.events
  if (all.length <= deriveWindow.value) return all
  let start = all.length - deriveWindow.value
  // Back up to a natural block boundary (an event that is not noise) so the oldest
  // visible block is a whole run rather than the tail of one that began before the
  // window. Bounded, so a long unbroken run of noise cannot walk this to the start.
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
    // Clean view narrative: subagents are represented by the AGENTS card, never
    // as raw tool rows; other tool activity (commands being run) shows unless the
    // "Show tool activity" setting is off. The raw view always keeps everything.
    if (event.kind === 'tool_activity') {
      const toolName = (event.payload as { toolName?: string }).toolName
      if (toolName === 'Task' || toolName === 'Agent') continue
      if (!outputPrefs.value.showToolRows) continue
    }
    // Interim summaries (posted while background work ran) stay hidden in the
    // clean view — only turn-complete lines show during a run, then the single
    // consolidated summary after it settles. The raw view keeps everything.
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
  if (renderStart.value > 0) return
  // Widen before reaching for the store: what the developer is asking for may
  // already be in memory and merely outside the derivation window.
  if (deriveWindow.value < active.events.length) {
    deriveWindow.value += DERIVE_WINDOW
    return
  }
  if (active.hasMoreHistory) void active.loadEarlier()
}

// --- Raw view: complete session output as mono lines (FR-018) ---
// The per-kind formatting is pure, so it lives in stream-lines.ts with its own
// tests; this is only the reactive wrapper around it.
const rawLines = computed(() => toRawLines(derivedFrom.value, outputPrefs.value.timestamps))

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
      active.clearFocusEvent()
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

// A Cleanup card's slash command, or an eval line's check / manual-pass prompt,
// goes straight to the session; output lands in the Session tab, so switch there
// to watch it run.
function runInSession(text: string): void {
  mainTab.value = 'session'
  void specs.runInSession(props.project.id, text)
}

/** A child tab reports it dispatched something: show the stream and follow it. */
function onRanInSession(): void {
  mainTab.value = 'session'
  scrollToBottom()
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
      mainTab.value = 'session' // watch the edit run
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
  await addQueued(text)
  composer.value = ''
  resetSuggestions()
}

// --- Transcripts ---
// Every session writes one continuously in the main process, so a crash leaves a
// file behind; these two are the manual half: save one now, and carry the last
// one into the next session as context.
const transcripts = useTranscriptsStore()
const carryTranscript = ref(false)
const savingTranscript = ref(false)

/** The newest unexpired transcript for this project, if one is still in temp. */
const lastTranscript = computed(() => transcripts.latestFor(props.project.id))

async function saveTranscript(): Promise<void> {
  const id = liveSession.value?.id ?? endedSession.value?.id
  if (!id) return
  savingTranscript.value = true
  try {
    await transcripts.save(id)
  } finally {
    savingTranscript.value = false
  }
}

async function start(resume: boolean): Promise<void> {
  // This view is reused across projects and a bypass start can take minutes
  // (first-run image build), so the call is pinned to the project it was made
  // for — otherwise its result lands on whichever project is on screen when it
  // finally settles.
  const target = props.project.id
  busy.value = true
  startError.value = null
  try {
    await projects.startSession(
      target,
      resume,
      // The restart toggles override the project's mode for this one session.
      // Neither ticked sends nothing, so the project's own setting applies —
      // which is why this is undefined rather than a default.
      bypassRestart.value ? 'bypass' : planRestart.value ? 'plan' : undefined,
      carryTranscript.value ? (lastTranscript.value?.sessionId ?? undefined) : undefined,
    )
  } catch (e) {
    // Docker down / not logged in (bypass sessions run containerised) — show
    // it in the ended banner instead of dying as an unhandled rejection.
    if (props.project.id === target) startError.value = isIpcError(e) ? e.message : String(e)
  } finally {
    if (props.project.id === target) busy.value = false
  }
}

// Ctrl+C, like a terminal (the design has no interrupt button).
async function interrupt(): Promise<void> {
  await active.interrupt()
}

// End the session outright (distinct from Ctrl+C, which only interrupts the turn).
// Stopping can take a few seconds (SDK drain, container teardown), so the End
// button shows an indeterminate bar until the session row flips to ended. Keyed
// by project id because this view is reused across projects.
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

// Inline question card: when the LATEST message is a plain-text question with
// an options table (Spec Kit's /speckit-clarify idiom), offer clickable chips
// + a type-your-own input. Answering sends a normal message; the card vanishes
// once a newer prompt lands.
// Locally retires a just-answered card so a double-click can't send twice
// before the echoed prompt event lands and hides it for good.
const inlineAnswered = ref<string | null>(null)

const inlineQuestion = computed(() => {
  if (!liveSession.value || liveSession.value.status === 'working') return null
  const events = scopedEvents.value
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind === 'prompt') return null // already answered
    if (event.kind === 'assistant_text' || event.kind === 'summary') {
      if (event.id === inlineAnswered.value) return null
      const text = (event.payload as { text?: string }).text ?? ''
      const payload = parseInlineQuestion(text)
      return payload ? { eventId: event.id, payload } : null
    }
    // tool rows / markers / results between the question and now don't matter
  }
  return null
})

function onInlineAnswer(eventId: string, choice: string): void {
  inlineAnswered.value = eventId
  // The ★ Recommended marker is display convention — send the bare option.
  const text = choice.replace(/\s*\(recommended\)\s*$/i, '')
  // In a subagent's chat view the answer goes to that agent, like the composer.
  const agent = selectedAgent.value
  if (agent) void active.send(`[to ${agent.name}] ${text}`, agent.id)
  else void active.send(text)
}

function openInbox(requestId: string): void {
  inbox.focusRequest(requestId)
}

/** Queued-message edit. Empty text withdraws it, as in the UP NEXT queue. */
const queuedEditError = ref('')
async function editQueued(eventId: string, text: string): Promise<void> {
  queuedEditError.value = ''
  try {
    await active.editQueued(eventId, text)
  } catch (error) {
    // The turn can finish mid-edit and deliver the message. Say so rather than
    // failing quietly: the developer would otherwise believe they changed what ran.
    queuedEditError.value = errorMessage(error, 'That message could not be changed')
  }
}

// A file dropped on this project's sidebar row lands here as @path text.
watch(
  () => active.composerInsert,
  (text) => {
    if (!text) return
    composer.value = composer.value ? `${composer.value} ${text}` : text
    active.clearComposerInsert()
    composerEl.value?.focus()
  },
)

// REFS row and the pane's drop target (design): folders this project's sessions
// may read, typed or dragged in. A dropped FILE is the one case that is not a
// reference — its path goes to the composer, which this view owns.
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

// UP NEXT strip: planned tasks, editable in place.
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
        <!-- Indicator and control in one: it reads the mode the CLI reports, and
             clicking it asks for the other. Hidden on a bypass session, which
             approves everything and so has nothing to plan against. -->
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
          {{ liveSession.inPlanMode ? '◱ Planning' : '◱ Plan' }}
        </button>
        <!-- Stated before the agent is asked for a diff, not discovered mid-task:
             the container mounts only this folder, so git works there exactly
             when .git sits at the project root. -->
        <span
          v-if="liveSession?.bypassPermissions && project.gitNotice"
          class="pill nogit-pill"
          data-testid="nogit-pill"
          :title="project.gitNotice"
        >
          ⚠ No git
        </span>
        <span
          v-if="workingAgents.length > 1"
          class="pill agents-pill"
          data-testid="agents-pill"
        >
          ⑂ {{ workingAgents.length }} agents
        </span>
        <span
          v-if="backgroundTasks.length > 0"
          class="pill bg-pill"
          data-testid="bg-pill"
          title="Background tasks running"
        >
          ⧗ {{ backgroundTasks.length }} background
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
          <!-- The binding is real (onGlobalKeydown), so the control names it
               rather than hiding it in a tooltip. -->
          <kbd class="ctl-key">⌃C</kbd>
        </button>
        <!-- The transcript is written continuously anyway; this is for the moment
             before something risky, when you want the file on disk now. -->
        <!-- A glyph, not a label: the header row is the tightest strip in the app,
             and spelling this one out truncated the project name beside it. -->
        <button
          v-if="liveSession || endedSession"
          class="ctl mono ctl-glyph"
          data-testid="save-transcript"
          title="Write this session's transcript to a temporary file (expires in 12 hours)"
          aria-label="Save transcript"
          :disabled="savingTranscript"
          @click="saveTranscript()"
        >
          ⤓
        </button>
        <button
          v-if="liveSession"
          class="ctl mono"
          data-testid="end-session"
          title="End the session (resumable later)"
          :disabled="ending"
          @click="stop()"
        >
          {{ ending ? 'Ending' : 'End' }}
        </button>
        <!-- The window is blocked for the whole teardown, but lightly: the work
             stays visible behind a veil and one strip low on the window carries the
             state, so ending a session never hides where you were. Teleported to the
             body so no ancestor of this header can clip it. `ending` spans the whole
             stop: sessions.stop resolves in main only once the SDK has drained and
             the container is down, and this unmounts with liveSession either way. -->
        <Teleport to="body">
          <div
            v-if="ending"
            class="end-veil"
            data-testid="ending-overlay"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div class="end-strip">
              <span class="end-eyebrow">Ending {{ project.name }}</span>
              <span class="end-rule" data-testid="ending-bar"></span>
            </div>
          </div>
        </Teleport>
        <button
          class="ctl mono"
          data-testid="open-proj-settings"
          title="Project settings"
          @click="emit('open-proj-settings')"
        >
          ⚙
        </button>
        <div class="segments mono" data-testid="view-toggle" role="tablist" aria-label="Stream view">
          <button
            type="button"
            class="seg"
            :class="{ on: active.view === 'clean' }"
            data-testid="view-clean"
            role="tab"
            :aria-selected="active.view === 'clean'"
            @click="switchView('clean')"
          >
            Clean
          </button>
          <button
            type="button"
            class="seg"
            :class="{ on: active.view === 'raw' }"
            data-testid="view-raw"
            role="tab"
            :aria-selected="active.view === 'raw'"
            @click="switchView('raw')"
          >
            Raw
          </button>
        </div>
      </div>
      <div class="head-meta mono">
        <span style="white-space: nowrap">⎇ {{ liveSession?.branch ?? endedSession?.branch ?? '—' }}</span>
        <span
          v-if="currentModelLabel"
          data-testid="session-model"
          style="color: var(--text-faint); white-space: nowrap"
        >
          {{ currentModelLabel }}
        </span>
        <span
          v-if="liveSession?.currentMode"
          class="mode-chip"
          data-testid="session-mode"
          :title="
            liveSession.currentMode === 'advisor'
              ? 'Advisor mode: cheap model executing, strong model consulted at decision points'
              : 'Orchestrator mode: strong model planning, cheap workers executing in parallel'
          "
        >
          {{ liveSession.currentMode === 'advisor' ? '⚖ Advisor' : '⧉ Orchestrator' }}
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
          <span :style="{ color: cacheColor }">{{ cacheHitPct }}%</span>
        </span>
        <button
          v-if="sessionUsage"
          class="usage-widget mono"
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
        <!-- The run's own id, quoted short the way a commit is. It is what you
             need when you are naming one specific run, or matching this pane
             against a log; the full id sits on the title. -->
        <span
          v-if="sessionStamp"
          class="head-stamp"
          data-testid="session-stamp"
          :title="sessionStamp.full"
        >
          #{{ sessionStamp.short }}
        </span>
        <!-- Where a manual save landed. The path is the point: it is what you hand
             to anything outside this app, so it is shown rather than announced. -->
        <button
          v-if="transcripts.lastSavedPath"
          class="head-stamp saved-path"
          data-testid="transcript-saved"
          :title="`${transcripts.lastSavedPath} — click to dismiss`"
          @click="transcripts.clearLastSaved()"
        >
          ⤓ {{ transcripts.lastSavedPath }}
        </button>
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

    <!-- Session / Specs / Tests / Cleanup tabs -->
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
        :class="{ sel: mainTab === 'tests' }"
        data-testid="tab-tests"
        @click="mainTab = 'tests'"
      >
        Tests
      </button>
      <button class="mt" :class="{ sel: mainTab === 'diff' }" data-testid="tab-diff" @click="mainTab = 'diff'">
        Diff
        <span v-if="diffCount > 0" class="mt-badge">{{ diffCount }}</span>
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

    <SpecsView
      v-if="mainTab === 'specs'"
      :project-id="project.id"
      @set-target="onSetTarget"
      @ran="onRanInSession"
    />
    <TestsView
      v-else-if="mainTab === 'tests'"
      :project-id="project.id"
      :project-name="project.name"
      :branch="liveSession?.branch ?? endedSession?.branch ?? null"
      @run="runInSession"
      @ran="onRanInSession"
    />
    <DiffView v-else-if="mainTab === 'diff'" :project-id="project.id" />
    <CleanupView
      v-else-if="mainTab === 'cleanup'"
      :project-name="project.name"
      :available="availableCommandNames"
      @run="runInSession"
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
          <button
            type="button"
            class="ab-back"
            data-testid="agent-back"
            :aria-label="`Back to ${project.name}`"
            @click="active.selectAgent(null)"
          >
            ← {{ project.name }}
          </button>
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
                class="switch"
                :class="{ on: planRestart }"
                data-testid="plan-restart-toggle"
                role="switch"
                :aria-checked="planRestart"
                title="Start read-only: research first, then a plan you approve in the inbox"
                @click="planRestart = !planRestart; if (planRestart) bypassRestart = false"
              >
                <span class="knob"></span>
              </button>
              <span>Plan first</span>
            </span>
            <span class="bypass-inline mono">
              <button
                class="switch danger"
                :class="{ on: bypassRestart }"
                data-testid="bypass-restart-toggle"
                role="switch"
                :aria-checked="bypassRestart"
                title="Start with all permissions bypassed (--dangerously-skip-permissions)"
                @click="bypassRestart = !bypassRestart; if (bypassRestart) planRestart = false"
              >
                <span class="knob"></span>
              </button>
              <span :class="{ armed: bypassRestart }">Bypass permissions</span>
            </span>
            <!-- Only when a transcript is actually still in temp: an offer to carry
                 context that has expired would be a lie about what the new session
                 will know. -->
            <span v-if="lastTranscript" class="bypass-inline mono">
              <button
                class="switch"
                :class="{ on: carryTranscript }"
                data-testid="carry-transcript-toggle"
                role="switch"
                :aria-checked="carryTranscript"
                :title="`Seed the new session with the previous one's transcript — ${lastTranscript.prompts} prompts, saved ${lastTranscript.savedAt.slice(11, 16)}`"
                @click="carryTranscript = !carryTranscript"
              >
                <span class="knob"></span>
              </button>
              <span>Carry last transcript</span>
            </span>
          </div>
          <div v-if="startError" class="mono" style="color: var(--red)" data-testid="start-error">
            ✗ {{ startError }}
          </div>
        </div>

        <button
          v-if="renderStart > 0 || deriveWindow < active.events.length || active.hasMoreHistory"
          type="button"
          class="load-earlier mono"
          @click="showEarlier()"
        >
          ▴ show earlier activity
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

        <!-- Inline question card: clarify-style options asked in plain text -->
        <QuestionEvent
          v-if="inlineQuestion"
          :event-id="inlineQuestion.eventId"
          :payload="inlineQuestion.payload"
          data-testid="inline-question"
          @answer="onInlineAnswer"
        />

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
            <span style="flex: 1"></span>
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
              class="agent-row"
              data-testid="agent-row"
              :aria-label="`Open ${agent.name}'s chat`"
              @click="active.selectAgent(agent.id)"
            >
              <span class="agent-dot">●</span>
              <span class="agent-name">{{ agent.name }}</span>
              <span class="agent-task">{{ agent.task || agent.label }}</span>
              <span class="agent-chat">chat →</span>
            </button>
            <div
              v-if="!agentsExpanded && workingAgents.length > SHOW_LIMIT"
              class="agents-more"
              data-testid="agents-more"
              @click="agentsExpanded = true"
            >
              + {{ workingAgents.length - SHOW_LIMIT }} more
            </div>
          </div>
        </div>

        <!-- Live status line. role=status (an implicit aria-live="polite") so a
             screen reader announces the session changing state; the session's
             status is the one thing in this app that changes without the user
             doing anything, and silence there is the whole product failing. -->
        <div
          v-else-if="liveSession?.status === 'working'"
          class="live mono"
          data-testid="live-line"
          role="status"
        >
          <span class="blink" style="color: var(--green)" aria-hidden="true">▊</span>
          {{ liveSession.statusDetail || 'Working…' }}
        </div>
        <!-- assertive, not polite: this one means the session has stopped and is
             waiting on the human, so it should interrupt rather than queue. -->
        <div
          v-else-if="liveSession?.status === 'needs_you'"
          class="live live-blocked mono"
          data-testid="live-line"
          role="alert"
        >
          <span class="blink" aria-hidden="true">▊</span>
          Blocked — {{ pendingCount > 0 ? `${pendingCount} pending` : 'needs your answer' }}
        </div>

        <!-- Background tasks: deep-research workflows / backgrounded work still
             running while the main loop continues. Independent of the live-line
             chain so it can show alongside any status. -->
        <div
          v-if="backgroundTasks.length > 0"
          class="agents bg-tasks mono"
          data-testid="bg-task-list"
        >
          <div class="agents-head">
            <span class="agents-label bg">⧗ BACKGROUND</span>
            <span class="agents-count">{{ backgroundTasks.length }} running</span>
            <span style="flex: 1"></span>
            <button
              v-if="backgroundTasks.length > SHOW_LIMIT"
              class="agents-toggle"
              data-testid="bg-task-toggle"
              @click="tasksExpanded = !tasksExpanded"
            >
              {{ tasksExpanded ? 'show fewer' : `show all ${backgroundTasks.length}` }}
            </button>
          </div>
          <div class="agents-rows">
            <div
              v-for="task in shownTasks"
              :key="task.taskId"
              class="agent-row bg-row"
              data-testid="bg-task-row"
            >
              <span class="agent-dot bg">◷</span>
              <span class="agent-task">{{ task.description || task.taskId }}</span>
            </div>
            <div
              v-if="!tasksExpanded && backgroundTasks.length > SHOW_LIMIT"
              class="agents-more"
              data-testid="bg-task-more"
              @click="tasksExpanded = true"
            >
              + {{ backgroundTasks.length - SHOW_LIMIT }} more
            </div>
          </div>
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
          <!-- Enter saves, Escape abandons, and leaving the field saves too: the
               edit is one line of text, so a dialog would be heavier than the
               thing being changed. -->
          <input
            v-if="editingQueued === task.id"
            v-model="queuedDraft"
            class="queue-edit mono"
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
            ✕
          </button>
        </span>
        <span class="queue-note">Runs automatically when the current goal finishes</span>
      </div>
      <div v-if="queuedEditError" class="queued-edit-error mono" data-testid="queued-edit-error">
        {{ queuedEditError }}
      </div>
      <div v-if="draftRestored && composer" class="draft-note" data-testid="draft-note">
        Restored draft from the previous run — send to deliver it.
      </div>

      <!-- Ctrl+C stop confirmation, floating just above the input. -->
      <div v-if="stopConfirm" class="stop-confirm mono" data-testid="stop-confirm">
        <span class="sc-text">⏹ Ctrl+C again to stop the chat — are you sure?</span>
        <button class="sc-stop" data-testid="stop-confirm-yes" @click="confirmStop()">Stop</button>
        <button class="sc-cancel" data-testid="stop-confirm-no" @click="cancelStop()">Cancel</button>
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
              <span class="suggest-typed">{{ cmd }}</span>
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
            :placeholder="composerPlaceholder"
            :disabled="!liveSession && !editTarget"
            spellcheck="false"
            autocomplete="off"
            @input="onComposerInput"
            @keydown="onComposerKeydown"
            @scroll="onComposerScroll"
          ></textarea>
        </div>
        <span class="to mono" data-testid="composer-to">to {{ sendTo }}</span>
        <button
          v-if="!editTarget"
          class="queue-btn mono"
          data-testid="composer-queue"
          title="Add to the queue — runs after the current goal finishes"
          :disabled="composerEmpty"
          @click="enqueue()"
        >
          + Queue
        </button>
        <button
          class="send-btn mono"
          data-testid="composer-send"
          :disabled="(!liveSession && !editTarget) || busy || composerEmpty"
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
  position: relative; /* anchors the drop-overlay */
}

.head {
  padding: 14px 22px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
}

.main-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
}

/* Tabs name places, so they take the label idiom rather than reading as prose.
   One voice across every tab strip in the app: these, the view segments below,
   the inbox's pane tabs, the Tests sub-tabs and the Specs part tabs. */
.mt {
  padding: 9px 13px;
  font-size: 11.5px;
  letter-spacing: var(--track-label);
  text-transform: uppercase;
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
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  border-radius: var(--rp);
  padding: 0 6px;
  line-height: 15px;
}

/* 10px, not 12px. The name and path both truncate, so the row's true floor is its
   unshrinkable right-hand group: two pills, the transcript glyph, End, the gear
   and the CLEAN/RAW segments. At the window's 1080px minimum that group overran
   the pane by 15px, and eight gaps at 2px less than before is more than enough to
   pay for it without removing a control or narrowing the label voice. */
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.h-dot {
  width: 10px;
  min-width: 10px;
  height: 10px;
}

.h-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
  /* The same treatment .h-path already has, right beside it. Without min-width: 0
     a nowrap flex child cannot shrink below its text, so a long project name — a
     dotted .NET solution folder, say — pushed the branch, pills, Stop, End and the
     settings gear off the end of the row instead of truncating itself. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Both this and .h-path can now shrink, so say which one yields first. The name
     identifies the lane the developer is working in; the path is corroboration and
     is shown in full in the sidebar. Left to the flex default they truncated
     together and the name lost as much as the path. */
  flex-shrink: 1;
}

.h-path {
  font-size: 11px;
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
  font-size: 11px;
}

.seg {
  padding: 5px 12px;
  font-size: 11.5px;
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-tab);
  cursor: pointer;
}

.seg:hover {
  color: var(--text-body);
}

.seg.on {
  background: color-mix(in srgb, var(--green) 24%, transparent);
  color: var(--text-strong);
  cursor: default;
}

.ctl {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 3px 9px;
}

.ctl:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

/* A control whose whole label is one glyph: square, so it reads as a key in the
   row rather than as a word that lost its letters. */
.ctl-glyph {
  min-width: 24px;
  padding: 3px 0;
  text-align: center;
}

.ctl:disabled {
  opacity: 0.7;
  cursor: default;
}

/* Drives the ending overlay's rule, below; the End button no longer carries a bar
   of its own now that the whole window says the session is closing. */
@keyframes ending-slide {
  from {
    background-position: -60% 0;
  }
  to {
    background-position: 160% 0;
  }
}

/* The whole window while a session tears down. Fixed and teleported to the body,
   at 60 so it sits over the dialogues at 40 and under the update banner at 100.
   The veil is the app ground at 82%: enough to say "not now" while leaving the
   work legible behind it. */
.end-veil {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.end-veil::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--bg);
  opacity: 0.82;
}

.end-strip {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
  margin-bottom: 22vh;
  padding: 12px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  box-shadow: var(--shadow-dd);
}

.end-eyebrow {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-meta);
}

/* The teardown's own indeterminate rule, on the animation the End button used to
   carry, so this view has one waiting idiom rather than two. It keeps the
   ending-bar test id: the bar moved off the button, it did not go away. */
.end-rule {
  display: block;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--green), transparent) no-repeat;
  background-size: 45% 100%;
  animation: ending-slide 1.1s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .end-rule {
    animation: none;
    background-size: 100% 100%;
    opacity: 0.45;
  }
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

/* Off, it is an offer, so it stays in neutral ink like any quiet control. On, it
   takes valley blue — the attention-owed hue — because a planning session is
   holding, waiting on the developer to approve what it proposes. */
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

/* Amber, not red: the session works, only git history is absent (hover says why). */
.pill.nogit-pill {
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
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
  background: var(--bg-hover);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
  padding: 3px 9px;
  box-shadow: var(--elev);
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
  font-size: 11px;
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
  font-size: 10.5px;
  color: var(--red);
  pointer-events: auto;
}

/* Drag-over overlay (design): full-pane dashed frame naming the drop action. */
.drop-overlay {
  position: absolute;
  inset: 8px;
  z-index: 40;
  border: 1px dashed var(--green);
  background: color-mix(in srgb, var(--surface-sunken) 88%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.drop-box {
  text-align: center;
}

.drop-title {
  font-size: 13.5px;
  color: var(--green);
}

.drop-sub {
  font-size: 11.5px;
  color: var(--text-meta);
  margin-top: 6px;
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

/* The run's short id: machine truth, so it sits at the ghost tier and never
   competes with the readings beside it. */
.head-stamp {
  font-size: 10.5px;
  color: var(--text-ghost);
  white-space: nowrap;
}

/* The saved transcript's path, in the same ghost register. It is a control only
   so it can be dismissed; it never looks like a button. */
.saved-path {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--green2);
  cursor: pointer;
}

/* Pairing-mode chip (Advisor/Orchestrator) for the latest work turn. */
.mode-chip {
  font-size: 10px;
  color: var(--blue);
  border: 1px solid color-mix(in srgb, var(--blue) 35%, transparent);
  border-radius: var(--rp);
  padding: 1px 8px;
  white-space: nowrap;
}

/* Session usage widget: total tokens + top-2 model chips; click = full /usage. */
.usage-widget {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 10.5px;
  color: var(--text-meta);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 2px 10px;
  cursor: pointer;
  background: transparent;
  white-space: nowrap;
}

.usage-widget:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.uw-total {
  color: var(--text-body);
  font-weight: 600;
}

.uw-cost {
  color: var(--text-faint);
}

.uw-model {
  color: var(--text-tab);
}

.uw-model-tok {
  color: var(--green);
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
  border-radius: var(--rc);
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
  /* display/width because this is a <button> now (it had no keyboard path as a
     div): a button is inline-block, so without these the pager would stop
     spanning the stream and its centred label would sit left. */
  display: block;
  width: 100%;
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
  background: color-mix(in srgb, var(--surface-inset) 55%, transparent);
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
  font-weight: 600;
  color: var(--text-strong);
}

.ab-chip {
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 1px 7px;
  white-space: nowrap;
}

/* Parallel-agents card (design: ⑂ AGENTS · N working in parallel). */
.agents {
  border: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  background: color-mix(in srgb, var(--surface-inset) 55%, transparent);
  border-radius: var(--rc);
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

/* Cap-toggle + "+N more" row for large fan-outs. */
.agents-toggle {
  font-size: 10px;
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
  font-size: 11px;
  color: var(--text-faint);
  cursor: pointer;
  padding: 3px 6px;
}

.agents-more:hover {
  color: var(--green);
}

/* Background-tasks card: amber accent to distinguish from blue subagents. */
.bg-tasks {
  margin-top: 8px;
}

.agents-label.bg {
  color: var(--amber);
}

.agent-dot.bg {
  color: var(--amber);
  animation: sbFade 1.6s ease infinite;
}

.bg-row {
  cursor: default;
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
  /* width so the flex row still spans its container as a <button>. */
  width: 100%;
  margin: 0 -6px;
  padding: 4px 6px;
  text-align: left;
  cursor: pointer;
}

.agent-row:hover {
  background: var(--bg-hover);
  box-shadow: var(--elev);
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
  padding: 16px 22px 52px;
  background: color-mix(in srgb, var(--bg-code) 50%, transparent);
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
  gap: 12px;
  align-items: baseline;
}

.raw-stamp {
  color: var(--text-ghost);
  white-space: nowrap;
}

/* Positioning context for the floating REFS row; base composer chrome is global. */
.composer {
  position: relative;
  box-shadow: var(--hairline-shine);
}

.composer-row {
  align-items: flex-end;
}


/* Ctrl+C stop confirmation bubble above the composer. */
.stop-confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 6px 11px;
  font-size: 11.5px;
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
  border-radius: var(--rc);
  animation: sbIn 0.15s ease;
}

.sc-text {
  flex: 1;
}

.sc-stop {
  font-size: 11px;
  /* Not #fff: white on the light red-pencil correction red measures 2.78:1. --red-ink is the
     token that exists for exactly this, at 6.34:1 — the same fix styles.css
     already applied to .stop-btn:hover. */
  color: var(--red-ink);
  background: var(--red);
  border: none;
  border-radius: var(--rc);
  padding: 3px 12px;
  cursor: pointer;
}

.sc-cancel {
  font-size: 11px;
  color: var(--text-tab);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 3px 12px;
  background: transparent;
  cursor: pointer;
}

.draft-note {
  font-size: 11px;
  color: var(--amber);
  margin-bottom: 6px;
}

/* The turn finished while the editor was open and the message went as typed.
   Red because the developer's intent was not carried out. */
.queued-edit-error {
  font-size: 11px;
  color: var(--red);
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
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
  padding: 4px 10px;
  max-width: 280px;
}

.queue-num {
  color: var(--text-faint);
}

/* A button rather than a span so clicking it to edit is reachable by keyboard and
   announced as an action; the base reset already strips the chrome, so it keeps
   the chip's own type and colour. */
.queue-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  min-width: 0;
}
.queue-text:hover {
  color: var(--text);
  text-decoration: underline dotted;
}

/* Same width as the text it replaces, so opening an edit does not resize the row. */
.queue-edit {
  flex: 1;
  min-width: 120px;
  font-size: 11px;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 1px 5px;
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
  border: 1px solid var(--border-strong);
  color: var(--text-mid);
  font-weight: 600;
  font-size: 11.5px;
  padding: 6px 13px;
  border-radius: var(--rc);
}

.queue-btn:hover:not(:disabled) {
  border-color: var(--green);
  color: var(--text-strong);
}

.queue-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.caret {
  flex-shrink: 0;
  color: var(--green);
  font-weight: 600;
  /* Matches the field's own 3px, so the sigil stays level with the typed line
     now that the line is centred rather than dropped to the row's foot. */
  padding-bottom: 3px;
}

.caret.target {
  /* ✎ (a dingbat) renders higher in its line box than ❯, so it needs less
     bottom lift to land on the composer's baseline. It was 5px below ❯; with ❯
     now at 3px that difference cannot be kept, so it floors here at 0 and sits
     3px below instead. */
  color: var(--amber);
  padding-bottom: 0;
}

/* Spec-edit target chip in the composer (design ✎ → file). */
.target-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 10.5px;
  color: var(--green);
  background: color-mix(in srgb, var(--green) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--green) 35%, transparent);
  border-radius: var(--rc);
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

</style>
