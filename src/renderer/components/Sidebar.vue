<script setup lang="ts">
// Sidebar — 1:1 with the design reference: logo, PROJECTS list with animated
// status dots, mono names, per-project pending badges, branch + timer line,
// and the running / needs-you / cost-today stats card (FR-003/004/005).
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { MODEL_CHOICES } from '@shared/domain'
import { activeAgents } from '@shared/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useSettingsStore } from '@renderer/stores/settings'
import { accentFor } from '@renderer/project-accent'

const projects = useProjectsStore()
const activeSession = useActiveSessionStore()
const inbox = useInboxStore()
const settings = useSettingsStore()

// Agents working in parallel, listed under the project row (design); clicking
// one opens its chat view in the session pane.
// ponytail: events exist client-side only for the selected project's session,
// so other rows stay plain; push agent names via sessionStatus if that matters.
function agentsFor(item: (typeof projects.items)[number]): { id: string; name: string }[] {
  if (item.id !== projects.selectedProjectId) return []
  if (statusOf(item) !== 'working') return []
  const agents = activeAgents(activeSession.events)
  return agents.length > 1 ? agents : []
}

function openAgent(agentId: string): void {
  activeSession.selectAgent(agentId)
}
const emit = defineEmits<{
  (e: 'add-project'): void
  (e: 'open-settings'): void
}>()

// Short label of the current work model for the settings row (design).
const modelSummary = computed(() => {
  const id = settings.settings?.workModel ?? 'default'
  if (id === 'default') return 'default model'
  const choice = MODEL_CHOICES.find((m) => m.id === id)
  return choice ? choice.label : id
})

// --- Theme + collapse toggles (design: icon buttons beside the logo) ---
const collapsed = ref(false)
const theme = ref<'dark' | 'light'>(localStorage.getItem('sb-theme') === 'light' ? 'light' : 'dark')

function applyTheme(): void {
  document.documentElement.classList.toggle('sb-light', theme.value === 'light')
}

function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  localStorage.setItem('sb-theme', theme.value)
  applyTheme()
}
applyTheme() // restore the persisted choice on startup

/** Compact row label while collapsed: initials of the first two words. */
function initials(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toLowerCase()
}

// Stable per-project accent stripe on the row's right edge (shared with the
// session header dot) — identifies the project at a glance in the collapsed rail.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  if (!settings.settings) void settings.load()
})
onUnmounted(() => clearInterval(timer))

const collisions = computed(() => projects.nameCollisions)

