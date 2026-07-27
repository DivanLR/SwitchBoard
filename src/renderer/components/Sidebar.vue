<script setup lang="ts">
// Sidebar — 1:1 with the design reference: logo, PROJECTS list with animated
// status dots, mono names, per-project pending badges, branch + timer line,
// and the running / needs-you / cost-today stats card (FR-003/004/005).
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { modelLabel, type ProjectGroup } from '@shared/domain'
import { groupSections } from '@shared/project-groups'
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
const parallelAgents = computed(() => activeAgents(activeSession.events))

function agentsFor(
  item: (typeof projects.items)[number],
): { id: string; name: string; task: string }[] {
  if (item.id !== projects.selectedProjectId) return []
  if (statusOf(item) !== 'working') return []
  const agents = parallelAgents.value
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
  const id = settings.settings?.intelligentModel ?? 'default'
  if (id === 'default') return 'default model'
  return modelLabel(id)
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

const tokensLabel = computed(() =>
  // Compact notation; lowercase the 'K' suffix to keep the design's "1.2k" style.
  Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    .format(projects.counters.tokensToday)
    .replace('K', 'k'),
)

// --- Session usage meter (subscription rate limit from the SDK) ---
// Shown for ANY live session; the % fills in once the SDK reports a
// rate_limit_event (until then the meter shows a — placeholder).
const usageSession = computed(() => {
  const selected = projects.selected?.session
  if (selected && !selected.endedAt && selected.usageUtilization != null) return selected
  const live = projects.items.map((p) => p.session).filter((s) => s && !s.endedAt)
  return (
    live.find((s) => s!.usageUtilization != null) ??
    (selected && !selected.endedAt ? selected : null) ??
    live[0] ??
    null
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
  // Before the SDK reports a window, show the primary (5h) label as a placeholder.
  return '5h limit'
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
const dbServers = computed(() => settings.settings?.databaseMcpServers ?? [])
function mcpStatusOf(name: string): string {
  const session = dbProject.value?.session
  if (!session || session.endedAt) return 'not started'
  return session.mcpServers?.find((m) => m.name === name)?.status ?? 'connecting'
}
function mcpDot(status: string): string {
  const st = status.toLowerCase()
  if (st === 'connected') return 'var(--green)'
  if (st === 'failed' || st === 'error') return 'var(--red)'
  return 'var(--amber)'
}

// --- Collapsible project groups (sidebar-only organisation, kept in Settings
// beside the other per-project maps, so it persists with no schema change) ---
const groups = computed<ProjectGroup[]>(() => settings.settings?.projectGroups ?? [])
const groupOf = computed<Record<string, string>>(() => settings.settings?.projectGroupOf ?? {})
/** Sidebar filter (design: the ⌕ box under the logo). Narrows the list by name
 *  or branch — with a dozen projects, scanning beats scrolling. */
const filterQuery = ref('')
const filtered = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return projects.visibleItems
  return projects.visibleItems.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.session?.branch ?? '').toLowerCase().includes(q),
  )
})

/** Groups in order, then the ungrouped tail. Collapsed only hides the rows. */
const sections = computed(() => groupSections(filtered.value, groups.value, groupOf.value))

function saveGroups(next: ProjectGroup[]): void {
  void settings.save({ projectGroups: next })
}

/** Move a project into a group, or out of all groups with null. */
function assignGroup(projectId: string, groupId: string | null): void {
  const map = { ...groupOf.value }
  if (groupId) map[projectId] = groupId
  else delete map[projectId]
  void settings.save({ projectGroupOf: map })
}

function toggleGroup(id: string): void {
  saveGroups(groups.value.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)))
}

/** Adds a group and drops straight into inline naming. */
function newGroup(projectId?: string): void {
  const group: ProjectGroup = { id: crypto.randomUUID(), name: 'New group', collapsed: false }
  saveGroups([...groups.value, group])
  if (projectId) assignGroup(projectId, group.id)
  renamingGroupId.value = group.id
  renameVal.value = group.name
}

/** Removing a group never removes projects: they fall back to ungrouped. */
function removeGroup(id: string): void {
  const map = { ...groupOf.value }
  for (const [projectId, groupId] of Object.entries(map)) {
    if (groupId === id) delete map[projectId]
  }
  void settings.save({
    projectGroups: groups.value.filter((g) => g.id !== id),
    projectGroupOf: map,
  })
}

