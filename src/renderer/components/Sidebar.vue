<script setup lang="ts">
// Sidebar — 1:1 with the design reference: logo, PROJECTS list with status
// fold marks, mono names, per-project pending badges, branch + timer line,
// and the running / needs-you / cost-today stats card (FR-003/004/005).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { modelLabel, type ProjectGroup, type Session } from '@shared/domain'
import { groupSections } from '@shared/project-groups'
import { activeAgents } from '@shared/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useSettingsStore } from '@renderer/stores/settings'
// accentFor is gone from this file with the identity bar it coloured; the six-hue
// rotation still lives on in the group swatches, which read GROUP_COLORS.
import { GROUP_COLORS, mcpStatusColor } from '@renderer/project-accent'
import { elapsedClock } from '@renderer/relative-time'
import { useProjectGroups } from '@renderer/composables/useProjectGroups'
import { UNGROUPED, useProjectDragDrop } from '@renderer/composables/useProjectDragDrop'
import { trapTabWithin } from '@renderer/composables/useModal'
import { useNow } from '@renderer/composables/useNow'

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

// Stable per-project accent colour on the lane rule (shared with the
// session header dot) — identifies the project at a glance in the collapsed rail.
const now = useNow(1000)
onMounted(() => {
  if (!settings.settings) void settings.load()
  document.addEventListener('keydown', onOverlayKeydown, true)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onOverlayKeydown, true)
})

const collisions = computed(() => projects.nameCollisions)

function timerOf(startedAt: string): string {
  return elapsedClock(startedAt, now.value)
}

/**
 * Which state matters most when a project is running several sessions at once. The
 * project row can only draw one mark, and it must be the one that needs the developer:
 * PRODUCT.md's whole premise is knowing at a glance which project is blocked, so a
 * held session must not be hidden behind a focused one that happens to be idle.
 *
 * Lower index wins. Error before needs-you because a misfold is not going to clear
 * itself; both before working, which needs nothing from anyone.
 */
const STATUS_URGENCY = ['error', 'needs_you', 'working', 'done', 'ended', 'none']

/**
 * The states that mean a session actually exists behind this lane.
 *
 * Derived from the urgency list rather than spelled out again: everything above
 * 'ended' has a live process. 'done' belongs here and is the one worth naming —
 * the turn finished, the session did not, so the lane is still live and still
 * yours to type into. Only a session that ended, or a project that never started
 * one, reads as idle.
 */
const LIVE_STATES = new Set(STATUS_URGENCY.slice(0, STATUS_URGENCY.indexOf('ended')))

/**
 * The project row's own mark: the most urgent state across every session it is
 * running, not the state of whichever one the pane happens to be showing. With one
 * session — the only case that existed before subsessions — this is exactly the old
 * answer, because the list holds that one session and nothing else.
 */
function statusOf(item: (typeof projects.items)[number]): string {
  const states = item.sessions.map((s) => (s.endedAt ? 'ended' : s.status))
  if (states.length === 0) return item.session ? statusOfSession(item.session) : 'none'
  return states.reduce((worst, next) =>
    STATUS_URGENCY.indexOf(next) < STATUS_URGENCY.indexOf(worst) ? next : worst,
  )
}

function statusOfSession(session: Session): string {
  return session.endedAt ? 'ended' : session.status
}

/**
 * A lane reads expanded — its branch line showing — when it is selected OR when its
 * session is still running. Selection alone was the old rule, which meant a project
 * working away in the background collapsed to a single line the moment you looked at
 * another one, and the board's busiest rows were the least legible. A lane that has
 * ended, or never started, stays on one line: nothing about it is changing.
 */
function isExpanded(item: (typeof projects.items)[number]): boolean {
  return (
    item.id === projects.selectedProjectId || item.sessions.some((s) => !s.endedAt)
  )
}

/**
 * Each project's lane status, resolved once per change instead of per read.
 *
 * The row template asks for this nine times — the class, two data attributes,
 * the title, and a five-way branch picking the fold mark — so calling the
 * function inline re-derived the same answer nine times per row, on every
 * render of a list that redraws whenever any session ticks.
 */
const statusById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const item of projects.items) out[item.id] = statusOf(item)
  return out
})

/** Plain language, no vocabulary to learn. Hover and screen readers get the same
 *  words, and the mark beside them only narrows the guess. */
function markTitle(status: string): string {
  if (status === 'needs_you') return 'Needs you'
  if (status === 'working') return 'Working'
  if (status === 'error') return 'Error'
  if (status === 'ended') return 'Session ended'
  return 'Done'
}

/**
 * The one set character that stands for a lane's state, per DESIGN.md's fold
 * vocabulary. A function rather than the template's own v-if chain because a project
 * row and each of its subsession rows now draw the same mark, and two copies of this
 * mapping would be two places for a state to go missing.
 */
