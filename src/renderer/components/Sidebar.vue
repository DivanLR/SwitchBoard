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
import { accentFor, GROUP_COLORS } from '@renderer/project-accent'

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

// Stable per-project accent bar on the row's leading edge (shared with the
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

/** The lane's mark named in both languages: the score term and what it means.
 *  Screen readers and hover both get the plain meaning, never the glyph alone. */
function markTitle(status: string): string {
  if (status === 'needs_you') return 'Fermata — held, needs you'
  if (status === 'working') return 'Playing — working'
  if (status === 'error') return 'Struck out — error'
  if (status === 'ended') return 'Tacet — session ended'
  return 'Fine — done'
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

/** Whether the ungrouped tail is folded. Not persisted like a real group's fold:
 *  it is a view preference on a section the developer never created. */
const ungroupedFolded = ref(false)

/**
 * The sections as the sidebar draws them: colour, fold state, count and pending
 * total per group, then the ungrouped tail.
 *
 * Filtering overrides folding — a folded group that holds a match opens rather
 * than hiding it — and a group with no match drops out entirely, so what is left
 * on screen is exactly what matched.
 */
const sections = computed(() => {
  const filtering = filterQuery.value.trim().length > 0
  const withColor = groups.value.map((group, index) => ({
    ...group,
    color: group.color ?? GROUP_COLORS[index % GROUP_COLORS.length],
  }))
  return groupSections(filtered.value, withColor, groupOf.value)
    .map((section) => {
      const folded = section.group
        ? section.group.collapsed && !filtering
        : ungroupedFolded.value && !filtering
      return {
        group: section.group,
        items: section.items,
        // The tail is only worth labelling once a group exists to contrast it.
        head: !!section.group || groups.value.length > 0,
        name: section.group?.name ?? 'Ungrouped',
        color: section.group?.color ?? 'var(--text-faint)',
        folded,
        pending: section.items.reduce((sum, item) => sum + pendingFor(item.id), 0),
        // Only a real, open, unfiltered group invites a drop when it is empty.
        emptyOpen: !!section.group && !folded && !filtering && section.items.length === 0,
      }
    })
    .filter((section) => !filtering || section.items.length > 0)
})

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

/** Folds a group, or the ungrouped tail when there is no id. */
function toggleGroup(id: string | null): void {
  if (!id) {
    ungroupedFolded.value = !ungroupedFolded.value
    return
  }
  saveGroups(groups.value.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)))
}

