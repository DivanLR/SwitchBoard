<script setup lang="ts">
// Database MCP view (design "Database MCP"): talk to a project's MCP server
// directly, and run a multi-agent scan that writes a cached db-schema.md so
// later questions consult the map instead of re-scanning. Both the scan and the
// chat drive the project's live Agent SDK session — which already has the MCP
// tools — so every answer is a real query, not a mock.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import type { AgentScopedPayload, McpScan, QuestionPayload, SessionEvent } from '@shared/domain'
import { comboDocRelPath, comboKey } from '@shared/mcp-combo'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import MarkdownText from '@renderer/components/MarkdownText.vue'

const props = defineProps<{ project: ProjectListItem }>()
const active = useActiveSessionStore()
const projects = useProjectsStore()
const settings = useSettingsStore()

// Roster: the servers Settings put on this view (Settings → MCP toggles).
const rosterServers = computed(() => settings.settings?.databaseMcpServers ?? [])

// Active combination: the checked subset the chat and scans target. Each
// distinct combination has its own scan doc + history row.
const activeServers = computed(() =>
  rosterServers.value.filter((n) => (settings.settings?.mcpActiveServers ?? []).includes(n)).sort(),
)

// Roster rows as checkboxes: ☑ = in the active combination; the dot is the
// live connection status the session reports.
const serverRows = computed(() =>
  [...rosterServers.value].sort().map((name) => ({
    name,
    on: activeServers.value.includes(name),
    status: props.project.session?.mcpServers?.find((s) => s.name === name)?.status ?? 'unknown',
  })),
)

function toggleServer(name: string): void {
  if (!settings.settings) return
  const current = settings.settings.mcpActiveServers
  const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
  // Apply locally at once so a second quick click reads this array rather than
  // the pre-save snapshot — otherwise the later save would drop the first toggle.
  settings.settings.mcpActiveServers = next
  void settings.save({ mcpActiveServers: next })
}

// --- Scan history: one row per combination ever scanned ---
const history = ref<McpScan[]>([])

async function loadHistory(): Promise<void> {
  history.value = await projects.mcpScanHistory(props.project.id)
}
watch(() => props.project.id, () => void loadHistory(), { immediate: true })

const currentKey = computed(() => comboKey(activeServers.value))
const currentScan = computed(
  () => history.value.find((h) => h.comboKey === currentKey.value) ?? null,
)