function glyphFor(status: string): string {
  if (status === 'needs_you') return '!'
  if (status === 'working') return '»'
  if (status === 'error') return '×'
  if (status === 'ended') return '·'
  return '—'
}

/** A single session's lane state; see statusOfSession, which this simply names. */
const sessionStatus = statusOfSession

function focusSub(projectId: string, sessionId: string): void {
  projects.select(projectId)
  projects.focusSession(projectId, sessionId)
}

function pendingFor(projectId: string): number {
  return inbox.pending.filter((p) => p.projectId === projectId).length
}

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
// Collapsible project groups (sidebar-only organisation, kept in Settings
// beside the other per-project maps, so it persists with no schema change).
// The inline-rename refs are declared here because the same pair also renames
// PROJECTS, which is the context menu's business rather than the group CRUD's.
const renamingGroupId = ref<string | null>(null)
const renameVal = ref('')
const {
  groups,
  groupOf,
  ungroupedFolded,
  saveGroups,
  assignGroup,
  toggleGroup,
  newGroup,
  removeGroup,
  moveGroup,
} = useProjectGroups({ renamingGroupId, renameVal })

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

// --- Context menu (right-click) + inline rename ---
const ctx = ref<{
  kind: 'project' | 'group'
  id: string
  name: string
  x: number
  y: number
} | null>(null)
const renamingId = ref<string | null>(null)

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

/**
 * Starts another session in this project, alongside whatever it is already running.
 * It uses the project's own session mode, like every other start that names none.
 * Failures land on the store's `starting` state and the ended-session banner the same
 * way the other start paths do, so this deliberately does not grow its own error UI.
 *
 * Reached from the row's own ＋ and from the context menu. The context menu used to
 * be the only way, which meant a project could run as many sessions as it liked and
 * nothing on screen ever said so.
 */
async function startAnotherSession(projectId: string): Promise<void> {
  projects.select(projectId)
  await projects.startSession(projectId).catch(() => {})
}

async function ctxNewSession(): Promise<void> {
  if (!ctx.value || ctx.value.kind !== 'project') return
  const projectId = ctx.value.id
  ctx.value = null
  await startAnotherSession(projectId)
}

/** The live sessions of the right-clicked project, for the end-all item. */
const ctxLiveSessions = computed<string[]>(() => {
  if (ctx.value?.kind !== 'project') return []
  const project = projects.items.find((p) => p.id === ctx.value?.id)
  return (project?.sessions ?? []).filter((s) => !s.endedAt).map((s) => s.id)
})

/**
 * End every session this project is running.
 *
 * Ending them one at a time was the only way, which is tedious at two and
 * genuinely annoying at four — and a project accumulates them, since a section
 * starts its own. Ended sessions drop out of the list on the refresh that
 * follows, so this is also how the row count comes back down.
 */
async function ctxEndAll(): Promise<void> {
  const ids = ctxLiveSessions.value
  ctx.value = null
  if (ids.length > 0) await projects.endSessions(ids)
}

function ctxRemoveGroup(): void {
  if (!ctx.value || ctx.value.kind !== 'group') return
  removeGroup(ctx.value.id)
  ctx.value = null
}

// Drag & drop (design): drag a row to REORDER only; dropping into a group's
// header or rows also joins it, and OS files dropped on a row insert their
// @path into that project's composer.
const {
  rowDrop,
  groupDrop,
  onGroupDragOver,
  onGroupDrop,
  onDragStart,
  onRowDragOver,
  onRowDrop,
  onDragEnd,
} = useProjectDragDrop({ groupOf, assignGroup })

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

// --- Change folder (repoint): declared before the shared overlay keydown/watch
// below, which read repointId at setup time ---
const repointId = ref<string | null>(null)
const repointVal = ref('')
const repointError = ref<string | null>(null)

const repointTarget = computed(() =>
  repointId.value ? (projects.items.find((p) => p.id === repointId.value) ?? null) : null,
)

function startRepoint(): void {
  if (!ctx.value || ctx.value.kind !== 'project') return
  repointVal.value = projects.items.find((p) => p.id === ctx.value?.id)?.path ?? ''
  repointError.value = null
  repointId.value = ctx.value.id
  ctx.value = null
}

function cancelRepoint(): void {
  repointId.value = null
  repointError.value = null
}

async function commitRepoint(): Promise<void> {
  if (!repointId.value) return
  const path = repointVal.value.trim()
  if (!path) return
  repointError.value = null
  busy.value = true
  try {
    await projects.repoint(repointId.value, path)
    repointId.value = null
  } catch (e) {
    repointError.value = isIpcError(e)
      ? e.code === 'ALREADY_ACTIVE'
        ? 'Stop the session before changing the folder.'
        : e.message
      : String(e)
  } finally {
    busy.value = false
  }
}