function timerOf(startedAt: string): string {
  const sec = Math.max(0, Math.floor((now.value - Date.parse(startedAt)) / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`
}

function statusOf(item: (typeof projects.items)[number]): string {
  if (!item.session) return 'none'
  if (item.session.endedAt) return 'ended'
  return item.session.status
}

function pendingFor(projectId: string): number {
  return inbox.pending.filter((p) => p.projectId === projectId).length
}

const costLabel = computed(() => `$${projects.counters.costTodayUsd.toFixed(2)}`)

// Daily spend limit (General settings): cost turns red once passed.
const overSpendLimit = computed(() => {
  const limit = settings.settings?.dailySpendLimit ?? 0
  return limit > 0 && projects.counters.costTodayUsd >= limit
})

const tokensLabel = computed(() => {
  const n = projects.counters.tokensToday
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
})

// --- Session usage meter (subscription rate limit from the SDK) ---
const usageSession = computed(() => {
  const selected = projects.selected?.session
  if (selected && !selected.endedAt && selected.usageUtilization != null) return selected
  // Fall back to any live session reporting usage.
  return (
    projects.items
      .map((p) => p.session)
      .find((s) => s && !s.endedAt && s.usageUtilization != null) ?? null
  )
})

const usagePct = computed(() =>
  usageSession.value?.usageUtilization != null
    ? Math.max(0, Math.min(100, Math.round(usageSession.value.usageUtilization)))
    : null,
)

const usageColor = computed(() => {
  const p = usagePct.value ?? 0
  return p > 85 ? 'var(--red)' : p > 60 ? 'var(--amber)' : 'var(--green)'
})

const usageLimitLabel = computed(() => {
  const t = usageSession.value?.usageLimitType
  if (t === 'five_hour') return '5h limit'
  if (t?.startsWith('seven_day')) return '7d limit'
  return 'limit'
})

const usageReset = computed(() => {
  const at = usageSession.value?.usageResetsAt
  if (!at) return ''
  const ms = at * 1000 - now.value
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
})

// --- Global database session (design: one project-less MCP chat, bound to the
// reserved "Database" project — see main/index.ts — rather than to whichever
// project happens to be selected. It starts on demand from the DB view, like
// any project; there is no launch auto-start. ---
const dbProject = computed(() => projects.dbProject)
const dbServerName = computed(() => settings.settings?.databaseMcpServer ?? null)
const dbMcpStatus = computed(() => {
  const session = dbProject.value?.session
  if (!session || session.endedAt) return 'not started'
  return session.mcpServers?.find((m) => m.name === dbServerName.value)?.status ?? 'connecting'
})
function mcpDot(status: string): string {
  const st = status.toLowerCase()
  if (st === 'connected') return 'var(--green)'
  if (st === 'failed' || st === 'error') return 'var(--red)'
  return 'var(--amber)'
}

// --- Context menu (right-click) + inline rename ---
const ctx = ref<{ id: string; name: string; x: number; y: number } | null>(null)
const renamingId = ref<string | null>(null)
const renameVal = ref('')

// Function refs run on every re-render (each keystroke updates renameVal), so
// only focus+select when the input isn't already focused — otherwise typing
// gets select()-ed away after every character.
function focusOnMount(el: unknown): void {
  if (el instanceof HTMLInputElement && document.activeElement !== el) {
    el.focus()
    el.select()
  }
}

function openCtx(item: (typeof projects.items)[number], event: MouseEvent): void {
  ctx.value = { id: item.id, name: item.name, x: event.clientX, y: event.clientY }
}

function closeCtx(): void {
  ctx.value = null
}

function startRename(): void {
  if (!ctx.value) return
  renamingId.value = ctx.value.id
  renameVal.value = ctx.value.name
  ctx.value = null
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  renamingId.value = null
  if (!id) return
  const name = renameVal.value.trim()
  if (name.length > 0) await projects.rename(id, name)
}

function ctxDelete(): void {
  if (!ctx.value) return
  askRemove(ctx.value.id)
  ctx.value = null
}

function ctxMove(delta: number): void {
  if (!ctx.value) return
  const index = projects.items.findIndex((p) => p.id === ctx.value?.id)
  if (index !== -1) void projects.move(ctx.value.id, index + delta)
  ctx.value = null
}

// --- Drag & drop (design): drag a row to REORDER only. Referencing another
// project is done by dragging it into the session pane (the chat), never by
// dropping one project onto another. OS files dropped on a row insert their
// @path into that project's composer. ---
const dragId = ref<string | null>(null)
const rowDrop = ref<{ id: string; zone: 'before' | 'after' | 'file' } | null>(null)

function onDragStart(item: (typeof projects.items)[number], event: DragEvent): void {
  dragId.value = item.id
  event.dataTransfer?.setData('text/x-sb-project', item.id)
  event.dataTransfer?.setData('text/x-sb-project-path', item.path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

// Project drags reorder: top half inserts before, bottom half after — no
// drop-onto-reference zone. OS-file drags highlight the whole row.
function onRowDragOver(item: (typeof projects.items)[number], event: DragEvent): void {
  const types = event.dataTransfer?.types ?? []
  if (types.includes('Files')) {
    event.preventDefault()
    rowDrop.value = { id: item.id, zone: 'file' }
    return
  }
  if (!types.includes('text/x-sb-project')) return
  if (dragId.value === item.id) return
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const y = (event.clientY - rect.top) / Math.max(1, rect.height)
  rowDrop.value = { id: item.id, zone: y < 0.5 ? 'before' : 'after' }
}

async function onRowDrop(item: (typeof projects.items)[number], event: DragEvent): Promise<void> {
  event.preventDefault()
  const drop = rowDrop.value
  rowDrop.value = null
  // An OS file dropped on a project: open it and point the composer at the path.
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length > 0) {
    const paths = files
      .map((f) => window.switchboard.pathForFile?.(f))
      .filter((p): p is string => Boolean(p))
      .map((p) => `@${p}`)
    if (paths.length > 0) {
      projects.select(item.id)
      activeSession.requestComposerInsert(paths.join(' '))
    }
    dragId.value = null
    return
  }
  const dragged = event.dataTransfer?.getData('text/x-sb-project') || dragId.value
  dragId.value = null
  if (!drop || !dragged || dragged === item.id) return
  const fromIndex = projects.items.findIndex((p) => p.id === dragged)
  if (fromIndex === -1) return
  const targetIndex = projects.items.findIndex((p) => p.id === item.id)
  let toIndex = drop.zone === 'before' ? targetIndex : targetIndex + 1
  if (fromIndex < toIndex) toIndex -= 1
  await projects.move(dragged, toIndex)
}

function onDragEnd(): void {
  dragId.value = null
  rowDrop.value = null
}

// --- Remove (archive) a project, via a confirmation popup ---
const confirmRemoveId = ref<string | null>(null)
const removeError = ref<string | null>(null)
const busy = ref(false)

const confirmRemove = computed(() =>
  confirmRemoveId.value ? (projects.items.find((p) => p.id === confirmRemoveId.value) ?? null) : null,
)

function askRemove(projectId: string): void {
  removeError.value = null
  confirmRemoveId.value = projectId
}

function cancelRemove(): void {
  confirmRemoveId.value = null
  removeError.value = null
}

async function confirmRemoveNow(): Promise<void> {
  if (!confirmRemoveId.value) return
  removeError.value = null
  busy.value = true
  try {
    await projects.archive(confirmRemoveId.value)
    confirmRemoveId.value = null
  } catch (e) {
    removeError.value = isIpcError(e)
      ? e.code === 'ALREADY_ACTIVE'
        ? 'Stop the session before removing this project.'
        : e.message
      : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="brand">
      <div class="brand-top">
        <div class="logo mono">
          <span style="color: var(--green)">▣</span><span v-if="!collapsed"> switchboard</span>
        </div>
        <span style="flex: 1"></span>
        <button
          class="icon-btn mono"
          data-testid="theme-toggle"
          :title="
            theme === 'light'
              ? 'Switch to dark mode'
              : 'Light mode — easier to read in bright rooms'
          "
          @click="toggleTheme"
        >
          {{ theme === 'light' ? '☾' : '☀' }}
        </button>
        <button
          class="icon-btn mono"
          data-testid="collapse-toggle"
          :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? '»' : '«' }}
        </button>
      </div>
      <div v-if="!collapsed" class="tagline mono">Claude Code sessions · one inbox</div>
    </div>

    <div class="section-row">
      <span v-if="!collapsed" class="section-label mono">PROJECTS</span>
      <button class="add mono" data-testid="add-project" title="New session" @click="emit('add-project')">
        +
      </button>
    </div>

    <div class="project-list">
      <div
        v-for="item in projects.visibleItems"
        :key="item.id"
        class="project"
        :class="{
          active: item.id === projects.selectedProjectId,
          'drop-before': rowDrop?.id === item.id && rowDrop.zone === 'before',
          'drop-after': rowDrop?.id === item.id && rowDrop.zone === 'after',
          'drop-file': rowDrop?.id === item.id && rowDrop.zone === 'file',
        }"
        :data-testid="`sidebar-project-${item.name}`"
        :draggable="renamingId !== item.id"
        @click="projects.select(item.id)"
        @contextmenu.prevent="openCtx(item, $event)"
        @dragstart="onDragStart(item, $event)"
        @dragover="onRowDragOver(item, $event)"
        @dragleave="rowDrop = rowDrop?.id === item.id ? null : rowDrop"
        @drop="onRowDrop(item, $event)"
        @dragend="onDragEnd"
      >
        <div class="active-bg"></div>
        <span
          class="accent"
          :data-testid="`project-accent-${item.name}`"
          :style="{ background: accentFor(item.id) }"
        ></span>
        <div class="content">
          <div class="row">
            <span
              v-if="statusOf(item) !== 'none'"
              class="dot"
              :class="statusOf(item)"
              :data-testid="`status-badge-${item.name}`"
              :data-status="statusOf(item)"
              :title="statusOf(item) === 'needs_you' ? 'Needs you' : statusOf(item)"
            ></span>
            <span v-if="collapsed" class="initials mono">{{ initials(item.name) }}</span>
            <template v-else>
              <input
                v-if="renamingId === item.id"
                :ref="focusOnMount"
                v-model="renameVal"
                class="rename-input mono"
                :data-testid="`rename-input-${item.name}`"
                @click.stop
                @keydown.enter="commitRename"
                @keydown.esc="renamingId = null"
                @blur="commitRename"
              />
              <span v-else class="name mono">{{ item.name }}</span>
              <span
                v-if="pendingFor(item.id) > 0"
                class="badge-count"
                :data-testid="`project-badge-${item.name}`"
              >
                {{ pendingFor(item.id) }}
              </span>
              <button
                class="remove mono"
                :data-testid="`remove-project-${item.name}`"
                title="Remove this project"
                @click.stop="askRemove(item.id)"
              >
                ✕
              </button>
            </template>
          </div>
          <div v-if="!collapsed" class="meta">
            <span class="branch mono">⎇ {{ item.session?.branch ?? '—' }}</span>
            <span
              v-if="item.session && !item.session.endedAt"
              class="timer mono"
              :data-testid="`timer-${item.name}`"
            >
              {{ timerOf(item.session.startedAt) }}
            </span>
          </div>
          <div v-if="!collapsed && collisions.has(item.name)" class="path mono">{{ item.path }}</div>
          <div
            v-if="!collapsed && agentsFor(item).length > 0"
            class="agents"
            :data-testid="`sidebar-agents-${item.name}`"
          >
            <div
              v-for="agent in agentsFor(item)"
              :key="agent.id"
              class="agent-line"
              :data-testid="`sidebar-agent-${agent.name}`"
              @click.stop="openAgent(agent.id)"
            >
              <span class="agent-sq"></span>
              <span
                class="agent-name mono"
                :class="{ sel: activeSession.selectedAgentId === agent.id }"
              >
                {{ agent.name }}{{ activeSession.selectedAgentId === agent.id ? ' ←' : '' }}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div v-if="projects.loaded && projects.visibleItems.length === 0" class="empty mono">
        No projects yet — press + to add one.
      </div>
    </div>

    <!-- Global database MCP (design): a single project-less row, always present
         once a database MCP is designated, opening its own chat/scan view. -->
    <template v-if="dbServerName && dbProject">
      <div v-if="!collapsed" class="section-row">
        <span class="section-label mono">MCP</span>
      </div>
      <div
        class="mcp-item"
        :class="{ open: activeSession.mcpTarget === dbServerName }"
        :title="`${dbServerName} — chat with it or scan its schema over MCP`"
        :data-testid="`mcp-server-${dbServerName}`"
        @click="activeSession.openMcp(dbServerName)"
      >
        <span class="mcp-ico">⛁</span>
        <template v-if="!collapsed">
          <div class="mcp-main">
            <div class="mcp-name mono">{{ dbServerName }}</div>
            <div class="mcp-sub mono">{{ dbMcpStatus }}</div>
          </div>
          <span class="mcp-dot" :style="{ background: mcpDot(dbMcpStatus) }"></span>
        </template>
        <span class="mcp-accent"></span>
      </div>
    </template>

    <div class="settings-row" data-testid="open-settings" @click="emit('open-settings')">
      <span class="gear mono">⚙</span>
      <template v-if="!collapsed">
        <span class="settings-label mono">Settings</span>
        <span class="model-summary mono" data-testid="model-summary">{{ modelSummary }}</span>
      </template>
    </div>

    <div v-if="!collapsed" class="stats">
      <div class="stat mono" data-testid="counter-running">
        <span>Running</span><span class="val" data-testid="counter-running-value">{{ projects.counters.running }}</span>
      </div>
      <div class="stat mono" data-testid="counter-needsyou">
        <span>Needs you</span
        ><span class="val amber" data-testid="counter-needsyou-value">{{ projects.counters.needsYou }}</span>
      </div>
      <div class="stat mono" data-testid="counter-cost">
        <span>Cost today</span
        ><span
          class="val"
          :style="overSpendLimit ? { color: 'var(--red)' } : undefined"
          data-testid="counter-cost-value"
          >{{ costLabel }}</span
        >
      </div>
      <div class="stat mono" data-testid="counter-tokens">
        <span>Tokens today</span
        ><span class="val" data-testid="counter-tokens-value">{{ tokensLabel }}</span>
      </div>
    </div>

    <div v-if="!collapsed && usagePct !== null" class="usage-card" data-testid="usage-meter">
      <div class="usage-head mono">
        <span>Session usage</span>
        <span :style="{ color: usageColor }">{{ usagePct }}% of {{ usageLimitLabel }}</span>
      </div>
      <div class="usage-bar">
        <div class="usage-fill" :style="{ width: `${usagePct}%`, background: usageColor }"></div>
      </div>
      <div class="usage-foot mono">
        <span data-testid="usage-tokens">{{ tokensLabel }} tok</span>
        <span v-if="usageReset">Resets in {{ usageReset }}</span>
      </div>
    </div>

  </aside>

  <!-- Right-click context menu -->
  <div v-if="ctx" class="ctx-overlay" @click="closeCtx" @contextmenu.prevent="closeCtx">
    <div
      class="ctx-menu"
      data-testid="project-ctx-menu"
      :style="{ left: `${ctx.x}px`, top: `${ctx.y}px` }"
      @click.stop
    >
      <div class="ctx-name mono">{{ ctx.name }}</div>
      <button class="ctx-item mono" data-testid="ctx-rename" @click="startRename">
        <span style="color: var(--green)">✎</span>Rename
      </button>
      <button class="ctx-item mono" data-testid="ctx-move-up" @click="ctxMove(-1)">
        <span>↑</span>Move up
      </button>
      <button class="ctx-item mono" data-testid="ctx-move-down" @click="ctxMove(1)">
        <span>↓</span>Move down
      </button>
      <button class="ctx-item mono danger" data-testid="ctx-remove" @click="ctxDelete">
        <span>🗑</span>Remove from list
      </button>
    </div>
  </div>

  <!-- Remove-project confirmation popup -->
  <div v-if="confirmRemove" class="overlay" @click.self="cancelRemove">
    <div class="dialog remove-dialog" data-testid="remove-dialog">
      <div class="rd-icon">🗑</div>
      <div class="rd-title mono">Remove {{ confirmRemove.name }}?</div>
      <div class="rd-body">
        <div class="rd-path faint mono">{{ confirmRemove.path }}</div>
        <p class="rd-note dim">
          The session and its pending permissions will be removed from switchboard. Your files and
          git history are untouched.
        </p>
        <p v-if="removeError" class="rd-error mono" data-testid="remove-error">{{ removeError }}</p>
      </div>
      <div class="rd-actions">
        <button
          class="btn-solid danger-solid"
          data-testid="remove-confirm"
          :disabled="busy"
          @click="confirmRemoveNow"
        >
          Delete
        </button>
        <button class="btn-outline" data-testid="remove-cancel" @click="cancelRemove">Keep it</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  width: 252px;
  min-width: 252px;
  background: var(--bg-panel);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.sidebar.collapsed {
  width: 64px;
  min-width: 64px;
}

.brand {
  padding: 16px 16px 12px;
}

.sidebar.collapsed .brand {
  padding: 16px 8px 12px;
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 4px;
}

.sidebar.collapsed .brand-top {
  flex-direction: column;
  gap: 8px;
}

.icon-btn {
  color: var(--text-tab);
  font-size: 12px;
  padding: 1px 4px;
}

.icon-btn:hover {
  color: var(--text-body);
}

.sidebar.collapsed .section-row {
  justify-content: center;
}

.initials {
  font-size: 11px;
  color: var(--text-body);
}

.sidebar.collapsed .project {
  text-align: center;
}

/* Drag-and-drop states: green insertion line for reorder, dashed teal ring
   for drop-to-reference (design reference). */
.project.drop-before {
  box-shadow: inset 0 2px 0 var(--green);
}

.project.drop-after {
  box-shadow: inset 0 -2px 0 var(--green);
}

/* Whole-row highlight while dragging an OS file onto a project (→ @path into
   its composer). Project drags only ever reorder, never reference. */
.project.drop-file {
  outline: 1px dashed var(--green);
  outline-offset: -1px;
  background: rgba(52, 211, 153, 0.06);
}

.sidebar.collapsed .row {
  justify-content: center;
}

.logo {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.02em;
}

.tagline {
  font-size: 10.5px;
  color: var(--text-faint);
  margin-top: 3px;
}

.section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px 6px;
}

.section-label {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--text-faint);
}

.add {
  font-size: 13px;
  color: var(--text-faint);
  line-height: 1;
}

.add:hover {
  color: var(--green);
}

.project-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0 8px;
}

.project {
  position: relative;
  margin: 0 8px 2px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
}

.project:hover {
  background: var(--bg-hover);
}

/* Per-project color code on the right edge (visible collapsed and expanded). */
.accent {
  position: absolute;
  right: 0;
  top: 7px;
  bottom: 7px;
  width: 3px;
  opacity: 0.55;
}

.project.active .accent {
  opacity: 1;
}

.active-bg {
  display: none;
}

.project.active .active-bg {
  display: block;
  position: absolute;
  inset: 0;
  background: var(--bg-active);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
}

.content {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-name);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Remove control: hidden until the row is hovered, like a close affordance. */
.remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 12px;
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  padding: 0;
}

.project:hover .remove {
  opacity: 1;
}

.remove:hover {
  color: var(--red);
}

/* Remove-project confirmation popup */
.remove-dialog {
  width: 380px;
}

.rd-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  background: rgba(143, 59, 44, 0.1);
  border: 1px solid rgba(143, 59, 44, 0.35);
  margin-bottom: 10px;
}

.rd-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.rd-body {
  margin: 12px 0 16px;
}

.rd-path {
  font-size: 10.5px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rd-note {
  font-size: 11.5px;
  line-height: 1.5;
  margin: 10px 0 0;
}

.rd-error {
  font-size: 11px;
  color: var(--red);
  margin: 8px 0 0;
}

.rd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.danger-solid {
  background: var(--red);
  border-color: var(--red);
  color: #1a0e0c;
}

.danger-solid:hover:not(:disabled) {
  background: #ef8573;
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-left: 16px;
  margin-top: 3px;
}

.branch,
.timer {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.path {
  padding-left: 16px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-ghost);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Agents working in parallel, listed under the row (design). */
.agents {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
  padding-left: 16px;
}

.agent-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 -4px;
  padding: 1px 4px;
  cursor: pointer;
}

.agent-line:hover {
  background: #1a1f2b;
}

.agent-name.sel {
  color: var(--text-strong);
}

.agent-sq {
  width: 5px;
  min-width: 5px;
  height: 5px;
  background: var(--blue);
  animation: sbFade 1.8s ease infinite;
}

.agent-name {
  font-size: 10px;
  color: #7e8698;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty {
  padding: 16px;
  font-size: 11px;
  color: var(--text-faint);
}

.rename-input {
  flex: 1;
  min-width: 40px;
  background: var(--bg);
  border: 1px solid var(--green);
  border-radius: 10px;
  outline: none;
  color: var(--text-strong);
  font-size: 12px;
  padding: 2px 7px;
}

.usage-card {
  margin: 8px 10px 0;
  padding: 9px 12px;
  border: 1px solid var(--border-card-alt);
  border-radius: 10px;
}

.usage-head {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-faint);
  margin-bottom: 6px;
}

.usage-bar {
  height: 5px;
  border-radius: 99px;
  background: #1b202c;
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  border-radius: 99px;
  transition: width 0.3s ease;
}

.usage-foot {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 6px;
}

/* MCP server row (design): ⛁ teal icon, name + status, connection dot, teal
   right stripe. */
.mcp-item {
  position: relative;
  margin: 4px 8px 0;
  padding: 9px 10px;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--border-card-alt);
  background: var(--bg-card-alt);
  cursor: pointer;
  user-select: none;
}

.mcp-item:hover {
  border-color: var(--border-strong);
}

.mcp-item.open {
  border-color: #2dd4bf;
  background: var(--bg-active);
}

.sidebar.collapsed .mcp-item {
  justify-content: center;
}

.mcp-ico {
  font-size: 13px;
  color: #2dd4bf;
  flex-shrink: 0;
}

.mcp-main {
  flex: 1;
  min-width: 0;
}

.mcp-name {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-sub {
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-dot {
  width: 7px;
  height: 7px;
  /* Round, unlike the square status dots — overrides the global corner reset. */
  border-radius: 50% !important;
  flex-shrink: 0;
}

.mcp-accent {
  position: absolute;
  right: 3px;
  top: 7px;
  bottom: 7px;
  width: 3px;
  background: #2dd4bf;
}

.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
}

.ctx-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  animation: sbIn 0.12s ease;
}

.ctx-name {
  padding: 8px 13px 6px;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border-card-alt);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 13px;
  font-size: 12px;
  color: var(--text-body);
  cursor: pointer;
  background: transparent;
}

.ctx-item:hover {
  background: var(--bg-chip);
  color: var(--text-strong);
}

.ctx-item.danger:hover {
  background: rgba(143, 59, 44, 0.08);
  color: var(--red);
}

.settings-row {
  margin: 10px 10px 0;
  padding: 9px 12px;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--border-card-alt);
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
}

.settings-row:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.gear {
  font-size: 13px;
  color: var(--text-meta);
}

.settings-label {
  flex: 1;
  font-size: 11.5px;
  color: var(--text-body);
}

.model-summary {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}

.stats {
  margin: 10px;
  padding: 10px 12px;
  background: var(--bg-card-alt);
  border: 1px solid var(--border-card-alt);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-meta);
}

.stat .val {
  color: var(--text);
}

.stat .val.amber {
  color: var(--amber);
}
</style>