function moveGroup(id: string, delta: number): void {
  const from = groups.value.findIndex((g) => g.id === id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= groups.value.length) return
  const next = [...groups.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  saveGroups(next)
}

/** Pending items inside a group — kept visible while it is folded shut. */
function pendingInGroup(items: { id: string }[]): number {
  return items.reduce((sum, item) => sum + pendingFor(item.id), 0)
}

// --- Context menu (right-click) + inline rename ---
const ctx = ref<{
  kind: 'project' | 'group'
  id: string
  name: string
  x: number
  y: number
} | null>(null)
const renamingId = ref<string | null>(null)
const renamingGroupId = ref<string | null>(null)
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
  ctx.value = { kind: 'project', id: item.id, name: item.name, x: event.clientX, y: event.clientY }
}

function openGroupCtx(group: ProjectGroup, event: MouseEvent): void {
  ctx.value = { kind: 'group', id: group.id, name: group.name, x: event.clientX, y: event.clientY }
}

function closeCtx(): void {
  ctx.value = null
}

function startRename(): void {
  if (!ctx.value) return
  if (ctx.value.kind === 'group') renamingGroupId.value = ctx.value.id
  else renamingId.value = ctx.value.id
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

function commitGroupRename(): void {
  const id = renamingGroupId.value
  renamingGroupId.value = null
  if (!id) return
  const name = renameVal.value.trim()
  if (name.length > 0) saveGroups(groups.value.map((g) => (g.id === id ? { ...g, name } : g)))
}

function ctxDelete(): void {
  if (!ctx.value) return
  askRemove(ctx.value.id)
  ctx.value = null
}

function ctxMove(delta: number): void {
  if (!ctx.value) return
  if (ctx.value.kind === 'group') {
    moveGroup(ctx.value.id, delta)
    ctx.value = null
    return
  }
  const index = projects.items.findIndex((p) => p.id === ctx.value?.id)
  if (index !== -1) void projects.move(ctx.value.id, index + delta)
  ctx.value = null
}

/** Context-menu "Move to" — the keyboard-free route into a group. */
function ctxAssign(groupId: string | null): void {
  if (!ctx.value || ctx.value.kind !== 'project') return
  assignGroup(ctx.value.id, groupId)
  ctx.value = null
}

function ctxNewGroup(): void {
  if (!ctx.value) return
  const projectId = ctx.value.kind === 'project' ? ctx.value.id : undefined
  ctx.value = null
  newGroup(projectId)
}

function ctxRemoveGroup(): void {
  if (!ctx.value || ctx.value.kind !== 'group') return
  removeGroup(ctx.value.id)
  ctx.value = null
}

// --- Drag & drop (design): drag a row to REORDER only. Referencing another
// project is done by dragging it into the session pane (the chat), never by
// dropping one project onto another. OS files dropped on a row insert their
// @path into that project's composer. ---
const dragId = ref<string | null>(null)
const rowDrop = ref<{ id: string; zone: 'before' | 'after' | 'file' } | null>(null)
/** Group header highlighted as the drop target for the dragged project. */
const groupDrop = ref<string | null>(null)

function onGroupDragOver(group: ProjectGroup, event: DragEvent): void {
  if (!(event.dataTransfer?.types ?? []).includes('text/x-sb-project')) return
  event.preventDefault()
  groupDrop.value = group.id
}

function onGroupDrop(group: ProjectGroup | null, event: DragEvent): void {
  event.preventDefault()
  groupDrop.value = null
  const dragged = event.dataTransfer?.getData('text/x-sb-project') || dragId.value
  dragId.value = null
  if (dragged) assignGroup(dragged, group?.id ?? null)
}

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
  // Dropping among a group's rows also joins that group, so dragging into the
  // middle of a group does the obvious thing instead of only reordering.
  const targetGroup = groupOf.value[item.id] ?? null
  if ((groupOf.value[dragged] ?? null) !== targetGroup) assignGroup(dragged, targetGroup)
  await projects.move(dragged, toIndex)
}