// Escape closes whichever overlay is open, and opening one moves focus into it.
// These live in Sidebar rather than in useModal because both are v-if blocks
// inside a component that mounts once, so a composable's onMounted would fire
// long before either overlay exists. Without this the context menu could only be
// dismissed with the mouse, and the remove dialogue could not be reached at all.
function onOverlayKeydown(event: KeyboardEvent): void {
  if (event.key === 'Tab' && (confirmRemoveId.value || repointId.value)) {
    trapTab(event)
    return
  }
  if (event.key !== 'Escape') return
  if (confirmRemoveId.value) {
    event.stopPropagation()
    cancelRemove()
  } else if (repointId.value) {
    event.stopPropagation()
    cancelRepoint()
  } else if (ctx.value) {
    event.stopPropagation()
    closeCtx()
  }
}

/** Keeps Tab inside the open remove/repoint dialog, using the same trap useModal
 *  applies — shared so the two cannot drift apart, even though this overlay
 *  cannot use the mount-time composable itself (see the note above). */
function trapTab(event: KeyboardEvent): void {
  const dialog = document.querySelector<HTMLElement>(
    '[data-testid="remove-dialog"], [data-testid="repoint-dialog"]',
  )
  if (dialog) trapTabWithin(dialog, event)
}

watch([ctx, confirmRemoveId, repointId], async ([menu, removing, repointing]) => {
  if (!menu && !removing && !repointing) return
  await nextTick()
  const selector = removing
    ? '[data-testid="remove-cancel"]'
    : repointing
      ? '[data-testid="repoint-input"]'
      : '.ctx-item'
  document.querySelector<HTMLElement>(selector)?.focus()
})

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
        <span class="spacer"></span>
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
        <span class="spacer"></span>
        <!-- The plus leads and the stack sits under it, so the mark reads add
             first. The words belong to the row rather than to the button: they
             borrow the heading's own label voice and sit out in the margin, where
             no amount of text can push the row's controls around. -->
        <button
          v-if="!collapsed"
          class="add add-caption"
          data-testid="new-group"
          aria-label="Add group"
          @click="newGroup()"
        >
          <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
            <path
              d="M7 1.4 L7 7.2 M4.1 4.3 L9.9 4.3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
            />
            <rect x="2.6" y="9.2" width="8.8" height="1.5" fill="currentColor" opacity=".6" />
            <rect x="4.2" y="11.8" width="5.6" height="1.5" fill="currentColor" opacity=".4" />
          </svg>
          <span class="caption section-label">Add group</span>
        </button>
        <!-- Single line, no surrounding whitespace: a text node around the glyph
             becomes a flex text run with trailing space that shifts + off-centre. -->
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
          class="group-empty"
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
          live: LIVE_STATES.has(statusById[item.id] ?? 'none'),
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
        <!-- Lane identity is a 1px stroke in the lane's own colour, run the full
             height of the row: still a stroke, never a coloured edge bar. The
             scored fold tick this replaced stood 26px in a 51px row, so it read as
             a fragment of a rule rather than as the lane's own edge. Drawn in CSS,
             because a hairline that has to match the row's height exactly is a
             worse job for artwork than for a border. -->
        <span
          class="brace"
          :data-testid="`project-accent-${item.name}`"
          aria-hidden="true"
        ></span>
        <div class="content">
          <div class="row">
            <!-- The lane's current sign: one set character in the state colour,
                 nothing behind it. HELD asks for you, DEPLOYING advances, MISFOLD
                 contradicts itself, PACKED FLAT closes to a point, and LOCKED is a
                 seated rule. The word beside it still settles it. -->
            <span
              v-if="statusById[item.id] !== 'none'"
              class="mark"
              :class="statusById[item.id]"
              :data-testid="`status-badge-${item.name}`"
              :data-status="statusById[item.id]"
              :title="markTitle(statusById[item.id])"
            >
              <span class="glyph" aria-hidden="true">{{ glyphFor(statusById[item.id]) }}</span>
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
              <!-- A project runs as many sessions as it is asked to. That was only
                   reachable by right-clicking the row, so nothing on screen said so. -->
              <button
                class="row-add mono"
                :data-testid="`new-session-${item.name}`"
                title="Start another session in this project"
                @click.stop="startAnotherSession(item.id)"
              >
                ＋
              </button>
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
          <!-- Branch belongs to the rows that are doing something: the one you are in,
               and any whose session is still running. Showing it on EVERY row turns the
               list into a wall of text, which is what the old selected-only rule was
               defending against — but it also hid the branch of every project working in
               the background, which is exactly when it is worth reading. -->
          <div v-if="!collapsed && isExpanded(item)" class="meta">
            <span class="branch code">⎇ {{ item.session?.branch ?? '—' }}</span>
          </div>
          <div v-if="!collapsed && collisions.has(item.name)" class="path code">{{ item.path }}</div>
          <!-- Subsessions. A project runs as many sessions as it is asked to, and each
               gets a row inside the project's own card: the card is the project, the
               rows in it are what that project is doing. Listed only when there is
               more than one, because with a single session the lane already IS that
               session and a lone child row would be noise. Nested inside .content, so
               the whole group moves and floats as one sheet. -->
          <div
            v-if="!collapsed && item.sessions.length > 1"
            class="subs"
            :data-testid="`sidebar-subsessions-${item.name}`"
          >
            <button
              v-for="(s, i) in item.sessions"
              :key="s.id"
              type="button"
              class="sub-line"
              :class="{ sel: item.session?.id === s.id }"
              :data-testid="`sidebar-subsession-${s.id}`"
              :title="`${markTitle(sessionStatus(s))} — ${s.name ?? s.branch ?? 'no branch'} · session ${s.id}`"
              @click.stop="focusSub(item.id, s.id)"
            >
              <span class="mark sub-mark" :class="sessionStatus(s)">
                <span class="glyph" aria-hidden="true">{{ glyphFor(sessionStatus(s)) }}</span>
              </span>
              <!-- Ordinal first: every session of a project runs against the same
                   checkout, so the branch name is identical on all of them and two
                   rows read as one repeated row without a number in front. The array
                   is start-ordered, so the number is stable for a session's life. -->
              <span class="sub-ord mono">{{ i + 1 }}</span>
              <!-- What it is about, when the app knows: every session of a
                   project runs against the same checkout, so the branch is
                   identical on all of them and the rows read as one repeated
                   row. A section's session knows what it was started for. -->
              <span class="sub-name code">{{ s.name ?? s.branch ?? s.id.slice(0, 8) }}</span>
              <span v-if="!s.endedAt" class="timer mono">{{ timerOf(s.startedAt) }}</span>
            </button>
          </div>
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
      <div v-if="projects.loaded && projects.visibleItems.length === 0" class="empty">
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
          <span class="mcp-dot" :style="{ background: mcpStatusColor(mcpStatusOf(s)) }"></span>
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
    <!-- Footer: Settings and the current work model, and nothing else. The
         counters, the token total and the limit meter moved to the window's
         status bar (components/StatusBar.vue): they describe the whole board, not
         this pane, and stacking them here cost the lane list a sixth of its
         height. -->
    <div v-if="!collapsed" class="foot">
      <div
        class="settings-row"
        data-testid="open-settings"
        role="button"
        tabindex="0"
        @click="emit('open-settings')"
        @keydown.enter.prevent="emit('open-settings')"
        @keydown.space.prevent="emit('open-settings')"
      >
        <span class="gear mono" aria-hidden="true">⚙</span>
        <span class="settings-label mono">Settings</span>
        <span class="model-summary mono" data-testid="model-summary">{{ modelSummary }}</span>
      </div>
    </div>

    <div
      v-if="collapsed"
      class="settings-row rail"
      data-testid="open-settings"
      role="button"
      tabindex="0"
      aria-label="Settings"
      @click="emit('open-settings')"
      @keydown.enter.prevent="emit('open-settings')"
      @keydown.space.prevent="emit('open-settings')"
    >
      <span class="gear mono" aria-hidden="true">⚙</span>
    </div>
  </aside>

  <!-- Right-click context menu -->
  <div v-if="ctx" class="ctx-catcher" @click="closeCtx" @contextmenu.prevent="closeCtx">
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
        <!-- A project can run more than one session; this is how a second one starts.
             It leads the project menu because it is the only item here that makes the
             project DO something rather than describe it. -->
        <button class="ctx-item mono" data-testid="ctx-new-session" @click="ctxNewSession">
          <span style="color: var(--green)">＋</span>New session here
        </button>
        <!-- The way back down. A project accumulates sessions — a section starts
             its own — and ending them one at a time is tedious at two. -->
        <button
          v-if="ctxLiveSessions.length > 1"
          class="ctx-item mono"
          data-testid="ctx-end-all"
          @click="ctxEndAll"
        >
          <span style="color: var(--red)">■</span>End all {{ ctxLiveSessions.length }} sessions
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item mono" data-testid="ctx-repoint" @click="startRepoint">
          <span style="color: var(--green)">⇄</span>Change folder…
        </button>
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

  <!-- Change-folder (repoint) popup: same shell as the remove dialog. -->
  <div v-if="repointTarget" class="overlay" @click.self="cancelRepoint">
    <div
      class="dialog remove-dialog"
      data-testid="repoint-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repoint-dialog-title"
    >
      <div class="rd-icon" aria-hidden="true">⇄</div>
      <div id="repoint-dialog-title" class="rd-title mono">
        Change folder for {{ repointTarget.name }}
      </div>
      <div class="rd-body">
        <input
          v-model="repointVal"
          class="mono repoint-input"
          data-testid="repoint-input"
          spellcheck="false"
          @keydown.enter="commitRepoint"
        />
        <p class="rd-note dim">
          Sessions, history, and folder access move to the new folder. The name stays
          {{ repointTarget.name }}.
        </p>
        <p v-if="repointError" class="rd-error mono" data-testid="repoint-error">
          {{ repointError }}
        </p>
      </div>
      <div class="rd-actions">
        <button
          class="btn-solid"
          data-testid="repoint-confirm"
          :disabled="busy || repointVal.trim().length === 0"
          @click="commitRepoint"
        >
          Change folder
        </button>
        <button class="btn-outline" data-testid="repoint-cancel" @click="cancelRepoint">
          Cancel
        </button>
      </div>
    </div>
  </div>

  <!-- Remove-project confirmation popup -->
  <div v-if="confirmRemove" class="overlay" @click.self="cancelRemove">
    <div
      class="dialog remove-dialog"
      data-testid="remove-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-dialog-title"
    >
      <div class="rd-icon" aria-hidden="true">🗑</div>
      <div id="remove-dialog-title" class="rd-title mono">Remove {{ confirmRemove.name }}?</div>
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
  /* Derived, not hand-synced: .group-head's sticky offset has to equal the
     section row's real height, and that height is the glyph buttons plus the row's
     symmetric padding. Change either part and the offset follows. */
  --add-h: 21px;
  --section-row-pad: 5px;
  /* The 1px is the seam ruled under the row (see .section-row): it is part of the
     row's real height, so a group header sticking at this offset would otherwise
     leave a one-pixel sliver of scrolling list showing above it. */
  --section-row-h: calc(var(--add-h) + 2 * var(--section-row-pad) + 1px);
  /* 252px fitted a proportional face. The interface moved onto the character
     grid, where a lowercase letter is roughly 0.6em wide instead of ~0.5em, so
     the same project names stopped fitting and truncated to "storef…" and
     "ml-pip…" — a lane you cannot read is a lane you cannot pick. Widened to
     hold the same names on the wider grid rather than shrinking the names,
     because the name is the one thing in the lane that has to be read. */
  width: 288px;
  min-width: 288px;
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
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
  font-size: var(--fs-head);
}