/** Re-activate a previously scanned combination (its doc loads with it). */
function activateCombo(scan: McpScan): void {
  if (!settings.settings) return
  // Anything in the combo must be on the roster to be tickable again.
  const roster = new Set([...settings.settings.databaseMcpServers, ...scan.servers])
  settings.settings.databaseMcpServers = [...roster]
  settings.settings.mcpActiveServers = [...scan.servers]
  void settings.save({ databaseMcpServers: [...roster], mcpActiveServers: [...scan.servers] })
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (60 * 24))}d ago`
}

function dotColor(status: string): string {
  const st = status.toLowerCase()
  if (st === 'connected') return 'var(--green)'
  if (st === 'failed' || st === 'error') return 'var(--red)'
  return 'var(--amber)'
}

const liveSession = computed(() =>
  props.project.session && !props.project.session.endedAt ? props.project.session : null,
)
const working = computed(() => liveSession.value?.status === 'working')

// This view's project (the reserved Database project) is no longer always the
// selected project, so the active-session store may hold a different project's
// conversation. Load this project's own session, mirroring SessionView.
watch(
  () => liveSession.value?.id ?? null,
  (sessionId) => void active.open(sessionId),
  { immediate: true },
)

const subtab = ref<'chat' | 'md'>('chat')
const schemaDoc = ref<string | null>(null)
const scanning = ref(false)
const composer = ref('')
const streamEl = ref<HTMLElement | null>(null)
const composerEl = ref<HTMLTextAreaElement | null>(null)

// Terminal-style command suggestions (global /commands + history), same
// composable as the session composer — the Database session's init message
// reports the user-level (global) slash commands and skills.
const {
  suggestions,
  ghostRest,
  isCommandMatch,
  suggestIndex,
  acceptSuggestion,
  onComposerInput,
  onComposerKeydown,
  load: loadCommands,
  setCommands: setSuggestionCommands,
  hintFor,
  recordSent,
} = useCommandSuggestions({
  composer,
  composerEl,
  onSubmit: () => void ask(),
})

watch(() => props.project.id, (projectId) => void loadCommands(projectId), { immediate: true })

// Commands arrive with the session init — pick them up live (first session
// start in this view would otherwise show none until a reopen).
let unsubscribeCommands: (() => void) | undefined
onMounted(() => {
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
})
onUnmounted(() => unsubscribeCommands?.())

const scanned = computed(() => schemaDoc.value !== null)

// Main-loop events only — subagent internals stay folded into the parent stream,
// exactly like the session view.
const dbEvents = computed<SessionEvent[]>(() =>
  active.events.filter((e) => (e.payload as AgentScopedPayload).agentId === undefined),
)
const hasEvents = computed(() => dbEvents.value.length > 0)
// Show the hero (with its Start-session / Scan buttons) whenever there is no
// live session, even after a schema has been scanned — otherwise the only way
// to start a session from this view disappears on every return visit.
const showEmpty = computed(
  () =>
    subtab.value === 'chat' &&
    !scanning.value &&
    (!liveSession.value || (!scanned.value && !hasEvents.value)),
)

async function loadSchema(): Promise<void> {
  schemaDoc.value = activeServers.value.length
    ? await projects.readMcpSchema(props.project.id, activeServers.value)
    : null
}
// The doc follows the ACTIVE COMBINATION — switching combos swaps the doc.
watch([() => props.project.id, currentKey], () => void loadSchema(), { immediate: true })

// The combination a running scan was started for (active set may change mid-scan).
let scanningCombo: string[] = []

// A scan finishes when the session returns to idle — record the combination in
// the history (main verifies its doc landed) and re-read the doc.
watch(working, (now, was) => {
  if (was && !now) {
    if (scanning.value) {
      scanning.value = false
      void projects.mcpRecordScan(props.project.id, scanningCombo).then(() => loadHistory())
    }
    void loadSchema()
  }
})

watch(
  () => dbEvents.value.length,
  () =>
    void nextTick(() => {
      if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
    }),
)

function scanPrompt(names: string[]): string {
  const list = names.map((n) => `"${n}"`).join(', ')
  const rel = comboDocRelPath(names)
  return (
    `Scan these MCP servers through their tools and build one combined map: ${list}. Use subagents ` +
    `(the Task tool) to parallelise where it helps. For each server enumerate its structure — for a ` +
    `database: schemas, tables, columns with types, primary and foreign keys, indexes, and ` +
    `approximate row counts; for a search or index service: indexes, fields and types. Then write a ` +
    `concise schema map (under ~250 lines) to "${rel}" in the project root ` +
    `with a section per server, so future questions about this combination consult it instead of ` +
    `re-scanning. Reply with a one-line summary when done.`
  )
}

function askPrompt(names: string[], q: string): string {
  const list = names.map((n) => `"${n}"`).join(', ')
  return (
    `[MCP: ${list}] ${q}\n\n` +
    `Answer by querying these MCP servers via their tools: ${list}. Consult ` +
    `"${comboDocRelPath(names)}" for structure so you don't need to re-scan.`
  )
}

const sessionError = ref<string | null>(null)

/** Start the Database project's session (a normal session; MCP servers are
 *  scoped by the project's own .mcp.json, not by an app-level deny-list). */
async function startDbSession(): Promise<void> {
  sessionError.value = null
  try {
    await projects.startSession(props.project.id, false, false)
  } catch (e) {
    sessionError.value = isIpcError(e)
      ? e.code === 'ALREADY_ACTIVE'
        ? 'Stop the current session first, then start the database session.'
        : e.message
      : String(e)
  }
}

async function scan(): Promise<void> {
  if (!liveSession.value || activeServers.value.length === 0) return
  subtab.value = 'chat'
  scanning.value = true
  scanningCombo = [...activeServers.value]
  await active.send(scanPrompt(scanningCombo))
}

async function ask(): Promise<void> {
  const text = composer.value.trim()
  if (!text || !liveSession.value) return
  // A /command goes to the session raw (wrapping it in the MCP prompt would
  // break it); ordinary questions get the combination-targeted prompt.
  if (text.startsWith('/')) {
    composer.value = ''
    recordSent(text)
    await active.send(text)
    return
  }
  if (activeServers.value.length === 0) return
  composer.value = ''
  recordSent(text)
  await active.send(askPrompt(activeServers.value, text))
}