function onDragEnd(): void {
  dragId.value = null
  rowDrop.value = null
  groupDrop.value = null
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
          v-if="!collapsed"
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

    <!-- Filter (design): narrows the list by project name or branch. -->
    <div v-if="!collapsed" class="filter-wrap">
      <div class="filter" :class="{ on: filterQuery.length > 0 }">
        <span class="filter-icon mono">⌕</span>
        <input
          v-model="filterQuery"
          class="filter-in"
          data-testid="project-filter"
          placeholder="Filter"
          @keydown.escape="filterQuery = ''"
        />
        <button
          v-if="filterQuery"
          class="filter-clear mono"
          data-testid="project-filter-clear"
          title="Clear"
          @click="filterQuery = ''"
        >
          ✕
        </button>
      </div>
    </div>

    <div class="section-row">
      <span v-if="!collapsed" class="section-label mono">PROJECTS</span>
      <!-- Single line, no surrounding whitespace: a text node around the glyph
           becomes a flex text run with trailing space that shifts + off-centre. -->
      <button
        v-if="!collapsed"
        class="add mono"
        data-testid="new-group"
        title="New group"
        @click="newGroup()"
      >⊞</button>
      <button class="add mono" data-testid="add-project" title="New session" @click="emit('add-project')">+</button>
    </div>

    <div class="project-list">
      <template v-for="section in sections" :key="section.group?.id ?? '__ungrouped'">
        <!-- Group header: click to fold, right-click for rename/reorder/remove,
             and a drop target for dragging a project in. Hidden on the collapsed
             rail, where there is no room for headers. -->
        <div
          v-if="section.group && !collapsed"
          class="group-head"
          :class="{ folded: section.group.collapsed, 'drop-into': groupDrop === section.group.id }"
          :data-testid="`group-head-${section.group.name}`"
          @click="toggleGroup(section.group.id)"
          @contextmenu.prevent.stop="openGroupCtx(section.group, $event)"
          @dragover="onGroupDragOver(section.group, $event)"
          @dragleave="groupDrop = groupDrop === section.group.id ? null : groupDrop"
          @drop="onGroupDrop(section.group, $event)"
        >
          <span class="group-caret mono">{{ section.group.collapsed ? '▸' : '▾' }}</span>
          <input
            v-if="renamingGroupId === section.group.id"
            :ref="focusOnMount"
            v-model="renameVal"
            class="rename-input mono"
            :data-testid="`group-rename-input-${section.group.name}`"
            @click.stop
            @keydown.enter="commitGroupRename"
            @keydown.esc="renamingGroupId = null"
            @blur="commitGroupRename"
          />
          <span v-else class="group-name mono">{{ section.group.name }}</span>
          <span style="flex: 1"></span>
          <span
            v-if="section.group.collapsed && pendingInGroup(section.items) > 0"
            class="badge-count"
            :data-testid="`group-badge-${section.group.name}`"
          >
            {{ pendingInGroup(section.items) }}
          </span>
          <span class="group-count mono" :data-testid="`group-count-${section.group.name}`">
            {{ section.items.length }}
          </span>
          <button
            class="remove mono"
            :data-testid="`group-remove-${section.group.name}`"
            title="Remove this group (its projects stay)"
            @click.stop="removeGroup(section.group.id)"
          >
            ✕
          </button>
        </div>
        <!-- Ungrouped tail is a drop target too, so a project can leave a group. -->
        <div
          v-else-if="!section.group && !collapsed && groups.length > 0"
          class="group-head ungrouped"
          data-testid="group-head-ungrouped"
          @dragover.prevent
          @drop="onGroupDrop(null, $event)"
        >
          <span class="group-name mono">EVERY OTHER PROJECT</span>
          <span style="flex: 1"></span>
          <span class="group-count mono" data-testid="group-count-ungrouped">
            {{ section.items.length }}
          </span>
        </div>

        <template v-if="collapsed || !section.group?.collapsed">
      <div
        v-for="item in section.items"
        :key="item.id"
        class="project"
        :class="{
          active: item.id === projects.selectedProjectId,
          grouped: !!section.group && !collapsed,
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
            <!-- Collapsed rail: initials (+ pending badge). One template so the
                 v-else below always pairs with the collapsed check itself. -->
            <template v-if="collapsed">
              <span class="initials mono">{{ initials(item.name) }}</span>
              <span
                v-if="pendingFor(item.id) > 0"
                class="badge-count collapsed-badge"
                :data-testid="`project-badge-${item.name}`"
              >
                {{ pendingFor(item.id) }}
              </span>
            </template>
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
                {{ agent.task || agent.name
                }}{{ activeSession.selectedAgentId === agent.id ? ' ←' : '' }}
              </span>
            </div>
          </div>
        </div>
      </div>
        </template>
      </template>
      <div v-if="projects.loaded && projects.visibleItems.length === 0" class="empty mono">
        No projects yet — press + to add one.
      </div>
    </div>

    <!-- Global MCP (design): one project-less row per designated server. They
         all open the same combined chat/scan view (see McpView). -->
    <template v-if="dbServers.length > 0 && dbProject">
      <div v-if="!collapsed" class="section-row mcp-section">
        <span class="section-label mono">MCP</span>
      </div>
      <div
        v-for="s in dbServers"
        :key="s"
        class="mcp-item"
        :class="{ open: activeSession.mcpOpen }"
        :title="`${s} — part of the combined MCP chat`"
        :data-testid="`mcp-server-${s}`"
        @click="activeSession.openMcp(true)"
      >
        <span class="mcp-ico">⛁</span>
        <template v-if="!collapsed">
          <div class="mcp-main">
            <div class="mcp-name mono">{{ s }}</div>
            <div class="mcp-sub mono">{{ mcpStatusOf(s) }}</div>
          </div>
          <span class="mcp-dot" :style="{ background: mcpDot(mcpStatusOf(s)) }"></span>
        </template>
        <span class="mcp-accent"></span>
      </div>
    </template>

    <button
      v-if="collapsed"
      class="icon-btn mono theme-collapsed"
      data-testid="theme-toggle"
      :title="
        theme === 'light' ? 'Switch to dark mode' : 'Light mode — easier to read in bright rooms'
      "
      @click="toggleTheme"
    >
      {{ theme === 'light' ? '☾' : '☀' }}
    </button>
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
        ><span class="val" data-testid="counter-cost-value">{{ costLabel }}</span>
      </div>
      <div class="stat mono" data-testid="counter-tokens">
        <span>Tokens today</span
        ><span class="val" data-testid="counter-tokens-value">{{ tokensLabel }}</span>
      </div>
    </div>

    <div v-if="!collapsed && usageSession" class="usage-card" data-testid="usage-meter">
      <div class="usage-head mono">
        <span>Session usage</span>
        <span v-if="usagePct !== null" :style="{ color: usageColor }">
          {{ usagePct }}% of {{ usageLimitLabel }}
        </span>
        <span v-else>— of {{ usageLimitLabel }}</span>
      </div>
      <div class="usage-bar">
        <div class="usage-fill" :style="{ width: `${usagePct ?? 0}%`, background: usageColor }"></div>
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
      <template v-if="ctx.kind === 'project'">
        <div class="ctx-sep"></div>
        <button class="ctx-item mono" data-testid="ctx-new-group" @click="ctxNewGroup">
          <span style="color: var(--green)">⊞</span>New group with this
        </button>
        <button
          v-for="g in groups"
          :key="g.id"
          class="ctx-item mono"
          :data-testid="`ctx-move-to-${g.name}`"
          @click="ctxAssign(g.id)"
        >
          <span>→</span>Move to {{ g.name }}
        </button>
        <button
          v-if="groupOf[ctx.id]"
          class="ctx-item mono"
          data-testid="ctx-move-to-ungrouped"
          @click="ctxAssign(null)"
        >
          <span>→</span>Move out of group
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item mono danger" data-testid="ctx-remove" @click="ctxDelete">
          <span>🗑</span>Remove from list
        </button>
      </template>
      <button
        v-else
        class="ctx-item mono danger"
        data-testid="ctx-remove-group"
        @click="ctxRemoveGroup"
      >
        <span>🗑</span>Remove group (keeps projects)
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
  /* Breathing room so the last footer section (usage/stats) never hugs the
     window edge. */
  padding-bottom: 8px;
}