.icon-btn {
  color: var(--text-faint);
  font-size: var(--fs-meta);
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
  font-size: var(--fs-meta);
  color: var(--text-body);
}

/* The rail has 64px to spend, so a lane keeps its lift but gives most of the inset
   back: 8px either side plus the expanded padding would leave a card 23px of content
   to hold both a pair of initials and a pending count. */
.sidebar.collapsed .project {
  text-align: center;
  margin: 0 4px 5px;
  padding: 6px 4px;
}

.sidebar.collapsed .content {
  padding: 1px 0;
}

.sidebar.collapsed .row {
  flex-direction: column;
  justify-content: center;
  gap: 5px;
}

.collapsed-badge {
  font-size: var(--fs-micro);
  background: color-mix(in srgb, var(--amber) 15%, transparent);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  border-radius: 0;
  padding: 0 4px;
  line-height: 12px;
}

/* Drag-and-drop states: green insertion line for reorder, dashed teal ring for
   drop-to-reference (design reference). One mark each, now that there is no lift
   to carry alongside it. */
.project.drop-before {
  box-shadow: inset 0 2px 0 var(--green);
}

.project.drop-after {
  box-shadow: inset 0 -2px 0 var(--green);
}

/* Whole-row highlight while dragging an OS file onto a project (→ @path into
   its composer). Project drags only ever reorder, never reference. The wash layers
   over the card fill for the same reason hover does. */