/** Adds a group and drops straight into inline naming. */
function newGroup(projectId?: string): void {
  const group: ProjectGroup = {
    id: crypto.randomUUID(),
    name: 'New group',
    collapsed: false,
    color: GROUP_COLORS[groups.value.length % GROUP_COLORS.length],
  }
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

// The ungrouped tail is a drop target too (it takes a project back out of its
// group), so it needs a key of its own in `groupDrop` — it has no id.
const UNGROUPED = '__ungrouped'

function onGroupDragOver(group: ProjectGroup | null, event: DragEvent): void {
  if (!(event.dataTransfer?.types ?? []).includes('text/x-sb-project')) return
  event.preventDefault()
  groupDrop.value = group?.id ?? UNGROUPED
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

    <div class="project-list">
      <!-- Sticky above the rows (design), so the heading and its controls stay
           reachable however far the list is scrolled. -->

      <div class="section-row">
        <template v-if="!collapsed">
          <span class="section-label mono">PROJECTS</span>
          <span class="section-count mono" data-testid="project-count">{{ filtered.length }}</span>
        </template>
        <span style="flex: 1"></span>
        <!-- Single line, no surrounding whitespace: a text node around the glyph
             becomes a flex text run with trailing space that shifts + off-centre. -->
        <button
          v-if="!collapsed"
          class="add mono"
          data-testid="new-group"
          title="New group"
          @click="newGroup()"
        >▤</button>
        <button class="add mono" data-testid="add-project" title="New session" @click="emit('add-project')">+</button>
      </div>


      <template v-for="section in sections" :key="section.group?.id ?? UNGROUPED">
        <!-- Group header: click to fold, right-click for rename/reorder/remove,
             and a drop target for dragging a project in. Hidden on the collapsed
             rail, where there is no room for headers. The ungrouped tail uses the
             same header, so it folds and accepts a drop like any other. -->
        <div
          v-if="section.head && !collapsed"
          class="group-head"
          :class="{ folded: section.folded, 'drop-into': groupDrop === (section.group?.id ?? UNGROUPED) }"
          :data-testid="section.group ? `group-head-${section.name}` : 'group-head-ungrouped'"
          :title="`${section.name} · ${section.items.length} ${section.items.length === 1 ? 'project' : 'projects'} — drag a project here to move it in`"
          @click="toggleGroup(section.group?.id ?? null)"
          @contextmenu.prevent.stop="section.group && openGroupCtx(section.group, $event)"
          @dragover="onGroupDragOver(section.group, $event)"
          @dragleave="groupDrop = groupDrop === (section.group?.id ?? UNGROUPED) ? null : groupDrop"
          @drop="onGroupDrop(section.group, $event)"
        >
          <span class="group-caret mono">{{ section.folded ? '▶' : '▼' }}</span>
          <span class="group-swatch" :style="{ background: section.color }"></span>
          <input
            v-if="section.group && renamingGroupId === section.group.id"
            :ref="focusOnMount"
            v-model="renameVal"
            class="rename-input mono"
            :data-testid="`group-rename-input-${section.name}`"
            @click.stop
            @keydown.enter="commitGroupRename"
            @keydown.esc="renamingGroupId = null"
            @blur="commitGroupRename"
          />
          <span v-else class="group-name mono">{{ section.name }}</span>
          <span
            v-if="section.pending > 0"
            class="badge-count"
            :data-testid="section.group ? `group-badge-${section.name}` : 'group-badge-ungrouped'"
          >
            {{ section.pending }}
          </span>
          <span
            class="group-count mono"
            :data-testid="section.group ? `group-count-${section.name}` : 'group-count-ungrouped'"
          >
            {{ section.items.length }}
          </span>
          <button
            v-if="section.group"
            class="remove mono"
            :data-testid="`group-remove-${section.name}`"
            title="Remove this group (its projects stay)"
            @click.stop="removeGroup(section.group.id)"
          >
            ✕
          </button>
        </div>

        <!-- An empty open group says what it is for, and takes the drop itself. -->
        <div
          v-if="section.emptyOpen && !collapsed"
          class="group-empty mono"
          :data-testid="`group-empty-${section.name}`"
          @dragover="onGroupDragOver(section.group, $event)"
          @drop="onGroupDrop(section.group, $event)"
        >
          Drag a project here
        </div>

        <template v-if="collapsed || !section.folded">
      <div
        v-for="item in section.items"
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
        role="option"
        :aria-selected="item.id === projects.selectedProjectId"
        :tabindex="renamingId === item.id ? -1 : 0"
        @click="projects.select(item.id)"
        @keydown.enter.prevent="projects.select(item.id)"
        @keydown.space.prevent="projects.select(item.id)"
        @contextmenu.prevent="openCtx(item, $event)"
        @dragstart="onDragStart(item, $event)"
        @dragover="onRowDragOver(item, $event)"
        @dragleave="rowDrop = rowDrop?.id === item.id ? null : rowDrop"
        @drop="onRowDrop(item, $event)"
        @dragend="onDragEnd"
      >
        <div class="active-bg"></div>
        <!-- Now, crossing this lane. Only drawn while something is playing. -->
        <span
          v-if="!collapsed && projects.counters.running > 0"
          class="now"
          aria-hidden="true"
        ></span>
        <!-- Part identity is a brace, not a coloured edge bar: a 1px stroke in
             the lane's own colour, always drawn the way a score always braces
             its parts. -->
        <span
          class="brace"
          :data-testid="`project-accent-${item.name}`"
          :style="{ color: accentFor(item.id) }"
          aria-hidden="true"
        >
          <svg viewBox="0 0 5 26" width="5" height="26">
            <path
              d="M4 1 C1.6 1 1.6 6 1.6 13 C1.6 20 1.6 25 4 25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
        </span>
        <div class="content">
          <div class="row">
            <!-- The lane's current sign. Every state is a real mark: a fermata
                 is a hold awaiting release, a beamed note is playing, a
                 thin-thick double barline is fine, a struck bar is an error,
                 and a bar rest is tacet. -->
            <span
              v-if="statusOf(item) !== 'none'"
              class="mark"
              :class="statusOf(item)"
              :data-testid="`status-badge-${item.name}`"
              :data-status="statusOf(item)"
              :title="markTitle(statusOf(item))"
            >
              <svg viewBox="0 0 16 14" width="16" height="14" aria-hidden="true">
                <template v-if="statusOf(item) === 'needs_you'">
                  <path
                    d="M1.5 11.5 A6.5 6.5 0 0 1 14.5 11.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                  />
                  <circle cx="8" cy="7.6" r="1.5" fill="currentColor" />
                </template>
                <template v-else-if="statusOf(item) === 'working'">
                  <ellipse
                    cx="4.6"
                    cy="10.4"
                    rx="3"
                    ry="2.2"
                    fill="currentColor"
                    transform="rotate(-20 4.6 10.4)"
                  />
                  <rect x="7.1" y="2" width="1.3" height="8.6" fill="currentColor" />
                  <rect x="7.1" y="2" width="6.9" height="2.1" fill="currentColor" />
                </template>
                <template v-else-if="statusOf(item) === 'error'">
                  <rect x="7.2" y="1" width="1.4" height="12" fill="currentColor" />
                  <path d="M2 12.4 L14 1.6" stroke="currentColor" stroke-width="1.6" />
                </template>
                <template v-else-if="statusOf(item) === 'ended'">
                  <rect x="3" y="6" width="10" height="2.6" fill="currentColor" />
                  <rect x="3" y="4.7" width="10" height="1" fill="currentColor" opacity=".45" />
                </template>
                <template v-else>
                  <rect x="8" y="1" width="1.2" height="12" fill="currentColor" />
                  <rect x="11" y="1" width="3" height="12" fill="currentColor" />
                </template>
              </svg>
            </span>
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
              <!-- Design: the elapsed time rides on the title line, not below it. -->
              <span
                v-if="item.session && !item.session.endedAt"
                class="timer mono"
                :data-testid="`timer-${item.name}`"
              >
                {{ timerOf(item.session.startedAt) }}
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
          <!-- Branch belongs to the row you are working in: showing it on every
               row turns the list into a wall of text (design). -->
          <div v-if="!collapsed && item.id === projects.selectedProjectId" class="meta">
            <span class="branch mono">⎇ {{ item.session?.branch ?? '—' }}</span>
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
        :title="`${s} — ${mcpStatusOf(s)} · part of the combined MCP chat`"
        :data-testid="`mcp-server-${s}`"
        @click="activeSession.openMcp(true)"
      >
        <span class="mcp-ico">⛁</span>
        <template v-if="!collapsed">
          <!-- The dot IS the status; spelling it out under the name doubled the
               row's height to repeat what the colour already says. -->
          <div class="mcp-name mono">{{ s }}</div>
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
    <!-- Footer (design): the counters as one inline run, a hairline usage bar,
         and Settings as the last row — one block, not three stacked cards. -->
    <div v-if="!collapsed" class="foot">
      <!-- One run of numbers, not a grid of labelled cells: the four counters
           read left to right and the meter below owns the limit story. -->
      <div class="foot-line mono">
        <span class="foot-stat" data-testid="counter-running">
          <span class="foot-dot" style="background: var(--blue)"></span>
          <span data-testid="counter-running-value">{{ projects.counters.running }}</span> running
        </span>
        <span class="foot-stat" data-testid="counter-needsyou">
          <span class="foot-dot" style="background: var(--amber)"></span>
          <span class="amber" data-testid="counter-needsyou-value">{{ projects.counters.needsYou }}</span>
          waiting
        </span>
        <span style="flex: 1"></span>
        <span class="foot-stat" data-testid="counter-cost">
          <span data-testid="counter-cost-value">{{ costLabel }}</span>
        </span>
        <span class="foot-stat" data-testid="usage-tokens">{{ tokensLabel }} tok</span>
      </div>

      <div v-if="usageSession" class="usage" data-testid="usage-meter">
        <div class="usage-bar">
          <div class="usage-fill" :style="{ width: `${usagePct ?? 0}%`, background: usageColor }"></div>
        </div>
        <div class="usage-foot mono">
          <span v-if="usagePct !== null" :style="{ color: usageColor }">
            {{ usagePct }}% of {{ usageLimitLabel }}
          </span>
          <span v-else>— of {{ usageLimitLabel }}</span>
          <span v-if="usageReset">Resets in {{ usageReset }}</span>
        </div>
      </div>

      <div class="settings-row" data-testid="open-settings" @click="emit('open-settings')">
        <span class="gear mono">⚙</span>
        <span class="settings-label mono">Settings</span>
        <span class="model-summary mono" data-testid="model-summary">{{ modelSummary }}</span>
      </div>
    </div>

    <div v-else class="settings-row rail" data-testid="open-settings" @click="emit('open-settings')">
      <span class="gear mono">⚙</span>
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
  /* The PROJECTS bar's height, shared so the group headers that stick beneath it
     cannot drift out of sync. This was a hard-coded 31px in two places, and
     changing the bar's padding silently desynced them. */
  --section-row-h: 31px;
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

/* On the rail there is no staff to read, so the mark shrinks to its glyph and
   carries the whole state on its own. */
.sidebar.collapsed .mark svg {
  width: 13px;
  height: 11px;
}

.collapsed-badge {
  font-size: 9px;
  background: color-mix(in srgb, var(--amber) 15%, transparent);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
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
  background: color-mix(in srgb, var(--green) 6%, transparent);
}

.logo {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.02em;
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

/* Design: the heading rides above the rows on a blurred bar rather than
   scrolling away with them, so its controls are reachable from anywhere. */
.section-row {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Symmetric vertical padding. It was 2px top against 8px bottom, which left the
     content band sitting 3px above the block's centre: align-items centred the
     children within the band, but the band itself was high.
     5px + 21px (the glyph buttons) + 5px keeps the row at exactly
     var(--section-row-h), which .group-head's sticky offset depends on. */
  padding: 5px 14px 5px 18px;
  background: var(--bg-sticky);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.section-row.mcp-section {
  position: static;
  padding: 14px 18px 8px;
}

.section-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.section-count {
  font-size: 11px;
  color: var(--text-ghost);
}

/* Bare glyph controls (design): no chrome until hovered. */
.add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 21px;
  height: 21px;
  font-size: 13px;
  color: var(--text-faint);
  line-height: 1;
  padding: 0 5px;
  border-radius: 6px;
}

.add:hover {
  color: var(--green);
  background: var(--bg-hover);
}

.project-list {
  position: relative;
  flex: 1;
  overflow-y: auto;
  padding: 2px 0 8px;
}

@keyframes nowBreath {
  0%,
  100% {
    opacity: 0.34;
  }
  50% {
    opacity: 0.72;
  }
}

/* --- Collapsible group headers ---
   Full-bleed and sticky under the PROJECTS bar (design), so the group a row
   belongs to is still named once its header has scrolled past. */
.group-head {
  position: sticky;
  top: var(--section-row-h);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 3px;
  padding: 4px 18px 4px 16px;
  background: var(--bg-sticky);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  cursor: pointer;
  user-select: none;
}

.group-head > * {
  position: relative;
}

.group-head:hover .group-name {
  color: var(--text-strong);
}

/* Drop highlight is an inset overlay, not a border, so the sticky bar keeps
   its exact height as a project is dragged over it. */
.group-head.drop-into::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  top: 0;
  bottom: 0;
  border: 1px dashed var(--green);
  background: color-mix(in srgb, var(--green) 8%, transparent);
  border-radius: 6px;
}

.group-caret {
  width: 8px;
  font-size: 8px;
  color: var(--text-faint);
}

/* The group's own colour, carried from the palette it was created with. */
.group-swatch {
  width: 6px;
  min-width: 6px;
  height: 6px;
  border-radius: 2px;
}

.group-name {
  flex: 1;
  min-width: 0;
  /* Group names are typed by the developer — shown as typed. Uppercasing and
     letter-spacing a name like "Work stuff" reads as a label, not a folder. */
  font-size: 11.5px;
  color: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  font-size: 11px;
  color: var(--text-faint);
}

.group-head .remove {
  position: static;
  opacity: 0;
}

.group-head:hover .remove {
  opacity: 0.7;
}

/* An open group with nothing in it: the drop target IS the explanation. */
.group-empty {
  margin: 0 10px 2px;
  padding: 9px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
}

/* A lane is full-bleed and square: a staff runs to both margins and a staff has
   no corners. This is where the outgoing world's inset 8px-radius card row was. */
.project {
  position: relative;
  margin: 0 0 2px;
  padding: 8px 18px 8px 13px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.project:hover {
  background: var(--bg-hover);
}

/* Lanes are keyboard-operable (PRODUCT.md records keyboard and screen reader as
   requirements). Focus is an inset rule so it never shifts the lane's geometry. */
.project:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--green);
}

/* The staff: five rules the lane is ruled with, drawn as a repeating gradient so
   there is no markup cost per line. It spans the lane's full width because a
   staff is the lane's material, not a divider between rows. */
/* The five-hairline staff that used to be ruled across each lane is gone. Behind
   12px text in a 252px margin it read as guitar strings rather than as a staff,
   which is the opposite of what the metaphor was for. The lane still reads as a
   part through three marks that survived: its brace, its notation glyph, and the
   now-line crossing it. */

/* The now-line, one per lane at the same offset so it reads as a single rule
   crossing the score. Per-lane rather than one tall element because a now-line
   must cross staves, not empty plate below the last part. They share one
   animation, so this stays a single authored moment. */
.now {
  position: absolute;
  top: 0;
  bottom: 0;
  /* The lane's present edge. Two earlier positions both landed inside the
     timer's digits, and a rule through a numeral is unreadable; at the edge it
     reads as "everything left of this has happened" and can never collide. */
  right: 5px;
  width: 1px;
  pointer-events: none;
  background: var(--green);
  animation: nowBreath 3.2s ease-in-out infinite;
}

/* Part identity: a brace in the lane's colour. A 1px stroke, because a coloured
   edge bar above 1px on a list item is exactly the habit this world refuses. */
.brace {
  position: absolute;
  left: 1px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  pointer-events: none;
  opacity: 0.75;
}

.project.active .brace {
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
  border-radius: 8px;
}

.content {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  gap: 7px;
}

/* The lane's current sign. Colour comes from meaning: the pencil for a hold,
   the now-line's cyan for playing, oxblood for a struck bar, and no hue at all
   for fine, because a double barline needs none. */
.mark {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--text-meta);
}