.sidebar.collapsed {
  width: 64px;
  min-width: 64px;
}

.brand {
  padding: 16px 12px 12px 16px;
}

.sidebar.collapsed .brand {
  padding: 14px 0 10px;
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sidebar.collapsed .brand-top {
  flex-direction: column;
  gap: 10px;
}

.sidebar.collapsed .logo {
  font-size: 15px;
}

.icon-btn {
  color: var(--text-faint);
  font-size: 11px;
  padding: 1px 6px;
  line-height: 17px;
  border: 1px solid var(--border-card-alt);
}

.icon-btn[data-testid='theme-toggle']:hover,
.theme-collapsed:hover {
  color: var(--amber);
  border-color: var(--amber);
}

.icon-btn[data-testid='collapse-toggle']:hover {
  color: var(--green);
  border-color: var(--green);
}

/* Collapsed-rail theme toggle: bare icon (design's bottom footer), no chip. */
.theme-collapsed {
  border: none;
  padding: 0;
  line-height: normal;
  display: flex;
  justify-content: center;
  width: 100%;
  margin-top: 10px;
}

.sidebar.collapsed .section-row {
  justify-content: center;
}

.section-row.mcp-section {
  padding: 10px 16px 2px;
}

.initials {
  font-size: 11px;
  color: var(--text-body);
}

.sidebar.collapsed .project {
  text-align: center;
}

.sidebar.collapsed .content {
  padding: 1px 0;
}

.sidebar.collapsed .row {
  flex-direction: column;
  justify-content: center;
  gap: 5px;
}

/* Design: collapsed status dots are small squares, not the round 8px dot. */
.sidebar.collapsed .dot {
  width: 7px;
  min-width: 7px;
  height: 7px;
  border-radius: 0;
}

.collapsed-badge {
  font-size: 9px;
  background: rgba(154, 111, 42, 0.15);
  border-color: rgba(154, 111, 42, 0.4);
  border-radius: 0;
  padding: 0 4px;
  line-height: 12px;
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

/* Filter box (design): hairline field that greens on focus or when filtering. */
.filter-wrap {
  padding: 0 14px 10px 18px;
  flex-shrink: 0;
}

.filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border-seg);
  border-radius: 8px;
  transition:
    border-color 0.14s ease,
    box-shadow 0.14s ease;
}