.project.drop-file {
  outline: 1px dashed var(--green);
  outline-offset: -1px;
  background:
    linear-gradient(
      color-mix(in srgb, var(--green) 12%, transparent),
      color-mix(in srgb, var(--green) 12%, transparent)
    ),
    var(--bg-card);
}

.logo {
  font-size: var(--fs-body);
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
  /* 3px, not 8px: DESIGN.md names the filter field under the content radius, and
     8px is the interactive-row corner. Every other input in the app uses --rc. */
  border-radius: var(--rc);
  transition:
    border-color 0.14s var(--ease),
    box-shadow 0.14s ease;
}

.filter:focus-within,
.filter.on {
  border-color: var(--green);
}

.filter-icon {
  font-size: var(--fs-ui);
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
  font-size: var(--fs-ui);
}

.filter-clear {
  font-size: var(--fs-meta);
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
     The vertical padding is --section-row-pad and the buttons are --add-h, which
     is how var(--section-row-h) is computed — .group-head's sticky offset depends
     on this row's height matching it exactly, and the seam below counts too. */
  padding: var(--section-row-pad) 14px var(--section-row-pad) 18px;
  background: var(--bg-sticky);
}

/* The seam: where the panel's heading hands over to the list. It runs the full
   width, so it reads as a table head ruling off its body — everything below the
   line is the list. It used to clear a 7px gap below itself, which the floating
   lanes needed so the first sheet did not butt into the rule; rows do not need
   it, and the gap was reading as a dead band under the heading.

   Not on .mcp-section: that row is static, sits further down with its own padding, and
   was not part of what was reviewed. */
