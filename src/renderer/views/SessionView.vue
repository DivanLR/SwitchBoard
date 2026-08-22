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
import type { SectionKind, SessionEvent } from '@shared/domain'
import type { CleanupGroup } from '@shared/command-catalog'
import { DIAGRAM_PLUGIN } from '@shared/diagram'
import { activeAgents } from '@shared/agents'
import { parseInlineQuestion } from '@shared/inline-question'
import type { ProjectListItem } from '@shared/ipc-types'
// Single door for the words describing what came back through the IPC bridge —
// see the re-export comment in ipc.ts. `ProjectListItem` stays imported from
// '@shared/ipc-types' itself: that module owns the wire type, and ipc.ts only
// re-exports `errorMessage`. (`isIpcError` moved out with `start()`, its only
// caller in this file, into useSessionStart — see that composable.)
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
import SpecsView from '@renderer/views/SpecsView.vue'
import CleanupView from '@renderer/views/CleanupView.vue'
import TestsView from '@renderer/views/TestsView.vue'
import DiffView from '@renderer/views/DiffView.vue'
import DiagramsView from '@renderer/views/DiagramsView.vue'
import SkillsView from '@renderer/views/SkillsView.vue'
import SessionWaitOverlay from '@renderer/components/SessionWaitOverlay.vue'

const props = defineProps<{ project: ProjectListItem }>()
/** The Skills section's "Manage skills" link. Settings is owned by App, so the
 *  view asks rather than reaching for it. */
const emit = defineEmits<{ (e: 'open-settings', tab: 'skills'): void }>()

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
const mainTab = ref<'session' | 'specs' | 'tests' | 'diff' | 'cleanup' | 'diagrams' | 'skills'>(
  'session',
)
const specCount = computed(() => specs.stateFor(props.project.id).specs.length)
const diffCount = computed(() => diff.resultFor(props.project.id).files.length)

const composer = ref('')
// Spec-edit target (design ✎ chip): when set, the composer rewrites this spec
// file/section instead of chatting. Set by SpecsView's Refine actions.
const editTarget = ref<string | null>(null)
/**
 * The text restored from a previous run, for as long as the composer still holds
 * exactly it.
 *
 * A boolean could not answer the question the note makes. It said "restored
 * draft" about whatever happened to be in the composer, so clearing the box and
 * typing something of your own kept the note up, now describing text the app had
 * never seen. Holding the restored string means any edit ends the claim, because
 * the claim is about THAT text and is not true of anything else.
 */
const restoredDraft = ref<string | null>(null)
// Ended-banner start controls (mode picker, Resume, container switch, busy,
// start()) live in useSessionStart — see its construction below, deliberately
// placed AFTER the project-switch watcher; the composable's own comment there
// explains why the order cannot be the other way round.
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

const pendingCount = computed(
  () => inbox.pending.filter((p) => p.projectId === props.project.id).length,
)

// Session timer (HH:MM:SS, ticking) and usage figures from loaded result events.
const now = useNow(1000)

// Ctrl+C stop-confirm cluster (composer-focus guard, session-working guard,
// selection guard, Escape dismiss, 4s auto-dismiss) — extracted to its own
// composable; it owns its own keydown listener and cleanup. `interrupt` is a
// hoisted function declaration (defined further down as `async function
// interrupt()`), so referencing it here before its textual line is safe — it is
// only ever CALLED later, once the user actually confirms a stop.
const { stopConfirm, cancelStop, confirmStop } = useStopConfirm({
  composerEl,
  liveSession: () => liveSession.value,
  interrupt: () => interrupt(),
})

let unsubscribeCommands: (() => void) | undefined
onMounted(() => {
  // A session's init message delivers its slash commands / skills after start;
  // pick them up live so a newly-added project's suggestions load without a
  // project switch.
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
})
onUnmounted(() => {
  // The stop-confirm timer/listener and the crash-watch drain both moved into
  // their own composables (useStopConfirm, useSessionStart) — each owns its own
  // onUnmounted now, so doing it again here would be cleaning up twice (the
  // second removeEventListener/clearTimeout would be a harmless no-op, but the
  // point of "own your own cleanup" is that this file no longer needs to know
  // these two things exist to clean up).
  unsubscribeCommands?.()
  // Opening another view (MCP, no selection) unmounts us without firing the
  // project-switch watcher — save the draft here so it survives the round-trip.
  composerDrafts.set(props.project.id, composer.value)
})

const sessionTimer = computed(() =>
  liveSession.value ? elapsedClock(liveSession.value.startedAt, now.value) : null,
)

// Matches the sidebar's clocks: one setting governs both, so the header cannot end
// up ticking while the rows are silent. Defaults to shown before settings load.
const showTimer = computed(() => settingsStore.settings?.showSessionTimer ?? true)

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

// Summaries that arrive WHILE background work runs are interim noise: during a
// fan-out the clean view would otherwise fill with half-finished restatements of a
// turn that has not landed yet. Their ids are recorded here so they can be hidden
// while that run is live.
//
// Hidden while it is live, and no longer. Two earlier versions of this hid more
// than they should have and never gave anything back:
//
//   - the first re-scanned the whole event list on every tick, so the first
//     background task to start retro-marked every summary already in the session,
//     including ones from an hour earlier that had nothing to do with it;
//   - the second stopped that, but still hid the marked ones for the remaining
//     life of the session, so a summary written during a fan-out was gone for
//     good and the developer could not scroll back to what the agent had said.
//
// Interim is a statement about the moment, not about the content. Once the run
// drains, these are simply history, and history renders.
//
// `scanned` is the high-water mark of events already considered. Events are
// append-only and ordered by seq, so everything below it has had its answer.
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
      // The run has drained, so the set empties and everything it was holding back
      // returns to the transcript. This is the half that makes the hiding safe:
      // nothing is suppressed for longer than the work it belonged to.
      interimSummaries.value = new Set()
    }
    // Advanced even when nothing is running, which is the half that fixes it:
    // an event seen while the session was quiet can never be marked later.
    scanned = events.length
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

