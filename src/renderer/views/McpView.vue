<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { relativeTime } from '@renderer/relative-time'
import { mcpStatusColor } from '@renderer/project-accent'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import { agentIdOf } from '@shared/domain'
import type { McpScan, QuestionPayload, SessionEvent } from '@shared/domain'
import { comboDocRelPath, comboKey } from '@shared/mcp-combo'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ project: ProjectListItem }>()
const active = useActiveSessionStore()
const projects = useProjectsStore()
const settings = useSettingsStore()

const rosterServers = computed(() => settings.settings?.databaseMcpServers ?? [])

const activeServers = computed(() =>
  rosterServers.value.filter((n) => (settings.settings?.mcpActiveServers ?? []).includes(n)).sort(),
)

const serverRows = computed(() =>
  [...rosterServers.value].sort().map((name) => ({
    name,
    on: activeServers.value.includes(name),
    status: props.project.session?.mcpServers?.find((s) => s.name === name)?.status ?? 'unknown',
  })),
)

function toggleServer(name: string): void {
  settings.toggleMcpActiveServer(name)
}

const history = ref<McpScan[]>([])

async function loadHistory(): Promise<void> {
  history.value = await projects.mcpScanHistory(props.project.id)
}
watch(() => props.project.id, () => void loadHistory(), { immediate: true })

const currentKey = computed(() => comboKey(activeServers.value))
const currentScan = computed(
  () => history.value.find((h) => h.comboKey === currentKey.value) ?? null,
)

function activateCombo(scan: McpScan): void {
  settings.activateMcpCombo(scan.servers)
}

const ago = (iso: string): string => relativeTime(iso, Date.now())

const liveSession = computed(() =>
  props.project.session && !props.project.session.endedAt ? props.project.session : null,
)
const working = computed(() => liveSession.value?.status === 'working')

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