.section-row:not(.mcp-section) {
  border-bottom: 1px solid var(--border);
  margin-bottom: 2px;
}

.section-row.mcp-section {
  position: static;
  padding: 14px 18px 8px;
}

.section-label {
  font-size: var(--fs-meta);
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.section-count {
  font-size: var(--fs-meta);
  color: var(--text-ghost);
}

/* Bare glyph controls (design): no chrome until hovered. */
.add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--add-h);
  height: var(--add-h);
  font-size: var(--fs-body);
  color: var(--text-faint);
  line-height: 1;
  padding: 0 5px;
  border-radius: var(--rc);
}

.add:hover {
  color: var(--green);
  background: var(--bg-hover);
}

/* The row explains its own control. Hover or keyboard focus prints the words out
   in the margin beside the button, borrowing .section-label so the caption is
   literally the heading voice rather than a second one. Absolute, because this
   row is sticky and holds the section height every group header offsets from:
   nothing here may change width when a label appears. */
.add-caption {
  position: relative;
}

.add-caption .caption {
  position: absolute;
  right: calc(100% + 7px);
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  text-transform: uppercase;
  opacity: 0;
  pointer-events: none;
  transition: opacity 110ms var(--ease);
}

.add-caption:hover .caption,
.add-caption:focus-visible .caption {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .add-caption .caption {
    transition: none;
  }
}

.project-list {
  position: relative;
  flex: 1;
  overflow-y: auto;
  padding: 2px 0 8px;
  /* --lane-cast lived here: the one surface below the dialogue tier that DESIGN.md
     let cast a real shadow, granted by direction rather than by precedent. The
     direction has been withdrawn and the token with it, so the Earned Shadow Rule
     is whole again and only the overlay tier casts. */
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
  /* A group header names the rows under it, so it sits closer to them than to the
     group above. It was opened to 12px/6px when the lanes floated, because a header
     3px above a shadowed sheet read as attached to that one sheet. With rows there
     is nothing to detach from, and the extra 7px per group was pure height in the
     one pane whose height is always spoken for. */
  margin: 9px 0 2px;
  padding: 4px 18px 4px 16px;
  background: var(--bg-sticky);
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
  border-radius: var(--rc);
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
  border-radius: var(--rc);
}

.group-name {
  flex: 1;
  min-width: 0;
  /* Group names are typed by the developer — shown as typed. Uppercasing and
     letter-spacing a name like "Work stuff" reads as a label, not a folder. */
  font-size: var(--fs-meta);
  color: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  font-size: var(--fs-meta);
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
  /* Inset from the pane edges even though the lanes are not, because this is a
     dashed target rather than a row: a dashed rule running edge to edge reads as a
     torn panel, not as a place to drop something. */
  margin: 0 10px 3px;
  padding: 8px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  font-size: var(--fs-meta);
  color: var(--text-faint);
  text-align: center;
}

/* A lane is a ROW, not a tile. It was a tile for one release — inset, filled,
   floating on a cast shadow — and the owner's verdict was that eight lanes
   drawing eight rectangles/shadows/colour bars at rest, all at the same volume,
   meant no lane could raise its voice when it actually had news. Back to a
   plain row: no fill or cast at rest, full-bleed (reclaims the 16px inset, and
   ~1 more project per 6 rows), separated by rhythm and its own edge rule. */
.project {
  position: relative;
  margin: 0 0 1px;
  padding: 6px 13px;
  background: transparent;
  cursor: pointer;
  transition: background 0.12s var(--ease);
}

/* Hover is the FIRST fill a lane ever gets now, so it does the work the card tier
   used to do: it says "this row", and it is the only row saying it. */
.project:hover {
  background: var(--bg-hover);
}