function answer(eventId: string, choice: string): void {
  void active.answerQuestion(eventId, choice)
}

// Stop a running scan/query (same interrupt path as the session view / Ctrl+C).
async function interrupt(): Promise<void> {
  await active.interrupt()
}
</script>

<template>
  <div class="mcp-view" data-testid="mcp-view">
    <!-- Header -->
    <header class="head">
      <div class="head-row">
        <span class="db-ico">⛁</span>
        <span class="db-name mono">MCP chat</span>
        <span class="db-sub mono">{{ project.name }}</span>
        <span style="flex: 1"></span>
        <button
          v-if="working"
          class="stop-btn mono"
          data-testid="mcp-stop"
          title="Stop (Ctrl+C)"
          @click="interrupt()"
        >
          ■
        </button>
      </div>
      <div v-if="serverRows.length > 0" class="mcp-servers mono" data-testid="mcp-servers">
        <button
          v-for="s in serverRows"
          :key="s.name"
          class="mcp-chip"
          :class="{ on: s.on }"
          role="switch"
          :aria-checked="s.on"
          :data-testid="`mcp-chip-${s.name}`"
          :title="s.on ? 'In the active combination — click to leave it out of the chat' : 'Click to include in the chat combination'"
          @click="toggleServer(s.name)"
        >
          <span class="mcp-tick">{{ s.on ? '☑' : '☐' }}</span>
          <span class="mcp-chip-dot" :style="{ background: dotColor(s.status) }"></span>{{ s.name }}
        </button>
      </div>
      <div v-else class="mcp-servers mono">
        <span class="combo-hint">No servers on this view yet — add them in Settings → MCP.</span>
      </div>

      <!-- Active combination + its scan state ("have I scanned this before?") -->
      <div class="combo-row mono" data-testid="mcp-combo">
        <span v-if="activeServers.length === 0" class="combo-hint">
          Tick the servers you want to chat to — each combination keeps its own scan.
        </span>
        <template v-else>
          <span class="combo-name" data-testid="mcp-combo-name">{{ currentKey }}</span>
          <span v-if="currentScan" class="combo-scanned" data-testid="mcp-combo-scanned">
            scanned {{ ago(currentScan.scannedAt) }}
          </span>
          <span v-else class="combo-never" data-testid="mcp-combo-never">never scanned</span>
          <button
            v-if="liveSession"
            class="rescan mono"
            data-testid="mcp-combo-scan"
            :disabled="working"
            @click="scan()"
          >
            {{ currentScan ? '↻ Re-scan' : '▶ Scan' }}
          </button>
        </template>
      </div>
      <div v-if="history.length > 0" class="combo-history mono" data-testid="mcp-history">
        <span class="ch-label">SCANNED</span>
        <button
          v-for="h in history"
          :key="h.id"
          class="ch-chip"
          :class="{ cur: h.comboKey === currentKey }"
          :data-testid="`mcp-history-${h.comboKey}`"
          :title="`Scanned ${ago(h.scannedAt)} — click to make this the active combination`"
          @click="activateCombo(h)"
        >
          {{ h.comboKey }}
          <span class="ch-ago">{{ ago(h.scannedAt) }}</span>
        </button>
      </div>
    </header>
    <!-- Own glass strip, matching the design's separate tabs bar -->
    <div class="tabs mono">
      <button class="tab" :class="{ sel: subtab === 'chat' }" data-testid="mcp-tab-chat" @click="subtab = 'chat'">
        Chat
      </button>
      <button
        v-if="scanned"
        class="tab"
        :class="{ sel: subtab === 'md' }"
        data-testid="mcp-tab-md"
        @click="subtab = 'md'"
      >
        db-schema.md
      </button>
      <span style="flex: 1"></span>
      <button
        v-if="scanned && subtab === 'chat'"
        class="rescan mono"
        data-testid="mcp-rescan"
        :disabled="!liveSession || working || activeServers.length === 0"
        @click="scan()"
      >
        ↻ Re-scan
      </button>
    </div>

    <!-- No schema yet: prompt a scan -->
    <div v-if="showEmpty" class="empty" data-testid="mcp-empty">
      <div class="empty-ico">⛁</div>
      <template v-if="!liveSession">
        <div class="empty-title">Start the MCP session</div>
        <div class="empty-sub">
          Opens a Claude Code session for <span class="mono teal">{{ project.name }}</span> with your
          MCP servers. Then scan them to build <span class="mono teal">db-schema.md</span> and chat
          across them.
        </div>
        <button class="btn-solid" data-testid="mcp-start-session" @click="startDbSession()">
          ▶ Start MCP session
        </button>
      </template>
      <template v-else>
        <div class="empty-title">No schema map yet</div>
        <div class="empty-sub">
          Run a scan first — it walks the <span class="mono teal">{{ currentKey || 'active' }}</span>
          combination and writes its own schema map. Chatting then consults that map instead of
          re-scanning, and every combination you scan is remembered above.
        </div>
        <button
          class="btn-solid"
          data-testid="mcp-scan"
          :disabled="activeServers.length === 0"
          :title="activeServers.length === 0 ? 'Tick at least one server first' : undefined"
          @click="scan()"
        >
          ▶ Scan combination
        </button>
      </template>
      <div v-if="sessionError" class="empty-hint mono">{{ sessionError }}</div>
    </div>

    <!-- db-schema.md -->
    <div v-else-if="subtab === 'md'" class="doc" data-testid="mcp-doc">
      <div class="doc-head mono">
        <span class="doc-title mono">db-schema.md</span>
        <span class="faint">from the MCP scan</span>
        <span style="flex: 1"></span>
        <button class="rescan mono" data-testid="mcp-doc-rescan" :disabled="!liveSession || working || activeServers.length === 0" @click="scan()">
          ↻ Re-scan
        </button>
      </div>
      <MarkdownText :text="schemaDoc ?? ''" />
    </div>

    <!-- Chat / scan stream -->
    <div v-else ref="streamEl" class="stream" data-testid="mcp-stream">
      <div class="stream-inner">
        <div v-if="scanning" class="scan-banner mono" data-testid="mcp-scanning">
          <span class="blink teal">▊</span> Scanning your MCP servers — walking their structure,
          then writing db-schema.md…
        </div>
        <template v-for="event in dbEvents" :key="event.id">
          <QuestionEvent
            v-if="event.kind === 'question'"
            :event-id="event.id"
            :payload="event.payload as QuestionPayload"
            @answer="answer"
          />
          <StreamEvent v-else :event="event" />
        </template>
        <div v-if="working && !scanning" class="live mono">
          <span class="blink teal">▊</span> Querying your MCP servers…
        </div>
      </div>
    </div>

    <!-- Composer (chat): questions target the active combination; /commands
         (global skills, plugins) go to the session raw with suggestions. -->
    <footer v-if="subtab === 'chat' && liveSession" class="composer">
      <div class="composer-row">
        <span class="caret mono">❯</span>
        <div class="input-wrap">
          <div v-if="suggestions.length > 0" class="suggest-list mono" data-testid="mcp-suggest-list">
            <div
              v-for="(cmd, index) in suggestions"
              :key="cmd"
              class="suggest-item"
              :class="{ active: index === suggestIndex }"
              @mousedown.prevent="acceptSuggestion(cmd)"
              @mouseenter="suggestIndex = index"
            >
              <span class="suggest-typed">{{ cmd }}</span>
              <span v-if="hintFor(cmd)" class="suggest-desc">{{ hintFor(cmd) }}</span>
            </div>
          </div>
          <div class="ghost mono" aria-hidden="true">
            <span class="ghost-typed">{{ composer }}</span
            ><span class="ghost-rest">{{ ghostRest }}</span>
          </div>
          <textarea
            ref="composerEl"
            v-model="composer"
            class="composer-input mono"
            :class="{ 'is-command': isCommandMatch }"
            data-testid="mcp-composer"
            rows="1"
            :placeholder="
              activeServers.length === 0
                ? 'Tick a server above to query it — or run a /command…'
                : `Ask across ${currentKey} — or run a /command…`
            "
            :disabled="!liveSession"
            spellcheck="false"
            autocomplete="off"
            @input="onComposerInput"
            @keydown="onComposerKeydown"
          ></textarea>
        </div>
        <span class="to mono">to MCP</span>
        <button
          class="send-btn mono"
          data-testid="mcp-send"
          :disabled="
            !liveSession ||
            composer.trim().length === 0 ||
            (activeServers.length === 0 && !composer.trim().startsWith('/'))
          "
          @click="ask()"
        >
          Send ⏎
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.mcp-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}