const {
  suggestions,
  ghostRest,
  suggestIndex,
  acceptSuggestion,
  onComposerInput,
  onComposerKeydown,
  onComposerScroll,
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

let unsubscribeCommands: (() => void) | undefined
onMounted(() => {
  unsubscribeCommands = window.switchboard.on('push.projectCommands', (push) => {
    if (push.projectId === props.project.id) setSuggestionCommands(push.commands)
  })
})
onUnmounted(() => unsubscribeCommands?.())

const scanned = computed(() => schemaDoc.value !== null)

const MAX_RENDER = 500
const dbEvents = computed<SessionEvent[]>(() => {
  const all = active.events.filter((e) => agentIdOf(e) === undefined)
  return all.length > MAX_RENDER ? all.slice(all.length - MAX_RENDER) : all
})
const hasEvents = computed(() => dbEvents.value.length > 0)
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
watch([() => props.project.id, currentKey], () => void loadSchema(), { immediate: true })

let scanningCombo: string[] = []

watch(working, (now, was) => {
  if (was && !now) {
    if (scanning.value) {
      void projects.mcpRecordScan(props.project.id, scanningCombo).then((row) => {
        if (!row) return 
        scanning.value = false
        void loadHistory()
      })
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

const sendDisabled = computed(() => {
  const text = composer.value.trim()
  if (!liveSession.value || text.length === 0) return true
  return activeServers.value.length === 0 && !text.startsWith('/')
})

function askPrompt(names: string[], q: string): string {
  const list = names.map((n) => `"${n}"`).join(', ')
  return (
    `[MCP: ${list}] ${q}\n\n` +
    `Answer by querying these MCP servers via their tools: ${list}. Consult ` +
    `"${comboDocRelPath(names)}" for structure so you don't need to re-scan.`
  )
}

const sessionError = ref<string | null>(null)

async function startDbSession(): Promise<void> {
  sessionError.value = null
  try {
    await projects.startSession(props.project.id, false)
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
</script>

<template>
  <div class="mcp-view" data-testid="mcp-view">
    <header class="head">
      <div class="head-row">
        <span class="db-ico"><Icon name="database" /></span>
        <span class="db-name mono">MCP chat</span>
        <span class="db-sub mono">{{ project.name }}</span>
        <span class="spacer"></span>
        <button
          v-if="working"
          class="stop-btn"
          data-testid="mcp-stop"
          title="Stop (Ctrl+C)"
          @click="active.interrupt()"
        >
          <Icon name="stop" />
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
          <span class="mcp-tick"><Icon :name="s.on ? 'square-check' : 'square'" :size="12" /></span>
          <span class="mcp-chip-dot" :style="{ background: mcpStatusColor(s.status) }"></span>{{ s.name }}
        </button>
      </div>
      <div v-else class="mcp-servers mono">
        <span class="combo-hint">No servers on this view yet — add them in Settings → MCP.</span>
      </div>

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
            <template v-if="currentScan"><Icon name="refresh" :size="11" /> Re-scan</template>
            <template v-else><Icon name="play" :size="11" /> Scan</template>
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
      <span class="spacer"></span>
      <button
        v-if="scanned && subtab === 'chat'"
        class="rescan mono"
        data-testid="mcp-rescan"
        :disabled="!liveSession || working || activeServers.length === 0"
        @click="scan()"
      >
        <Icon name="refresh" :size="11" /> Re-scan
      </button>
    </div>

    <div v-if="showEmpty" class="empty" data-testid="mcp-empty">
      <div class="empty-ico"><Icon name="database" :size="18" /></div>
      <template v-if="!liveSession">
        <div class="empty-title">Start the MCP session</div>
        <div class="empty-sub">
          Opens a Claude Code session for <span class="mono teal">{{ project.name }}</span> with your
          MCP servers. Then scan them to build <span class="mono teal">db-schema.md</span> and chat
          across them.
        </div>
        <button class="btn-solid" data-testid="mcp-start-session" @click="startDbSession()">
          <Icon name="play" :size="12" /> Start MCP session
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
          <Icon name="play" :size="12" /> Scan combination
        </button>
      </template>
      <div v-if="sessionError" class="empty-hint mono">{{ sessionError }}</div>
    </div>

    <div v-else-if="subtab === 'md'" class="doc" data-testid="mcp-doc">
      <div class="doc-head mono">
        <span class="doc-title mono">db-schema.md</span>
        <span class="faint">from the MCP scan</span>
        <span class="spacer"></span>
        <button class="rescan mono" data-testid="mcp-doc-rescan" :disabled="!liveSession || working || activeServers.length === 0" @click="scan()">
          <Icon name="refresh" :size="11" /> Re-scan
        </button>
      </div>
      <MarkdownText :text="schemaDoc ?? ''" />
    </div>

    <div v-else ref="streamEl" class="stream" data-testid="mcp-stream">
      <div class="stream-inner">
        <div
          v-if="scanning"
          class="scan-banner mono"
          data-testid="mcp-scanning"
          role="status"
          aria-live="polite"
        >
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

    <footer v-if="subtab === 'chat' && liveSession" class="composer">
      <div class="composer-row">
        <span class="caret"><Icon name="chevron-right" :size="12" /></span>
        <div class="input-wrap">
          <div v-if="suggestions.length > 0" class="suggest-list mono" data-testid="mcp-suggest-list">
            <div
              v-for="(cmd, index) in suggestions"
              :key="cmd"
              class="suggest-item"
              :class="{ active: index === suggestIndex }"
              :data-testid="`mcp-suggest-item-${index}`"
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
            @scroll="onComposerScroll"
          ></textarea>
        </div>
        <span class="to mono">to MCP</span>
        <button
          class="send-btn mono"
          data-testid="mcp-send"
          :disabled="sendDisabled"
          @click="ask()"
        >
          Send <Icon name="send" :size="12" />
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
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
}

.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 12px;
}

.db-ico {
  color: var(--teal);
}

.db-name {
  font-size: var(--fs-title);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.db-sub {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

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
  font-size: var(--fs-micro);
  color: var(--text-tab);
  padding: 3px 11px;
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  background: transparent;
  cursor: pointer;
}

.mcp-chip:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.mcp-chip.on {
  color: var(--text-bright);
  font-weight: var(--w-em);
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.mcp-tick {
  display: inline-flex;
}

.mcp-chip-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--rp);
}

.combo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  font-size: var(--fs-meta);
}

.combo-hint {
  color: var(--text-faint);
}

.combo-name {
  color: var(--teal);
  font-weight: var(--w-em);
}

.combo-scanned {
  color: var(--green);
}

.combo-never {
  color: var(--amber);
}

.combo-history {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 12px;
}

.ch-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.ch-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-micro);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
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
  font-size: var(--fs-micro);
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
}

.tab {
  padding: 9px 13px;
  font-size: var(--fs-meta);
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
  font-size: var(--fs-micro);
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
  color: var(--teal);
}

.empty-title {
  font-size: var(--fs-title);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.empty-sub {
  max-width: 460px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-meta);
  text-wrap: pretty;
}

.empty-hint {
  font-size: var(--fs-meta);
  color: var(--amber);
}

.teal {
  color: var(--teal);
}

.scan-banner {
  font-size: var(--fs-ui);
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
  font-size: var(--fs-ui);
}

.doc-title {
  color: var(--text-strong);
}

.doc-head .faint {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.caret {
  flex-shrink: 0;
  color: var(--teal);
  padding-bottom: 6px;
}


.input-wrap:has(.is-command) .ghost-typed {
  color: var(--teal);
  font-weight: var(--w-em);
}

</style>