.filter:focus-within,
.filter.on {
  border-color: var(--green);
}

.filter-icon {
  font-size: 12px;
  color: var(--text-faint);
}

.filter-in {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-name);
  font-family: var(--sans);
  font-size: 12px;
}

.filter-clear {
  font-size: 11px;
  color: var(--text-faint);
  cursor: pointer;
}

.filter-clear:hover {
  color: var(--text-strong);
}

.section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px 6px;
}

/* The label takes the slack so the row's buttons stay together on the right,
   rather than space-between spreading them across the row. */
.section-row .section-label {
  flex: 1;
}

.section-row .add + .add {
  margin-left: 6px;
}

.section-label {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--text-faint);
}

.add {
  /* Flex-center the + glyph in a fixed square — line-height boxes leave it
     sitting low/left of the visual middle. */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 13px;
  color: var(--text-faint);
  line-height: 1;
  padding: 0;
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
}

.add:hover {
  color: var(--green);
  border-color: var(--green);
}

.project-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0 8px;
}

/* --- Collapsible group headers --- */
.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 8px 2px;
  padding: 5px 8px 5px 6px;
  border-radius: var(--rc);
  cursor: pointer;
  color: var(--text-faint);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  user-select: none;
}

.group-head:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.group-head.drop-into {
  background: var(--bg-hover);
  box-shadow: inset 0 0 0 1px var(--green);
  color: var(--text);
}

/* The ungrouped divider is a label and a drop target, never foldable. */
.group-head.ungrouped {
  cursor: default;
  opacity: 0.65;
}

.group-caret {
  width: 9px;
  color: var(--text-faint);
}

.group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  font-size: 10px;
  opacity: 0.7;
}

.group-head .remove {
  position: static;
  opacity: 0;
}

.group-head:hover .remove {
  opacity: 0.7;
}