.head {
  padding: 14px 18px 0;
  border-bottom: 1px solid var(--border);
  background: var(--gloss), var(--bg-panel);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 12px;
}

.db-ico {
  font-size: 15px;
  color: var(--teal);
}

.db-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.db-sub {
  font-size: 10.5px;
  color: var(--text-faint);
}

/* Combined MCP servers: a chip per designated server with its live status. */
.mcp-servers {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 12px;
}

.mcp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-tab);
  padding: 3px 11px;
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  background: transparent;
  cursor: pointer;
}

.mcp-chip:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.mcp-chip.on {
  color: var(--text-bright);
  font-weight: 600;
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.mcp-tick {
  font-size: 11px;
  line-height: 1;
}

.mcp-chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 99px;
}

/* Active combination line: combo name + scan freshness + scan button. */
.combo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  font-size: 11px;
}

.combo-hint {
  color: var(--text-faint);
}

.combo-name {
  color: var(--teal);
  font-weight: 600;
}

.combo-scanned {
  color: var(--green);
}

.combo-never {
  color: var(--amber);
}

/* Scanned-combination history: one chip per combination ever scanned. */
.combo-history {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 12px;
}

.ch-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.ch-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  padding: 2px 10px;
  background: transparent;
  cursor: pointer;
}

