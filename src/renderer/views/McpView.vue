<script setup lang="ts">
// Database MCP view (design "Database MCP"): talk to a project's MCP server
// directly, and run a multi-agent scan that writes a cached db-schema.md so
// later questions consult the map instead of re-scanning. Both the scan and the
// chat drive the project's live Agent SDK session — which already has the MCP
// tools — so every answer is a real query, not a mock.
import { computed, nextTick, ref, watch } from 'vue'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import type { AgentScopedPayload, QuestionPayload, SessionEvent } from '@shared/domain'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import MarkdownText from '@renderer/components/MarkdownText.vue'

const props = defineProps<{ project: ProjectListItem }>()
const active = useActiveSessionStore()
const projects = useProjectsStore()

const name = computed(() => active.mcpTarget ?? '')
const server = computed(
  () => props.project.session?.mcpServers?.find((s) => s.name === name.value) ?? null,
)
const status = computed(() => server.value?.status ?? 'unknown')
const connected = computed(() => status.value.toLowerCase() === 'connected')

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

const scanned = computed(() => schemaDoc.value !== null)

// Main-loop events only — subagent internals stay folded into the parent stream,
// exactly like the session view.
const dbEvents = computed<SessionEvent[]>(() =>
  active.events.filter((e) => (e.payload as AgentScopedPayload).agentId === undefined),
)
const hasEvents = computed(() => dbEvents.value.length > 0)
const showEmpty = computed(
  () => subtab.value === 'chat' && !scanned.value && !hasEvents.value && !scanning.value,
)

async function loadSchema(): Promise<void> {
  schemaDoc.value = await projects.readMcpSchema(props.project.id)
}
watch([() => props.project.id, name], () => void loadSchema(), { immediate: true })

// A scan finishes when the session returns to idle — re-read the doc to unlock
// the db-schema.md tab.
watch(working, (now, was) => {
  if (was && !now) {
    if (scanning.value) scanning.value = false
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

function scanPrompt(n: string): string {
  return (
    `Scan the "${n}" database through its MCP tools and build a schema map. Use subagents ` +
    `(the Task tool) to parallelise across schemas where it helps. Enumerate every schema, ` +
    `table, column with its type, primary and foreign keys, indexes, and approximate row ` +
    `counts, then write a concise "db-schema.md" (under ~200 lines) to ".switchboard/db-schema.md" ` +
    `in the project root documenting all of it, so future questions consult it instead of ` +
    `re-scanning. Reply with a one-line summary when done.`
  )
}

function askPrompt(n: string, q: string): string {
  return (
    `[Database: ${n}] ${q}\n\n` +
    `Answer by querying the "${n}" database via its MCP tools. Consult ".switchboard/db-schema.md" ` +
    `for structure so you don't need to re-scan.`
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
  if (!liveSession.value) return
  subtab.value = 'chat'
  scanning.value = true
  await active.send(scanPrompt(name.value))
}

async function ask(): Promise<void> {
  const text = composer.value.trim()
  if (!text || !liveSession.value) return
  composer.value = ''
  await active.send(askPrompt(name.value, text))
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
        <span class="db-name mono">{{ name }}</span>
        <span class="db-sub mono">{{ project.name }} · MCP</span>
        <span style="flex: 1"></span>
        <span
          class="conn mono"
          :class="{ on: connected }"
          data-testid="mcp-conn"
        >
          ● {{ connected ? 'Connected' : status }}
        </span>
        <button
          v-if="working"
          class="stop-btn mono"
          data-testid="mcp-stop"
          title="Stop (Ctrl+C)"
          @click="interrupt()"
        >
          ■
        </button>
        <button class="back mono" data-testid="mcp-close" @click="active.openMcp(null)">
          ← {{ projects.selected?.name ?? 'back' }}
        </button>
      </div>
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
          :disabled="!liveSession || working"
          @click="scan()"
        >
          ↻ Re-scan
        </button>
      </div>
    </header>

    <!-- No schema yet: prompt a scan -->
    <div v-if="showEmpty" class="empty" data-testid="mcp-empty">
      <div class="empty-ico">⛁</div>
      <template v-if="!liveSession">
        <div class="empty-title">Start the database session</div>
        <div class="empty-sub">
          Opens a Claude Code session for <span class="mono teal">{{ name }}</span>. Then scan it to
          build <span class="mono teal">db-schema.md</span> and chat with your database.
        </div>
        <button class="btn-solid" data-testid="mcp-start-session" @click="startDbSession()">
          ▶ Start database session
        </button>
      </template>
      <template v-else>
        <div class="empty-title">No schema map yet</div>
        <div class="empty-sub">
          Run a scan first — it walks the whole MCP (schemas, tables, relations, indexes) and writes
          <span class="mono teal">db-schema.md</span>. Chatting then consults the map instead of
          re-scanning.
        </div>
        <button class="btn-solid" data-testid="mcp-scan" @click="scan()">▶ Scan database</button>
      </template>
      <div v-if="sessionError" class="empty-hint mono">{{ sessionError }}</div>
    </div>

    <!-- db-schema.md -->
    <div v-else-if="subtab === 'md'" class="doc" data-testid="mcp-doc">
      <div class="doc-head mono">
        <span class="teal">db-schema.md</span>
        <span class="faint">generated by the {{ name }} scan</span>
        <span style="flex: 1"></span>
        <button class="rescan mono" data-testid="mcp-doc-rescan" :disabled="!liveSession || working" @click="scan()">
          ↻ Re-scan
        </button>
      </div>
      <MarkdownText :text="schemaDoc ?? ''" />
    </div>

    <!-- Chat / scan stream -->
    <div v-else ref="streamEl" class="stream" data-testid="mcp-stream">
      <div class="stream-inner">
        <div v-if="scanning" class="scan-banner mono" data-testid="mcp-scanning">
          <span class="blink teal">▊</span> Scanning {{ name }} — walking schemas, tables and
          relations, then writing db-schema.md…
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
          <span class="blink teal">▊</span> Querying {{ name }}…
        </div>
      </div>
    </div>

    <!-- Composer (chat) -->
    <footer v-if="subtab === 'chat' && !showEmpty" class="composer">
      <div class="composer-row">
        <span class="caret mono">❯</span>
        <input
          v-model="composer"
          class="composer-input mono"
          data-testid="mcp-composer"
          :placeholder="`Ask your database — every question becomes a live query…`"
          :disabled="!liveSession"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter="ask()"
        />
        <span class="to mono">to {{ name }}</span>
        <button
          class="send-btn mono"
          data-testid="mcp-send"
          :disabled="!liveSession || composer.trim().length === 0"
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
  background: var(--bg-panel);
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

.conn {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10.5px;
  padding: 2px 10px;
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: 99px;
}

.conn.on {
  color: var(--green);
  background: rgba(52, 211, 153, 0.08);
  border: 1px solid rgba(52, 211, 153, 0.32);
}

.back {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-meta);
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  padding: 3px 9px;
}

.back:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
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
  border-radius: 10px;
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
  font-weight: 700;
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
  border-radius: 10px;
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
  font-size: 11px;
}

.doc-head .faint {
  color: var(--text-faint);
}

/* Composer caret is teal here (vs green in the session composer). */
.caret {
  flex-shrink: 0;
  color: var(--teal);
  font-weight: 700;
}
</style>
