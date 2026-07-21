<script setup lang="ts">
// Database MCP view (design "Database MCP"): talk to a project's MCP server
// directly, and run a multi-agent scan that writes a cached db-schema.md so
// later questions consult the map instead of re-scanning. Both the scan and the
// chat drive the project's live Agent SDK session — which already has the MCP
// tools — so every answer is a real query, not a mock.
import { computed, nextTick, ref, watch } from 'vue'
import type { ProjectListItem } from '@shared/ipc-types'
import type { SessionEvent } from '@shared/domain'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import MarkdownText from '@renderer/components/MarkdownText.vue'

const props = defineProps<{ project: ProjectListItem }>()
const active = useActiveSessionStore()

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

const subtab = ref<'chat' | 'md'>('chat')
const schemaDoc = ref<string | null>(null)
const scanning = ref(false)
const composer = ref('')
const streamEl = ref<HTMLElement | null>(null)

const scanned = computed(() => schemaDoc.value !== null)

// Main-loop events only — subagent internals stay folded into the parent stream,
// exactly like the session view.
const dbEvents = computed<SessionEvent[]>(() =>
  active.events.filter((e) => (e.payload as { agentId?: string }).agentId === undefined),
)
const hasEvents = computed(() => dbEvents.value.length > 0)
const showEmpty = computed(
  () => subtab.value === 'chat' && !scanned.value && !hasEvents.value && !scanning.value,
)

async function loadSchema(): Promise<void> {
  const res = await window.switchboard.invoke('mcp.readSchema', { projectId: props.project.id })
  schemaDoc.value = res.content
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
        <button class="back mono" data-testid="mcp-close" @click="active.openMcp(null)">
          ← {{ project.name }}
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
      <div class="empty-title">No schema map yet</div>
      <div class="empty-sub">
        Run a scan first — it walks the whole MCP (schemas, tables, relations, indexes) and writes
        <span class="mono teal">db-schema.md</span>. Chatting then consults the map instead of
        re-scanning.
      </div>
      <button class="btn-solid" data-testid="mcp-scan" :disabled="!liveSession" @click="scan()">
        ▶ Scan database
      </button>
      <div v-if="!liveSession" class="empty-hint mono">Start a session for {{ project.name }} first.</div>
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
            :payload="event.payload as never"
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
  color: #2dd4bf;
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
  box-shadow: inset 0 -2px 0 #2dd4bf;
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
  color: #2dd4bf;
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
  color: #2dd4bf;
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
  color: #2dd4bf;
  font-weight: 700;
}
</style>