.ch-chip:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.ch-chip.cur {
  color: var(--teal);
  border-color: var(--teal);
  cursor: default;
}

.ch-ago {
  color: var(--text-faint);
  font-size: 9.5px;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--gloss), var(--bg-panel);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.tab {
  padding: 9px 13px;
  font-size: 11.5px;
  color: var(--text-tab);
  cursor: pointer;
  background: transparent;
}

.tab:hover {
  color: var(--text-body);
}

.tab.sel {
  color: var(--text-strong);
  box-shadow: inset 0 -2px 0 var(--teal);
}

.rescan {
  font-size: 10.5px;
  color: var(--text-mid);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 3px 10px;
  align-self: center;
}

.rescan:hover:not(:disabled) {
  color: var(--text-strong);
  border-color: var(--border-seg);
}

.rescan:disabled {
  opacity: 0.4;
  cursor: default;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  gap: 10px;
}

.empty-ico {
  font-size: 26px;
  color: var(--teal);
}

.empty-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-bright);
}

.empty-sub {
  max-width: 460px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-meta);
  text-wrap: pretty;
}

.empty-hint {
  font-size: 11px;
  color: var(--amber);
}

.teal {
  color: var(--teal);
}

.scan-banner {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-meta);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  padding: 9px 12px;
  margin-bottom: 14px;
}

.doc {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px;
}

.doc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  font-size: 12px;
}

.doc-title {
  color: var(--text-strong);
}

.doc-head .faint {
  font-size: 10.5px;
  color: var(--text-faint);
}

/* Composer caret is teal here (vs green in the session composer). */
.caret {
  flex-shrink: 0;
  color: var(--teal);
  font-weight: 600;
  /* Bottom-pinned row: lift the caret to the buttons' text line. */
  padding-bottom: 6px;
}

/* Command suggestions (same idioms as the session composer). */
.input-wrap {
  position: relative;
  flex: 1;
  min-width: 60px;
  display: flex;
}

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
  /* Bottom-pinned row: sit the text line level with the buttons' text. The
     ghost mirror below must keep the identical padding. */
  padding-bottom: 6px;
}

/* Exact /command match: hide the raw text (keep the caret) and let the ghost
   mirror colour the command — teal in this view. */
.composer-input.is-command {
  color: transparent;
  caret-color: var(--text);
}

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
  /* Mirrors .composer-input exactly — keep the paddings in lockstep. */
  padding-bottom: 6px;
}

.ghost-typed {
  color: transparent;
}

.input-wrap:has(.is-command) .ghost-typed {
  color: var(--teal);
  font-weight: 600;
}

.ghost-rest {
  color: var(--text-ghost);
}

.suggest-list {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 190px;
  overflow-y: auto;
  /* Opaque — a translucent dropdown lets the stream bleed through the rows. */
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 4px;
  z-index: 5;
  box-shadow: var(--shadow-dd);
}

/* Light theme: a solid white sheet (the pale-blue panel tone read as see-through). */
html.sb-light .suggest-list {
  background: #fff;
}

.suggest-item {
  font-size: 12.5px;
  padding: 5px 8px;
  border-radius: var(--rc);
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