/**
 * Nothing can be sent from here: the session has ended and this is not an edit.
 *
 * The same expression the textarea and the send button were each testing
 * separately. Named because a third reader now needs it — the composer greys
 * itself out — and three copies of one condition is how the three stop agreeing.
 */
const composerDead = computed(() => !liveSession.value && !editTarget.value)

/** Nothing to send. Both buttons ask the same question, so they ask it once. */
const composerEmpty = computed(() => composer.value.trim().length === 0)

// The header's usage strip: prompt-cache hit rate and per-model totals. All
// reported figures, never estimates (see the composable). The subscription
// rate-limit meter used to sit here too; the SDK's rate_limit_event never
// arrives for this account, so it only ever rendered an em dash.
const { cacheHitPct, cacheColor, sessionUsage, currentModelLabel } = useSessionUsage(liveSession)

/** The full view = exactly what /usage reports, rendered as the ✦ USAGE card. */
async function openFullUsage(): Promise<void> {
  if (!liveSession.value) return
  mainTab.value = 'session'
  await active.send('/usage')
  scrollToBottom()
}

watch(
  // The FOCUSED session, live or ended — not `liveSession`, which is null the
  // moment a session ends.
  //
  // Keyed on liveSession, this called `active.open(null)` for every ended
  // session, and open(null) clears the stream and returns. The consequence was
  // larger than it looks: startup reconciliation ends every session a previous
  // run left open, so after ANY restart the whole board is ended and not one
  // conversation could be read back — while the ended banner sitting on top of
  // the empty stream says "The conversation can be resumed". The events were on
  // disk and `sessions.events` served them the whole time; nothing ever asked.
  () => (liveSession.value ?? endedSession.value)?.id ?? null,
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
    if (restoredDraft.value === null && props.project.drafts.length > 0 && composer.value === '') {
      composer.value = props.project.drafts.map((d) => d.text).join('\n')
      restoredDraft.value = composer.value
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

// Whether the transcript window follows the tail; false once the developer pages
// back. Declared up here with the window it governs because the project watcher
// below resets it and runs `immediate`, so a declaration further down would be in
// its temporal dead zone and the component would not mount at all. See the render
// window near `MAX_RENDER` for what it is actually for.
const followTail = ref(true)

// Forward-declared, assigned right after this watcher (see the comment beside
// that assignment for why it has to be this way round): the project watcher
// below needs to call the composable's `reset()` on every switch, but the
// composable's OWN internal ended-session watcher has to be registered AFTER
// this watcher so it runs second and wins (see useSessionStart.ts). A `const`
// declared after this point could not be referenced inside this watcher's own
// body without a TDZ error even though the reference only ever fires later;
// `let`, declared first and assigned second, sidesteps that. On this
// component's very first mount the immediate call below runs before the
// assignment has happened, so `sessionStart` is still undefined there and the
// optional call is a no-op — harmless, because useSessionStart seeds its own
// refs with the same values `reset()` would have produced.
let sessionStart: ReturnType<typeof useSessionStart> | undefined

watch(
  () => props.project.id,
  (projectId, prevId) => {
    // Stash the project we're leaving, restore the one we're entering, so unsent
    // composer text is preserved across switches instead of being wiped.
    if (prevId) composerDrafts.set(prevId, composer.value)
    composer.value = composerDrafts.get(projectId) ?? ''
    restoredDraft.value = null
    mainTab.value = 'session'
    editTarget.value = null
    // Per-project: a start failure from the project we left must not read as
    // this one's, and a chosen mode must never carry over and silently start
    // the NEXT project's session with permissions skipped. Delegated to
    // useSessionStart's own reset() — see the forward-declaration above.
    sessionStart?.reset()
    // Also per-project: this component instance is reused across projects, so an
    // armed "press Ctrl+C again to stop" left over from the project being left
    // would otherwise sit above the composer of the project being entered, where
    // a second Ctrl+C means to stop a session the developer never asked about.
    cancelStop()
    // Per-project too: a window widened by paging through one long session must
    // not carry into the next project and derive over its whole history. Following
    // resumes with it, so the next project opens on its latest output.
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

// Diff tab refresh: the same cadence that refreshes the header's +adds/−dels
// counter (session-manager.ts observeBranch) re-derives the per-file list too.
// A same-project refresh keeps the current selection (stores/diff.ts).
//
// liveSession's id is watched separately from diffAdds/diffDels because both
// counters stay null until the first turn completes — without it the tab would
// sit on its pre-session "not live" read, and starting/ending a session
// wouldn't refresh it.
//
// Skipped while the Diff tab is closed, taken once when it opens instead: each
// refresh costs two git processes over the whole working tree, and a busy
// session completes a turn every few seconds — wasted on a list nobody is
// looking at most of the time.
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

// Opening the tab pays for the refresh the guard above skipped — costs the
// list read, nothing visibly changes since selection is kept (see above).
watch(mainTab, (tab) => {
  if (tab === 'diff') void diff.loadList(props.project.id)
})

// The ended-session start controls: mode picker, Resume switch, container
// switch, start()/watchForImmediateCrash(). Constructed HERE and not earlier —
// its own internal "prefill mode from the ended session" watcher must be
// registered after the project watcher above so it wins on a project switch
// (see the forward-declared `sessionStart` and its comment). This is also
// where the original file declared that watcher, so nothing else's relative
// order shifts.
sessionStart = useSessionStart({
  project: () => props.project,
  endedSession,
})
const {
  startMode,
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

// `followTail` (declared with `deriveWindow` above) is the whole fix for the worst
// thing this view did: the watcher below used to recompute the start from the END
// of the list on every arriving event, so history paged in by `showEarlier` was
// thrown straight back out by the next token. On a working session that made
// anything above the fold unreachable. The developer would page back to a summary
// they wanted to re-read and watch it leave again as the agent kept talking.
//
// Nothing turns following back on within a session, on purpose. The alternative is
// scroll-position tracking to guess when the developer has returned to the bottom,
// and a wrong guess there deletes their history all over again.
watch(
  () => items.value.length,
  (length) => {
    const tail = Math.max(0, length - MAX_RENDER)
    if (followTail.value) {
      renderStart.value = tail
      return
    }
    // Pinned, but never past the end: switching sessions shortens the list under
    // a start index that was valid for the longer one.
    if (renderStart.value > length) renderStart.value = tail
  },
)
const visibleItems = computed(() => items.value.slice(renderStart.value))

// Paging back also has to hold the DERIVATION open. `derived` slices the last
// `deriveWindow` events, so on a session still producing output the front of that
// slice walks forward and silently eats the history the developer just paged in —
// the same bug as above, one layer down, and slower to notice because it needs a
// flood to show up. Growing the window costs derivation time on a long session,
// which is the trade the developer implicitly accepted by asking to read back.
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

/**
 * Whether the stream is parked at its newest line.
 *
 * Drives the jump-to-latest button, and only that: autoscroll keeps its own
 * threshold below, because the two questions are different. Autoscroll asks "may
 * I move the view under you", and answers generously at 160px so a line arriving
 * mid-read does not yank the page. This asks "are you already at the bottom",
 * where anything but a few pixels of slack would leave the button showing when
 * there is nowhere to go.
 */
const atBottom = ref(true)

function onStreamScroll(): void {
  const el = streamEl.value
  atBottom.value = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

// A short stream has no scrollback, so the button must not appear on a session
// with three lines in it. Re-checked when the content changes, not only on
// scroll, because content arriving is what turns a short stream into a long one.
watch([() => active.events.length, () => active.view, () => liveSession.value?.id, mainTab], () =>
  void nextTick(onStreamScroll),
)

// Clean/Raw toggle re-pins to the newest line — the two views have separate
// scroll containers, so switching would otherwise land wherever the other was.
function switchView(view: 'clean' | 'raw'): void {
  active.setView(view)
  scrollToBottom()
}

// Coming BACK to the conversation lands on its newest line, for the same reason
// the Clean/Raw toggle does. The stream is a v-else-if, so leaving the tab
// unmounts it and returning mounts a fresh element scrolled to zero: the top of
// a long session, which is the least useful place to be put and reads as having
// lost your place. Always the bottom, not a remembered offset — the whole point
// of coming back is what arrived while you were away.
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

/**
 * Naming the focused session, in the developer's own words.
 *
 * `null` means the field is closed; a string means it is open and holding an
 * edit in progress, which is why the empty string has to be a valid open state
 * and cannot double as "closed". Saving an empty one clears the stored name and
 * the derived one takes over again, so there is no second control for undoing it.
 */
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

/**
 * Another session in this project, started from the header.
 *
 * Deliberately the project's own defaults and nothing else — no mode picker, no
 * resume. The full start controls already exist on an ended session's panel; this
 * is the one-click case, for a developer who wants a second conversation going in
 * the same checkout while the first is busy.
 */
function startAnother(): void {
  void projects.startSession(props.project.id)
}

/** The project's container switch. Uncontrolled input read back from the event:
 *  the store writes the project optimistically and re-reads on failure, so the
 *  box follows the stored fact rather than holding a second copy of it. */
function onContainersToggle(e: Event): void {
  void projects.setUseContainers(props.project.id, (e.target as HTMLInputElement).checked)
}

/**
 * The command palette's grouping and match highlighting.
 *
 * Grouped by the plugin that ships each command, which is what a namespaced name
 * already encodes: `/ponytail:ponytail-review` belongs under PONYTAIL, a bare
 * `/init` under COMMANDS. With fifty commands matching a single slash, an
 * unlabelled list is a wall; the labels are the difference between scanning and
 * reading. Follows the pinned reference (design.dev command palette), which
 * groups results under uppercase section labels.
 *
 * Each row carries its FLAT index, because keyboard navigation still walks the
 * one-dimensional `suggestions` array that `suggestIndex` indexes. Grouping is a
 * presentation of that array, never a second source of truth for it.
 */
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

/** The `/token` being typed, so the palette can show which part of each row
 *  actually matched. Read off the composer rather than threaded out of the
 *  composable: it is a presentation concern and nothing else needs it. */
const typedToken = computed<string>(() => {
  const match = /(?:^|\s)\/([^\s]*)$/.exec(composer.value)
  return match ? match[1].toLowerCase() : ''
})

/** A command split around the matched run, for highlighting. Case-insensitive
 *  and substring, matching how the suggestions themselves were filtered; a
 *  highlight that disagreed with the filter would be worse than none. */
function matchParts(cmd: string): { before: string; hit: string; after: string } {
  const token = typedToken.value
  if (token === '') return { before: cmd, hit: '', after: '' }
  const at = cmd.toLowerCase().indexOf(token)
  if (at === -1) return { before: cmd, hit: '', after: '' }
  return { before: cmd.slice(0, at), hit: cmd.slice(at, at + token.length), after: cmd.slice(at + token.length) }
}

// --- Actions ---
// A Refine action in SpecsView sets a spec-edit target. Stay on the Specs tab
// (the composer footer is shared across tabs) and focus it, so the developer can
// type the change in place instead of being pulled back to the session stream.
function onSetTarget(label: string): void {
  editTarget.value = label
  void nextTick(() => composerEl.value?.focus())
}

/**
 * A section asked for work: it goes to the background session, not the chat.
 *
 * This is what Cleanup's rows and the Tests section's manual pass emit into. The
 * tab no longer switches, because the Session tab shows the conversation and the
 * work is no longer in it; the store's refresh surfaces the background session
 * as its own sidebar row, which is where the output is read.
 */
/**
 * The session each section last dispatched to, so that section can show its
 * own output. Keyed by section: the sections no longer share one background
 * session, so one shared id would have pointed the Cleanup terminal at
 * whichever drawing happened to run most recently.
 */
const sectionSessionIds = ref<Partial<Record<SectionKind, string>>>({})

function runInSection(text: string, kind: SectionKind): void {
  void specs.runInSession(props.project.id, text, true, false, kind).then((id) => {
    sectionSessionIds.value = { ...sectionSessionIds.value, [kind]: id }
  })
}

/**
 * A plugin's own slash command, in its section's own session like anything else.
 *
 * This used to run in the CONVERSATION. A containerised session's ~/.claude was
 * a volume with the credentials copied in and nothing else, so a command detected
 * in the project's live session and sent to the container came back "Unknown
 * command: /diagram-design:export-diagram" — true of the environment it arrived
 * in and nothing to do with the developer. The sandbox mounts the host's
 * ~/.claude/plugins read-only as of 0.20.0 (see pluginsPath in wslc-sandbox), and
 * a section session is native unless the project asks for containers at all, so
 * both ways out of that hole are now open and the output can land where the
 * developer asked from instead of in the middle of their conversation.
 */
function runPluginCommand(text: string, kind: SectionKind, watchDiagrams = false): void {
  void specs.runInSession(props.project.id, text, true, watchDiagrams, kind).then((id) => {
    sectionSessionIds.value = { ...sectionSessionIds.value, [kind]: id }
  })
}

/**
 * A diagram command: a plugin command that may WRITE something.
 *
 * The same dispatch as any other plugin command, with one extra fact told to the
 * main process — this turn may leave a diagram behind, so announce the folder
 * when it ends. Without it the Generate button's drawings appeared the instant
 * they landed and a command's did not appear at all until some later, unrelated
 * load: two routes to the same folder behaving differently, which is exactly the
 * kind of difference nobody can guess at from the outside.
 */
function runDiagramCommand(text: string): void {
  runPluginCommand(text, 'diagram', true)
}

/**
 * A child tab reports it dispatched something. Same reasoning as runInSection
 * above — no tab switch; the dispatch surfaces as its own sidebar row.
 */
function onRanInSection(): void {
  scrollToBottom()
}

/**
 * "Download to project" installs the plugin on the host, through the CLI's own
 * subcommands, and waits for the answer.
 *
 * This used to send `/plugin marketplace add …` then `/plugin install …` to a
 * background session as two chat messages. That could not work: `/plugin` is an
 * interactive CLI command an Agent SDK session answers with "isn't available in
 * this environment", and the two messages went to two SEPARATE containers on a
 * project with no prior background work, so the marketplace was registered in
 * one throwaway home and the install ran in another. Neither failure was
 * visible, because nothing caught the rejection and nothing showed a result.
 *
 * `installing` is the plugin id currently being fetched, so the row that was
 * clicked is the row that shows it.
 */
const installing = ref<string | null>(null)
const installError = ref<string | null>(null)

async function installPlugin(marketplace: string, pkg: string): Promise<void> {
  if (installing.value) return
  installing.value = pkg
  installError.value = null
  try {
    const commands = await projects.installPlugin(props.project.id, marketplace, pkg)
    // The freshly installed commands, so the install card can retire itself
    // instead of waiting for a session that may not be running to notice.
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

// start(), watchForImmediateCrash() and the pendingCrashWatches it fills now
// live in useSessionStart — see its construction above. `start` is destructured
// from that composable's return and used directly by the template's
// start-session button.

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
    <!-- The project header and the tab strip below both stand down when a section
         has the whole window. Hiding the strip means the section owns the way
         back, which is why the section renders an exit control of its own. -->
    <header v-if="!active.fullScreenSection" class="head">
      <div class="head-row">
        <span class="h-dot" :style="{ background: headerColor }"></span>
        <span class="h-name mono" data-testid="session-project-name">{{ project.name }}</span>
        <span class="h-path code" data-testid="session-project-path">{{ project.path }}</span>
        <span class="spacer"></span>
        <span
          v-if="liveSession?.bypassPermissions"
          class="pill bypass-pill"
          data-testid="bypass-pill"
          title="Started with --dangerously-skip-permissions"
        >
          <Icon name="warning" :size="12" /> Bypass
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
          <Icon name="panel" :size="12" /> {{ liveSession.inPlanMode ? 'Planning' : 'Plan' }}
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
          <Icon name="warning" :size="12" /> No git
        </span>
        <!-- The setting is read at spawn, so a toggle flipped mid-session changes
             nothing until the next start. Without this pill that is invisible, and
             invisible is indistinguishable from broken. -->
        <span
          v-if="liveSession?.heavySubagents"
          class="pill fanout-pill"
          data-testid="fanout-pill"
          title="Started with Heavy subagents on: this session is told to split work across as many subagents as it can. Changing the setting applies from the next session."
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
        <!-- One question, asked once, for the whole project: does its work run in
             a container? It governs every section's session (specs, tests, diff
             comments, cleanup, diagrams) AND what the start controls below offer
             a chat session, because it is the same question each time. Read at
             spawn, so it applies from the next session.

             Labelled WSL, not Docker: the runtime is wslc, which ships inside WSL
             (see wslc-sandbox.ts). Naming it is not pedantry, because it is what
             the developer has to have installed for the box to do anything. -->
        <label class="wsl-check mono" data-testid="project-containers">
          <input
            type="checkbox"
            data-testid="project-containers-input"
            :checked="project.useContainers"
            :title="
              project.useContainers
                ? 'This project runs its work inside WSL containers: the project folder is mounted, nothing else is. Slower to start, and only two containers may run at once machine-wide.'
                : 'This project runs its work on this machine. Tick to run it inside WSL containers instead: isolated from the rest of your drive, slower to start, two at a time. Needs WSL 2.9.3 or newer.'
            "
            @change="onContainersToggle"
          />
          WSL
        </label>
        <button
          class="ctl mono"
          data-testid="new-session"
          title="Start another session in this project, on its own defaults"
          :disabled="projects.starting"
          @click="startAnother()"
        >
          + Session
        </button>
        <!-- No interrupt button and no transcript glyph here. Both appeared only
             mid-turn or mid-session, so the row reflowed under the developer while
             they were reading it. Ctrl+C still interrupts (onGlobalKeydown, and the
             status bar names the binding), and the main process writes every
             session's transcript continuously without being asked. -->
        <!-- Stop the turn in flight. Restored after 0.16.0 removed it: the action
             still existed, but only as Ctrl+C, and only while the composer had
             focus, with nothing on screen saying so. It interrupts the TURN and
             leaves the session open, which is what End beside it does not do.
             The binding is real, so the control names it rather than hiding it
             in a tooltip. -->
        <button
          v-if="liveSession?.status === 'working'"
          class="stop-btn mono"
          data-testid="stop-session"
          aria-label="Interrupt the current turn"
          title="Interrupt the current turn (Ctrl+C)"
          @click="interrupt()"
        >
          <!-- A red block and nothing else. The ⌃C key cap beside it spelled out
               a binding the status bar already names, and put two glyphs in a
               control whose whole job is to be the one obvious thing to hit when
               a turn is running away. The binding still works; the tooltip and
               the status bar still say so. -->
          <span class="stop-block" aria-hidden="true"></span>
        </button>
        <button
          v-if="liveSession"
          class="ctl mono"
          data-testid="end-session"
          title="End the session (resumable later)"
          :disabled="ending"
          @click="stop()"
        >
          {{ ending ? 'Ending…' : 'End session' }}
        </button>
        <!-- Ending blocks the window for the whole teardown, and looks exactly
             like starting one does: same wait, same screen. `ending` spans the
             whole stop — sessions.stop resolves in main only once the SDK has
             drained and the container is down, and this unmounts with
             liveSession either way. -->
        <SessionWaitOverlay
          v-if="ending"
          testid="ending-overlay"
          :title="`Ending ${project.name}…`"
          sub="Draining the session and tearing its container down."
          ring-testid="ending-bar"
        />
      </div>
      <div class="head-meta mono">
        <!-- The session's name, edited in place. It is the first thing on the
             row because it is the one fact that tells two sessions of the same
             project apart — every one of them runs against the same checkout,
             so the branch beside it is identical on all of them. Untyped, it
             shows whatever the app derived from the work. -->
        <input
          v-if="nameDraft !== null"
          ref="nameInputEl"
          v-model="nameDraft"
          class="name-input mono"
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
        <span style="white-space: nowrap"><Icon name="branch" :size="12" /> {{ liveSession?.branch ?? endedSession?.branch ?? '—' }}</span>
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
          <Icon :name="liveSession.currentMode === 'advisor' ? 'scales' : 'layers'" :size="12" />
          {{ liveSession.currentMode === 'advisor' ? 'Advisor' : 'Orchestrator' }}
        </span>
        <span
          v-if="liveSession && liveSession.diffAdds != null"
          data-testid="diff-stats"
          style="white-space: nowrap"
        >
          <span style="color: var(--green)">+{{ liveSession.diffAdds }}</span>
          <span style="color: var(--red)"> −{{ liveSession.diffDels ?? 0 }}</span>
        </span>
        <span
          v-if="sessionTimer && showTimer"
          style="color: var(--text-faint); white-space: nowrap"
        >
          session <span style="color: var(--text-meta)">{{ sessionTimer }}</span>
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
        <!-- The run's short id — see sessionStamp above for why; the full id sits
             on the title. -->
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

    <!-- Drag-over overlay (design): dashed frame naming the drop action -->
    <div v-if="dragKind" class="drop-overlay mono" data-testid="drop-overlay">
      <div class="drop-box">
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

    <div v-if="!active.fullScreenSection" class="main-tabs mono">
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
      <button
        class="mt"
        :class="{ sel: mainTab === 'diagrams' }"
        data-testid="tab-diagrams"
        @click="mainTab = 'diagrams'"
      >
        Diagrams
      </button>
      <!-- The developer's own imported skills. Last on the rule because it is the
           only section whose contents they supply themselves; the five before it
           are the app's own. -->
      <button
        class="mt"
        :class="{ sel: mainTab === 'skills' }"
        data-testid="tab-skills"
        @click="mainTab = 'skills'"
      >
        Skills
      </button>
      <!-- Clean/Raw belongs on this rule, not in the header above it. It switches
           how THE STREAM is drawn, so it sits with the tabs that choose what the
           pane shows, right-aligned on the same seam — and it only exists while
           the stream does. In the header it rode beside End and the status pill,
           which are about the session's life, and it stayed on screen on Specs,
           Tests and Diff, where there is no stream for it to switch. -->
      <div
        v-if="mainTab === 'session'"
        class="segments mono"
        data-testid="view-toggle"
        role="tablist"
        aria-label="Stream view"
      >
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
      @run="(text: string) => runInSection(text, 'tests')"
      @ran="onRanInSection"
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
    <!-- No @ran: a diagram is drawn in a background session, so asking for one
         does not take you to the conversation. The tab you are on is where the
         answer arrives. -->
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

    <!-- Clean stream (an open agent chat always renders clean) -->
    <div
      v-else-if="active.view === 'clean' || selectedAgent"
      ref="streamEl"
      class="stream"
      data-testid="stream"
      :style="{ zoom: streamZoom }"
      @scroll.passive="onStreamScroll"
    >
      <div class="stream-inner">
        <div v-if="selectedAgent" class="agent-banner mono" data-testid="agent-banner">
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
          <span class="ab-chip">subagent</span>
          <span class="spacer"></span>
        </div>

        <div v-if="!liveSession && !endedSession" class="stream-empty">
          <div class="mono faint" data-testid="no-session-hint">
            No session yet — press + in the sidebar and point New session at this folder.
          </div>
        </div>

        <div v-if="endedSession" class="ended" data-testid="ended-banner">
          <div class="mono" style="font-size: var(--fs-ui); color: var(--text-mid)">
            Session ended <span class="faint">({{ endedSession.endReason ?? 'unknown' }})</span>
            <span v-if="endedSession.statusDetail" class="faint"> — {{ endedSession.statusDetail }}</span>
          </div>
          <div class="ended-actions">
            <!-- Mode first, then whether to carry the conversation, then Start. It
                 reads as one sentence: run it LIKE THIS, PICKING UP where we left
                 off, GO. Every mode the SDK has is here, each carrying its own
                 description on the row and on hover. -->
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
                <span class="mode-dd-name mono">{{ startModeLabel }}</span>
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
                  <span class="mode-item-name mono">{{ m.label }}</span>
                  <span class="mode-item-detail">{{ m.detail }}</span>
                </button>
                <!-- Said where the choice is made, not discovered after a start
                     that quietly found no transcript. -->
                <div v-if="resumeSession" class="mode-note">
                  Resuming keeps the last session's sandbox: its transcript lives
                  {{ endedSession.bypassPermissions ? 'inside the container' : 'on this machine' }},
                  so only matching modes are offered.
                </div>
              </div>
            </div>

            <span class="bypass-inline mono">
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

            <!-- The SAME project setting as the WSL box in the header, not a
                 per-start toggle. It used to be one: a local ref that reset to off
                 on every mount, so flipping it affected exactly the next start and
                 nothing else. It now writes Project.useContainers, which is what
                 makes "one checkbox" true, and that means flipping it here also
                 decides where this project's specs, tests, diff comments, cleanup
                 and diagrams run from now on. The label has to say so, or the
                 control lies about its own blast radius. -->
            <span class="bypass-inline mono">
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
                    : 'The same setting as the WSL box in the header, for the whole project: every session and every section run goes into a WSL container. Your project folder is mounted, nothing else is. Slower to start, only two containers at once, and it needs WSL 2.9.3 or newer.'
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
          <!-- Bypass used to arm a red switch that sat on this row whether or not
               the picker was open, so "nothing will ask you" was ambient. A closed
               dropdown says it once, in small type, and then hides it. Stated in
               full instead, the same sentence the new-project dialogue uses, so the
               one mode that skips every approval never depends on a colour. -->
          <div
            v-if="startMode === 'bypass'"
            class="bypass-warn"
            data-testid="bypass-warning"
          >
            <Icon name="warning" :size="12" /> Nothing will ask for approval — only use this in throwaway or fully trusted folders.
          </div>
          <div v-if="startError" class="mono" style="color: var(--red)" data-testid="start-error">
            <Icon name="cross" :size="12" /> {{ startError }}
          </div>
        </div>

        <button
          v-if="renderStart > 0 || deriveWindow < active.events.length || active.hasMoreHistory"
          type="button"
          class="load-earlier mono"
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

        <!-- Inline question card: clarify-style options asked in plain text -->
        <QuestionEvent
          v-if="inlineQuestion"
          :event-id="inlineQuestion.eventId"
          :payload="inlineQuestion.payload"
          data-testid="inline-question"
          @answer="onInlineAnswer"
        />

        <div v-if="selectedAgent" class="live mono" data-testid="live-line">
          <span class="blink" style="color: var(--green)">▊</span>
          {{ selectedAgent.task || selectedAgent.label }}
        </div>

        <!-- Subagents working in parallel (design: replaces the live line) -->
        <div v-else-if="workingAgents.length > 1" class="agents mono" data-testid="agent-list">
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
              class="agent-row"
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
              @click="agentsExpanded = true"
            >
              <Icon name="plus" :size="11" /> {{ workingAgents.length - SHOW_LIMIT }} more
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
          </div>
          <div class="agents-rows">
            <div
              v-for="task in shownTasks"
              :key="task.taskId"
              class="agent-row bg-row"
              data-testid="bg-task-row"
            >
              <span class="agent-dot bg"><Icon name="clock" :size="8" /></span>
              <span class="agent-task">{{ task.description || task.taskId }}</span>
            </div>
            <div
              v-if="!tasksExpanded && backgroundTasks.length > SHOW_LIMIT"
              class="agents-more"
              data-testid="bg-task-more"
              @click="tasksExpanded = true"
            >
              <Icon name="plus" :size="11" /> {{ backgroundTasks.length - SHOW_LIMIT }} more
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else ref="streamEl" class="raw-view" data-testid="stream" :style="{ zoom: streamZoom }" @scroll.passive="onStreamScroll">
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

    <!-- The composer belongs to the SESSION tab and is hidden on the others: a
             field for talking to the session has no business under a diff. The one
             exception is a spec-edit target, because Specs Refine sets one and then
             expects this field to type it into; hiding it unconditionally would
             delete that flow rather than tidy it. -->
        <footer
          v-if="mainTab === 'session' || editTarget"
          class="composer"
          :class="{ dead: composerDead }"
          :data-testid="composerDead ? 'composer-dead' : 'composer-live'"
        >
      <!-- Jump to the newest line. Anchored to the composer rather than to the
           stream, because the stream is the scrolling box: anything absolute
           inside it scrolls away with the content. The composer is the fixed
           thing directly under it, so hanging the button off its top edge keeps
           it in the stream's bottom-right corner however tall the composer
           grows. Shown only when there is somewhere to go. -->
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
          <span class="ref-ico"><Icon name="external" :size="12" /></span>
          <span class="ref-name">{{ r.label }}</span>
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
            <Icon name="close" :size="11" />
          </button>
        </span>
        <span class="queue-note">Runs automatically when the current goal finishes</span>
      </div>
      <div v-if="queuedEditError" class="queued-edit-error mono" data-testid="queued-edit-error">
        {{ queuedEditError }}
      </div>
      <div v-if="restoredDraft !== null && composer === restoredDraft" class="draft-float" data-testid="draft-note">
        Restored draft from the previous run — send to deliver it.
      </div>

      <div v-if="stopConfirm" class="stop-confirm mono" data-testid="stop-confirm">
        <span class="sc-text"><Icon name="stop" :size="12" /> Ctrl+C again to stop the chat — are you sure?</span>
        <button class="sc-stop" data-testid="stop-confirm-yes" @click="confirmStop()">Stop</button>
        <button class="sc-cancel" data-testid="stop-confirm-no" @click="cancelStop()">Cancel</button>
      </div>

      <div class="composer-row">
        <span v-if="editTarget" class="caret target mono"><Icon name="pencil" :size="12" /></span>
        <span v-else class="caret mono"><Icon name="chevron-right" :size="14" /></span>
        <span
          v-if="editTarget"
          class="target-chip mono"
          data-testid="composer-target"
          title="Spec edit target — your message rewrites this file"
        >
          <Icon name="arrow-right" :size="11" /> {{ editTarget }}
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
              <!-- One label per plugin. Uppercase and small, per the reference:
                   it has to name the group without competing with the commands. -->
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
                <!-- The matched run carries the accent. It is the one thing on the
                     row that answers "why is this here". -->
                <span class="suggest-typed"
                  >{{ matchParts(row.cmd).before
                  }}<span class="suggest-hit">{{ matchParts(row.cmd).hit }}</span
                  >{{ matchParts(row.cmd).after }}</span
                >
                <span v-if="hintFor(row.cmd)" class="suggest-desc">{{ hintFor(row.cmd) }}</span>
              </div>
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
            :disabled="composerDead"
            spellcheck="false"
            autocomplete="off"
            @input="onComposerInput"
            @keydown="onComposerKeydown"
            @scroll="onComposerScroll"
          ></textarea>
        </div>
        <span class="to-inline mono" data-testid="composer-to">to {{ sendTo }}</span>
        <button
          v-if="!editTarget"
          class="queue-btn mono"
          data-testid="composer-queue"
          title="Add to the queue — runs after the current goal finishes"
          :disabled="composerEmpty"
          @click="enqueue()"
        >
          <Icon name="plus" :size="11" /> Queue
        </button>
        <button
          class="send-btn mono"
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
/* THE COMPOSER FOOTER. Reworked in live mode: shorter, with the restored-draft
   note lifted out of the flow so it costs no height, and confined to the Session
   tab. Accepted variant: density, tight padding, meta line kept.

   Selectors are semantic. The live accept splices the chosen markup in and drops
   its data-impeccable-* attributes, so any rule keyed to those matches nothing
   the moment it lands. */
/* IN FLOW, as the composer's first row, so the floating REFS row sits above it
   rather than under it. It was absolute for two rounds to save the footer a row
   of height; the owner asked for REFS on top, and REFS itself floats at
   bottom: 100%, so the only way to sit beneath it is to stop floating. The cost
   is one row, and only while a restored draft actually exists. */
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

/* Inline, so the send target no longer needs a rule of its own under the field. */
/* The 8px padding-bottom that used to sit here was a nudge to fake alignment
   against the row's flex-end, and it is gone: styles.css now gives every
   control in this row one shared height so their centres agree without any
   per-control compensation. */
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
  font-size: var(--fs-meta);
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
  font-size: var(--fs-micro);
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
  font-size: var(--fs-head);
  font-weight: var(--w-em);
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
  /* Pushed to the far end of the tab rule and centred on it. The tabs claim the
     rule's full height so their underline lands on the seam; a bordered control
     cannot, so it centres in the leftover instead of stretching. */
  margin: auto 0 auto auto;
}

/* Sentence case, not the spec-label uppercase the rest of the chrome uses: a
   view toggle is read, not scanned as an identifier, and 11px uppercase at
   0.08em tracking was the one treatment here that read as dated. Strip height
   is unchanged — 4px padding on a 15px line matches the old 5px on 13. */
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

/* Weight carries the selected tab; tracking no longer can, now that the label
   is sentence case. */
/* The selected option is drawn in the SELECTION wash, not the action colour.
   Which view you are reading is not a thing you are being asked to do, and
   filling it with green made a view preference the loudest control in the
   header — louder than End, louder than the pending count. */
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

/* The project's container switch. A checkbox rather than the switch the start
   controls use: those switches decide what happens to THIS session, and this one
   states a standing fact about the project, which is what a checkbox reads as.
   Quiet by default and only coloured when ticked, because off is the common
   answer and an always-lit control stops carrying information. */
.wsl-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-ui);
  color: var(--text-tab);
  cursor: pointer;
  user-select: none;
}

.wsl-check:hover {
  color: var(--text-strong);
}

.wsl-check input {
  accent-color: var(--blue);
  cursor: pointer;
  margin: 0;
}

.wsl-check:has(input:checked) {
  color: var(--blue);
}

/* The session's own name, on the meta row. Reads as text until hovered: it is a
   label first and a control second, and an untyped session shows the prompt in
   the faint tier so it invites without shouting. */
.name-btn {
  font-family: var(--mono);
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
  font-family: var(--mono);
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

/* Red, because it is the one control here that stops work already running. It
   sits beside End and means something different: End closes the session, this
   interrupts the turn and leaves it open. */
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
  /* --red-ink is the token that exists for exactly this: white on the fill
     measured too low once --red became a lighter red-pencil red. */
  color: var(--red-ink);
  background: var(--red);
}

/* The stop mark itself: a square of the control's own colour, so it fills on
   hover with the button rather than needing a rule of its own. */
.stop-block {
  width: 9px;
  height: 9px;
  background: currentColor;
}

/* The teardown overlay lives in SessionWaitOverlay now, sharing one screen with
   the session start. The bespoke veil, strip and sliding rule that used to sit
   here went with it; ending-bar rides the shared ring. */

/* Same family as the agents pill it sits beside: one says the session is shaped
   to fan out, the other says it currently is. */
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

/* Off, it is an offer, so it stays in neutral ink like any quiet control. On, it
   takes amber — the attention-owed hue — because a planning session is
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
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-micro);
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
  gap: 16px;
  margin-top: 7px;
  font-size: var(--fs-meta);
  color: var(--text-meta);
  flex-wrap: wrap;
}

/* The run's short id: machine truth, so it sits at the ghost tier and never
   competes with the readings beside it. Earned monospace — it is a hash, and a
   hash is only useful if you can match it character for character. */
.head-stamp {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  white-space: nowrap;
}

/* Pairing-mode chip (Advisor/Orchestrator) for the latest work turn. */
.mode-chip {
  font-size: var(--fs-micro);
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
  font-size: var(--fs-micro);
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
  font-weight: var(--w-em);
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
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

/* Start is the commit; it sits at the far right of the row, after the two
   choices that shape it. */
.ended-actions .btn-solid {
  margin-left: auto;
}

/* --- Session mode picker (ended banner) --- */
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

/* The one mode that approves everything says so on the closed control, not only
   once the list is open. */
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

/* Opens downward. It was drawn upward first, to keep the stream's first messages
   clear — but this banner sits directly under a sticky header, so upward put the
   menu behind it and swallowed the clicks. */
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

/* Selection reads on the wash and on the name's colour. The rule is a hairline
   because a coloured band down the side of a list row is decoration. */
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

/* The description IS the row, not a tooltip you have to discover. The title
   attribute repeats it for anyone reading by hover. */
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

/* The same warning box ProjectRegistration draws for the same choice. Duplicated
   rather than shared because it is four properties and two files, and a shared
   class for it would be the third place to look. */
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
  /* display/width because this is a <button> now (it had no keyboard path as a
     div): a button is inline-block, so without these the pager would stop
     spanning the stream and its centred label would sit left. */
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
  font-size: var(--fs-micro);
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
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--blue);
}

.agents-count {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

/* Cap-toggle + "+N more" row for large fan-outs. */
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

/* Background-tasks card: amber accent to distinguish from blue subagents. */
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
  padding: 16px 22px 52px;
  background: color-mix(in srgb, var(--bg-code) 50%, transparent);
}

.raw-line {
  font-family: var(--mono);
  font-size: var(--fs-meta);
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

/* ENDED. Nothing typed here can go anywhere, and until now the box did not say
   so: `.composer-input` sets its own `color`, which beats the browser's disabled
   dimming, so a dead composer looked exactly like a live one. The only cues were
   a changed placeholder and a greyed Send.

   The panel recedes to the canvas colour so the box stops reading as a surface
   you can act on, and everything in the row fades with it. Including the buttons:
   the queue is project-scoped, so a queued message would outlive the session and
   run on the next one — but the textarea is disabled here, so nothing can be
   typed, `composerEmpty` stays true, and Queue is unreachable as well. Nothing in
   this row is actionable, and the row should say exactly that much. */
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

/* The block caret is the composer's "ready" signal. On a dead one it would be a
   green cursor blinking in a box that cannot send. */
.composer.dead .composer-input {
  caret-color: transparent;
}

/* The one round thing in a world of cut corners, and deliberately so: it is a
   floating control over the text rather than a part of the sheet, and the three
   existing exemptions are round for the same reason — a mark that is not a
   surface. It sits clear of the composer's own right-hand controls. */
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

/* Its own centred box, not a glyph on a baseline. The row is align-items:
   flex-end so a growing input pushes upward while the controls stay on the
   bottom line; a bare inline span therefore sat the 14px chevron on a 13px text
   baseline and it read as low in a 28px row. A fixed box centres it on both axes
   and keeps the row's flex-end behaviour intact. */
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

/* Spec-edit target chip in the composer (design ✎ → file). */
.target-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-micro);
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