.project {
  position: relative;
  margin: 0 8px 2px;
  padding: 9px 12px 9px 10px;
  border-radius: var(--rc);
  cursor: pointer;
}

/* Rows inside a group sit indented under their header. */
.project.grouped {
  margin-left: 18px;
}

.project:hover {
  background: var(--bg-hover);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--elev);
}

/* Per-project color code on the right edge (visible collapsed and expanded). */
.accent {
  position: absolute;
  right: 3px;
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
  border-radius: var(--rc);
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

/* Remove-project confirmation popup: the design renders this as its own
   glass pane (not the shared .dialog card look) — wide, pill-cornered, with a
   heavier drop shadow, so every box-model property is overridden here. The
   scrim itself comes from the shared .overlay (var(--scrim) + blur). */
.remove-dialog {
  width: 400px;
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  /* A card, not a pill — 99px bows the corners in and clips the text. */
  border-radius: var(--rc);
  padding: 24px;
  box-shadow: var(--shadow-dlg);
  animation: sbIn 0.18s ease;
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
  border-radius: var(--rc);
}

.rd-title {
  font-size: 15.5px;
  font-weight: 600;
  color: var(--text-bright);
  margin-top: 14px;
}

.rd-body {
  margin: 6px 0 0;
}

.rd-path {
  font-size: 10.5px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rd-note {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-meta);
  margin: 0;
}

.rd-error {
  font-size: 11px;
  color: var(--red);
  margin: 8px 0 0;
}

.rd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 20px;
}

/* The design sizes these as equal-width, sans-serif, centered buttons —
   distinct from the shared .btn-solid/.btn-outline (mono, auto-width) look. */
.rd-actions .btn-solid,
.rd-actions .btn-outline {
  flex: 1;
  text-align: center;
  font-family: var(--sans);
  font-size: 12px;
  padding: 9px 0;
}

.rd-actions .btn-outline {
  color: var(--text-body);
}

.rd-actions .btn-outline:hover {
  border-color: var(--border-strong);
  color: var(--text-strong);
}

.danger-solid {
  background: var(--red);
  border-color: var(--red);
  color: var(--red-ink);
}

.danger-solid:hover:not(:disabled) {
  background: var(--red-hover);
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
  background: rgba(52, 211, 153, 0.1);
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
  color: var(--text-tab);
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
  border-radius: var(--rc);
  outline: none;
  color: var(--text-strong);
  font-size: 12px;
  padding: 2px 7px;
}

.usage-card {
  margin: 8px 10px 10px;
  padding: 9px 12px;
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  box-shadow: 0 1px 3px rgba(90, 98, 116, 0.16);
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
  background: rgba(255, 255, 255, 0.07);
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
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--border-card-alt);
  background: var(--gloss), var(--bg-card-alt);
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
}

.mcp-item:hover {
  border-color: var(--border-strong);
}

.mcp-item.open {
  border-color: var(--teal);
  background: var(--bg-active);
}

.sidebar.collapsed .mcp-item {
  justify-content: center;
}

.mcp-ico {
  font-size: 13px;
  color: var(--teal);
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
  background: var(--teal);
}

.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
}

.ctx-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-hover);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  overflow: hidden;
  box-shadow: var(--shadow-menu);
  animation: sbIn 0.12s ease;
}

.ctx-name {
  padding: 8px 13px 6px;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-faint);
  border-bottom: 1px solid rgba(52, 211, 153, 0.18);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-sep {
  height: 1px;
  margin: 3px 0;
  background: rgba(52, 211, 153, 0.18);
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
  background: rgba(52, 211, 153, 0.1);
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
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 3px rgba(90, 98, 116, 0.16);
}

.settings-row:hover {
  background: var(--bg-hover);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--elev);
  border-color: var(--border-strong);
}

/* Design collapses this to a bare centered gear, no card chrome. */
.sidebar.collapsed .settings-row {
  margin: 10px 0 12px;
  padding: 0;
  border: none;
  box-shadow: none;
  background: transparent;
  justify-content: center;
}

.sidebar.collapsed .settings-row:hover {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
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
  margin: 10px 10px 0;
  padding: 10px 12px;
  background: var(--bg-card);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: 0 1px 3px rgba(90, 98, 116, 0.16);
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