/* Lanes are keyboard-operable (PRODUCT.md records keyboard and screen reader as
   requirements). Focus is an inset rule so it never shifts the lane's geometry. */
.project:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--green);
}

/* The five-hairline staff that used to be ruled across each lane is gone. Behind
   12px text in a 252px margin it read as guitar strings rather than as a staff,
   which is the opposite of what the metaphor was for. The lane still reads as a
   part through the marks that survived: its edge rule and its status glyph. */

/* The now-line — one shared animated rule that used to cross every lane — is
   gone with the score it belonged to: it was that world's one authored motion,
   and the state mark plus its word already say "working", which is why the
   reduced-motion block could stop every animation without losing information.
   Nothing replaces it; a sheet at rest does not pulse. */

/* THE LANE BAR REPORTS STATE (green = live session, orange = none), not
   identity — reversing the prior per-project accent bar. That bar hashed six
   hues out of the project id, dimmed to 0.45, precisely because those six also
   mean working/attention-owed/error elsewhere: eight lanes at full strength was
   noise wearing the signal's own vocabulary. Two colours, each meaning exactly
   what they look like, reads at a glance where six accent hues never did. Cost:
   telling rows apart is now the name's job; accentFor still colours the group
   swatches. Width settled at 2px on the right (needs less than the busier left
   edge did), sitting inside the sidebar's own 1px border — both halves of
   DESIGN.md's original rule for this bar (the width cap, the "never on the
   row's outer edge" clause) are superseded by this direction. */
.brace {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--idle);
  pointer-events: none;
  transition: background-color 0.12s var(--ease);
}

/* Live means a session exists and has not ended: working, waiting on you, errored
   or finished-but-open all still have a process behind them. Only an ended
   session and a project that never started one read as idle. */
.project.live .brace {
  background: var(--running);
}

/* Nothing separates one lane from the next but the 1px of air between them. No
   rules, no edges, no cast: a list of rows in a narrow pane already reads as a
   list, and every mark added to defend that is one more thing on screen.

   Selection no longer borrows the bar. The bar answers "is this project
   running", which is true or false whether or not you are looking at the row, so
   dimming it on the rows you are not in would hide the very thing it is for.
   Selection is carried by the --bg-active wash and the brighter name instead. */

.active-bg {
  display: none;
}

.project.active .active-bg {
  display: block;
  position: absolute;
  inset: 0;
  background: var(--bg-active);
  border-radius: var(--rc);
}

.content {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  /* 6px, not 7: four gaps across the row, so this is 4px of name back. See the
     padding note on .project. */
  gap: 6px;
}

/* The lane's current sign. Colour comes from meaning: amber for held (needs
   you), green for deploying (working), red for a misfold (error), and no hue
   at all for locked, because a done fold needs none.

   There is no plate, by decision rather than by drift: the tinted wash and the
   cut frame that used to sit under the mark were both taken out on request, so
   the state now rests on the set character and its hue alone. DESIGN.md still
   argues for the plate on the grounds that 1px geometry read as lint at the edge
   of vision; that argument was answered by setting the state rather than drawing
   it. The padding stays, as the mark's own room away from the name beside it. */
.mark {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--text-meta);
  padding: 2px;
}

/* The state is set, not drawn. The glyph box is a fixed 14x12, so the mark takes
   the same room down the lane whichever of the five characters lands in it, on
   the collapsed rail as well as in the list. The size is a glyph size, tuned to
   optical weight rather than to the type ramp (DESIGN.md, "Glyph sizing is not
   type sizing"). */
.mark .glyph {
  width: 14px;
  height: 12px;
  font-family: var(--mono);
  font-size: 13.8px;
  font-weight: 600;
  line-height: 12px;
  text-align: center;
}

.mark.needs_you {
  color: var(--amber);
}

/* The glyph and the lane bar report the same state, so they read the same
   token. Split them and paper would show a blue chevron beside a green bar. */
.mark.working {
  color: var(--running);
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

/* The project name sits in the margin, to the LEFT of where the lane begins.
   It needs no background of its own: an earlier pass gave it a background and
   spread shadow, and that read as a text input. */
.name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  font-weight: 500;
  color: var(--text-name);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project.active .name {
  color: var(--text-bright);
}

/* The selected lane is washed in 12% valley blue, which lifts the surface under its
   own metadata: the timer and path measure 4.32:1 there (dark) and the branch
   4.19:1 (light), so the one lane the interface highlights had the least readable
   detail line of any row. The branch only ever renders on the selected lane, so it
   only ever rendered on this wash. */
.project.active .timer,
.project.active .path,
.project.active .branch {
  color: var(--text-on-wash);
}

/* Remove control: hidden until the row is hovered, like a close affordance. */
.remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: var(--fs-ui);
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

/* Same box as .remove so adding it does not move the row, and revealed by the
   same hover, so the row is quiet until you are actually in it. */
.row-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: var(--fs-ui);
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  padding: 0;
}