.mark.needs_you {
  color: var(--amber);
}

.mark.working {
  color: var(--green);
}

.mark.error {
  color: var(--red);
}

.mark.done {
  color: var(--text-mid);
}

.mark.ended {
  color: var(--text-ghost);
}

/* The part name sits in the margin, to the LEFT of where the staff begins, which
   is where a score puts its instrument names. It needs no plate: an earlier pass
   gave it a background and spread shadow, and that read as a text input. */
.name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-name);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project.active .name {
  color: var(--text-bright);
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
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
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
  padding-left: 17px;
  margin-top: 2px;
}

.branch {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Tabular figures so a ticking clock does not jitter the row's width. */
.timer {
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-ghost);
}

.path {
  padding-left: 17px;
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
  margin-top: 5px;
  padding-left: 17px;
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
  background: color-mix(in srgb, var(--green) 10%, transparent);
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

.mcp-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
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
  border-bottom: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-sep {
  height: 1px;
  margin: 3px 0;
  background: color-mix(in srgb, var(--green) 18%, transparent);
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
  background: color-mix(in srgb, var(--green) 10%, transparent);
  color: var(--text-strong);
}

.ctx-item.danger:hover {
  background: color-mix(in srgb, var(--red) 8%, transparent);
  color: var(--red);
}

/* Footer: one block hairlined off from the list (design), not a stack of cards. */
.foot {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  padding: 11px 14px 13px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.foot-line {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 11px;
  color: var(--text-faint);
}

.foot-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  /* The four counters share one line, so a stat must never wrap its unit onto a
     second row ("0" above "tok") when the sidebar is at its narrowest. */
  white-space: nowrap;
}

.foot-stat .amber {
  color: var(--amber);
}

.foot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* A 3px hairline, not a meter: it reports, it does not demand attention. */
.usage-bar {
  height: 3px;
  border-radius: 99px;
  background: var(--bg-seg);
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
  gap: 8px;
  font-size: 10.5px;
  color: var(--text-ghost);
  margin-top: 4px;
}

/* Settings is the last row of the footer block, highlighted only on hover. */
.settings-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 -8px -3px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}

.settings-row:hover {
  background: var(--bg-hover);
}

/* On the rail it is a bare centred gear, with no room for anything else. */
.settings-row.rail {
  margin: 10px 0 12px;
  justify-content: center;
}

.gear {
  font-size: 13px;
  color: var(--text-meta);
}

.settings-label {
  flex: 1;
  font-size: 12px;
  color: var(--text-body);
}

.model-summary {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}
</style>