.project:hover .row-add {
  opacity: 1;
}

.row-add:hover {
  color: var(--green);
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
  animation: sbIn 0.18s var(--ease);
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
  font-size: var(--fs-head);
  font-weight: 600;
  color: var(--text-bright);
  margin-top: 14px;
}

.rd-body {
  margin: 6px 0 0;
}

.rd-path {
  font-size: var(--fs-micro);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rd-note {
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-meta);
  margin: 0;
}

.rd-error {
  font-size: var(--fs-meta);
  color: var(--red);
  margin: 8px 0 0;
}

/* The repoint dialog's path input: the registration dialog's folder input,
   inside the remove dialog's shell. */
.repoint-input {
  width: 100%;
  font-size: var(--fs-ui);
  padding: 9px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  color: var(--text-strong);
  margin-bottom: 10px;
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
  font-size: var(--fs-ui);
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
  margin-top: 1px;
}

.branch {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Tabular figures so a ticking clock does not jitter the row's width. */
.timer {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--text-ghost);
}

.path {
  padding-left: 17px;
  margin-top: 2px;
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Subsession rows. Same nested-child idiom as .agents below — indented under the
   lane's reading edge, one line each, mono — because they are the same kind of thing
   at a different level: what this project is doing right now. A session is a bigger
   unit than a subagent, so it keeps a real status mark and a running clock, and it is
   a <button> because clicking it repoints the whole centre pane. */
.subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 5px;
  padding-left: 15px;
}

.sub-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 -4px;
  padding: 2px 4px;
  border: none;
  border-radius: var(--rc);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.sub-line:hover {
  background: var(--bg-hover);
}

/* The focused session, the one the pane is showing. A left rule rather than a fill:
   the lane's own identity bar already owns the left edge of the card, and this is the
   same gesture one level in. */
.sub-line.sel {
  background: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--green);
}

.sub-line:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: -1px;
}

.sub-mark {
  padding: 0;
}

/* The session's number in the project, dimmer than its branch: it is how you
   tell two rows apart, not what either row is about. */
.sub-ord {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  font-variant-numeric: tabular-nums;
}

.sub-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-tab);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-line.sel .sub-name {
  color: var(--text-strong);
}

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
  animation: sbFade 1.8s var(--ease) infinite;
}

.agent-name {
  font-size: var(--fs-micro);
  color: var(--text-tab);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty {
  padding: 16px;
  font-size: var(--fs-meta);
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
  font-size: var(--fs-ui);
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
  font-size: var(--fs-body);
  color: var(--teal);
  flex-shrink: 0;
}

.mcp-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
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

/* An OPAQUE surface, like every other floating menu here (.suggest-list in
   styles.css, .hctx-menu in InboxView). This used --bg-hover, which is a 6%
   wash meant for tinting a row that already has a background under it: over the
   project list the board showed straight through the menu and its own text, and
   in light mode there was almost nothing left to read. A menu floats above the
   page rather than sitting on it, so it brings its own ground. */
.ctx-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  overflow: hidden;
  box-shadow: var(--shadow-menu);
  animation: sbIn 0.12s var(--ease);
}

/* White, as the light sheet's floating surfaces are: the panel tone that reads
   as raised on carbon reads as sunken against a near-white page. */
html.sb-light .ctx-menu {
  background: var(--bg-card);
}

.ctx-name {
  padding: 8px 13px 6px;
  font-size: var(--fs-micro);
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
  font-size: var(--fs-ui);
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

/* Footer: one row, hairlined off from the list. It carries Settings and the
   work model only; every reading moved to the status bar. */
.foot {
  flex-shrink: 0;
  /* The room sits ABOVE the rule, not below it. A margin, not padding: the gap
     belongs between the lane list and the seam, so the rule reads as this
     footer's own top edge rather than as a line with a space under it. Padding
     is back to its original 6px, so the gear keeps the spacing it always had
     from the rule. */
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding: 6px 14px 7px 18px;
}
/* Settings is the last row of the footer block, highlighted only on hover. */
.settings-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 -8px -3px;
  padding: 7px 8px;
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
}

.settings-row:hover {
  background: var(--bg-hover);
}

.settings-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--green);
}

/* On the rail it is a bare centred gear, with no room for anything else. */
.settings-row.rail {
  margin: 10px 0 12px;
  justify-content: center;
}

.gear {
  font-size: var(--fs-body);
  color: var(--text-meta);
}

.settings-label {
  flex: 1;
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.model-summary {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}
</style>
