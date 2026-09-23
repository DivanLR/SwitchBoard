<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { modelLabel, type ProjectGroup, type Session } from '@shared/domain'
import { groupSections } from '@shared/project-groups'
import { activeAgents } from '@shared/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useSettingsStore } from '@renderer/stores/settings'
import { GROUP_COLORS, mcpStatusColor } from '@renderer/project-accent'
import { elapsedClock } from '@renderer/relative-time'
import { useProjectGroups } from '@renderer/composables/useProjectGroups'
import { UNGROUPED, useProjectDragDrop } from '@renderer/composables/useProjectDragDrop'
import { trapTabWithin } from '@renderer/composables/useModal'
import { useNow } from '@renderer/composables/useNow'
import Icon from '@renderer/components/Icon.vue'

const projects = useProjectsStore()
const activeSession = useActiveSessionStore()
const inbox = useInboxStore()
const settings = useSettingsStore()

const parallelAgents = computed(() => activeAgents(activeSession.events))

const agentsByProject = computed<Record<string, { id: string; name: string; task: string }[]>>(
  () => {
    const selectedId = projects.selectedProjectId
    const selected = selectedId ? projects.items.find((p) => p.id === selectedId) : undefined
    if (!selected || statusOf(selected) !== 'working') return {}
    const agents = parallelAgents.value
    return agents.length > 1 ? { [selected.id]: agents } : {}
  },
)

function openAgent(agentId: string): void {
  activeSession.selectAgent(agentId)
}
const emit = defineEmits<{
  (e: 'add-project'): void
  (e: 'open-settings'): void
}>()

const modelSummary = computed(() => {
  const id = settings.settings?.model ?? 'default'
  if (id === 'default') return 'default model'
  return modelLabel(id)
})

const collapsed = ref(false)
const theme = ref<'dark' | 'light'>(localStorage.getItem('sb-theme') === 'dark' ? 'dark' : 'light')

function applyTheme(): void {
  document.documentElement.classList.toggle('sb-light', theme.value === 'light')
}

function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  localStorage.setItem('sb-theme', theme.value)
  applyTheme()
}
applyTheme() 

function initials(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toLowerCase()
}

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

const showTimer = computed(() => settings.settings?.showSessionTimer ?? true)

const STATUS_URGENCY = ['error', 'needs_you', 'working', 'done', 'ended', 'none']

const LIVE_STATES = new Set(STATUS_URGENCY.slice(0, STATUS_URGENCY.indexOf('ended')))

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

function isExpanded(item: (typeof projects.items)[number]): boolean {
  return (
    item.id === projects.selectedProjectId || item.sessions.some((s) => !s.endedAt)
  )
}

const statusById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const item of projects.items) out[item.id] = statusOf(item)
  return out
})

function markTitle(status: string): string {
  if (status === 'needs_you') return 'Needs you'
  if (status === 'working') return 'Working'
  if (status === 'error') return 'Error'
  if (status === 'ended') return 'Session ended'
  return 'Done'
}

function glyphFor(status: string): string {
  if (status === 'needs_you') return '!'
  if (status === 'working') return '»'
  if (status === 'error') return '×'
  if (status === 'ended') return '·'
  return '—'
}

const sessionStatus = statusOfSession

function isFocusedSub(item: (typeof projects.items)[number], sessionId: string): boolean {
  return item.id === projects.selectedProjectId && item.session?.id === sessionId
}

function focusSub(projectId: string, sessionId: string): void {
  projects.select(projectId)
  projects.focusSession(projectId, sessionId)
}

function endOneSession(sessionId: string): void {
  void projects.endSessions([sessionId])
}

const pendingByProject = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {}
  for (const item of inbox.pending) out[item.projectId] = (out[item.projectId] ?? 0) + 1
  return out
})

const dbProject = computed(() => projects.dbProject)
const dbServers = computed(() => settings.settings?.databaseMcpServers ?? [])
function mcpStatusOf(name: string): string {
  const session = dbProject.value?.session
  if (!session || session.endedAt) return 'not started'
  return session.mcpServers?.find((m) => m.name === name)?.status ?? 'connecting'
}
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

const filterQuery = ref('')
const filtered = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return projects.visibleItems
  return projects.visibleItems.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.session?.branch ?? '').toLowerCase().includes(q),
  )
})

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
        head: !!section.group || groups.value.length > 0,
        name: section.group?.name ?? 'Ungrouped',
        color: section.group?.color ?? 'var(--text-faint)',
        folded,
        pending: section.items.reduce((sum, item) => sum + (pendingByProject.value[item.id] ?? 0), 0),
        emptyOpen: !!section.group && !folded && !filtering && section.items.length === 0,
      }
    })
    .filter((section) => !filtering || section.items.length > 0)
})

const ctx = ref<{
  kind: 'project' | 'group'
  id: string
  name: string
  x: number
  y: number
} | null>(null)
const renamingId = ref<string | null>(null)

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

const ctxLiveSessions = computed<string[]>(() => {
  if (ctx.value?.kind !== 'project') return []
  const project = projects.items.find((p) => p.id === ctx.value?.id)
  return (project?.sessions ?? []).filter((s) => !s.endedAt).map((s) => s.id)
})

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
        ? 'Stop the session before archiving this project.'
        : e.message
      : String(e)
  } finally {
    busy.value = false
  }
}

const archivedFolded = ref(true)

function restore(projectId: string): void {
  void projects.unarchive(projectId)
}

</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="brand">
      <div class="brand-top">
        <div class="logo">
          <span class="icon-accent"><Icon name="grid" :size="collapsed ? 18 : 14" /></span><span v-if="!collapsed"> switchboard</span>
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
          <Icon :name="theme === 'light' ? 'moon' : 'sun'" />
        </button>
        <button
          class="icon-btn mono"
          data-testid="collapse-toggle"
          :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          @click="collapsed = !collapsed"
        >
          <Icon :name="collapsed ? 'chevron-right' : 'chevron-left'" />
        </button>
      </div>
    </div>

    <div v-if="!collapsed" class="filter-wrap">
      <div class="filter" :class="{ on: filterQuery.length > 0 }">
        <span class="filter-icon mono"><Icon name="search" :size="13" /></span>
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
          <Icon name="close" :size="12" />
        </button>
      </div>
    </div>

    <div class="project-list">

      <div class="section-row">
        <template v-if="!collapsed">
          <span class="section-label">PROJECTS</span>
          <span class="section-count mono" data-testid="project-count">{{ filtered.length }}</span>
        </template>
        <span class="spacer"></span>
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
        <button class="add mono" data-testid="add-project" title="New session" @click="emit('add-project')"><Icon name="plus" :size="13" /></button>
      </div>


      <template v-for="section in sections" :key="section.group?.id ?? UNGROUPED">
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
          <span class="group-caret mono"><Icon :name="section.folded ? 'chevron-right' : 'chevron-down'" :size="8" /></span>
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
          <span v-else class="group-name">{{ section.name }}</span>
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
            <Icon name="close" :size="12" />
          </button>
        </div>

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
        @keydown.enter.self.prevent="projects.select(item.id)"
        @keydown.space.self.prevent="projects.select(item.id)"
        @contextmenu.prevent="openCtx(item, $event)"
        @dragstart="onDragStart(item, $event)"
        @dragover="onRowDragOver(item, $event)"
        @dragleave="rowDrop = rowDrop?.id === item.id ? null : rowDrop"
        @drop="onRowDrop(item, $event)"
        @dragend="onDragEnd"
      >
        <div class="active-bg"></div>
        <span
          class="brace"
          :data-testid="`project-accent-${item.name}`"
          aria-hidden="true"
        ></span>
        <div class="content">
          <div class="row">
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
            <template v-if="collapsed">
              <span class="initials mono">{{ initials(item.name) }}</span>
              <span
                v-if="(pendingByProject[item.id] ?? 0) > 0"
                class="badge-count collapsed-badge"
                :data-testid="`project-badge-${item.name}`"
              >
                {{ pendingByProject[item.id] ?? 0 }}
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
              <span v-else class="name">{{ item.name }}</span>
              <span
                v-if="(pendingByProject[item.id] ?? 0) > 0"
                class="badge-count"
                :data-testid="`project-badge-${item.name}`"
              >
                {{ pendingByProject[item.id] ?? 0 }}
              </span>
              <span
                v-if="item.session && !item.session.endedAt && showTimer"
                class="timer mono"
                :data-testid="`timer-${item.name}`"
              >
                {{ timerOf(item.session.startedAt) }}
              </span>
              <button
                class="row-add mono"
                :data-testid="`new-session-${item.name}`"
                title="Start another session in this project"
                @click.stop="startAnotherSession(item.id)"
              >
                <Icon name="plus" :size="12" />
              </button>
              <button
                class="remove mono"
                :data-testid="`remove-project-${item.name}`"
                title="Archive this project"
                @click.stop="askRemove(item.id)"
              >
                <Icon name="close" :size="12" />
              </button>
            </template>
          </div>
          <div v-if="!collapsed && isExpanded(item)" class="meta">
            <span class="branch code"><Icon name="branch" :size="11" /> {{ item.session?.branch ?? '—' }}</span>
          </div>
          <div v-if="!collapsed && collisions.has(item.name)" class="path code">{{ item.path }}</div>
          <div
            v-if="!collapsed && item.sessions.length > 1"
            class="subs"
            :data-testid="`sidebar-subsessions-${item.name}`"
          >
            <div
              v-for="(s, i) in item.sessions"
              :key="s.id"
              class="sub-row"
              :class="[`st-${sessionStatus(s)}`, { sel: isFocusedSub(item, s.id) }]"
            >
            <button
              type="button"
              class="sub-line"
              :class="{ sel: isFocusedSub(item, s.id) }"
              :data-testid="`sidebar-subsession-${s.id}`"
              :title="`${markTitle(sessionStatus(s))} — ${s.name ?? s.branch ?? 'no branch'} · session ${s.id}`"
              @click.stop="focusSub(item.id, s.id)"
            >
              <span class="mark sub-mark" :class="sessionStatus(s)">
                <span class="glyph" aria-hidden="true">{{ glyphFor(sessionStatus(s)) }}</span>
              </span>
              <span class="sub-ord mono">{{ i + 1 }}</span>
              <span class="sub-name code">{{ s.name ?? s.branch ?? s.id.slice(0, 8) }}</span>
              <span v-if="!s.endedAt && s.currentModel" class="sub-model mono">{{
                modelLabel(s.currentModel)
              }}</span>
              <span v-if="!s.endedAt && showTimer" class="timer mono">{{
                timerOf(s.startedAt)
              }}</span>
            </button>
            <button
              v-if="!s.endedAt"
              type="button"
              class="sub-x"
              :data-testid="`session-end-${s.id}`"
              :title="`End session ${i + 1}`"
              :aria-label="`End session ${i + 1}`"
              @click.stop="endOneSession(s.id)"
            >
              <Icon name="close" :size="10" />
            </button>
            </div>
          </div>
          <div
            v-if="!collapsed && (agentsByProject[item.id]?.length ?? 0) > 0"
            class="agents"
            :data-testid="`sidebar-agents-${item.name}`"
          >
            <div
              v-for="agent in agentsByProject[item.id] ?? []"
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
                {{ agent.task || agent.name }}
                <Icon
                  v-if="activeSession.selectedAgentId === agent.id"
                  name="arrow-left"
                  :size="11"
                  data-testid="sidebar-agent-selected"
                />
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

      <template v-if="!collapsed && projects.archived.length > 0">
        <div
          class="group-head archived-head"
          :class="{ folded: archivedFolded }"
          data-testid="group-head-archived"
          :title="`Archived · ${projects.archived.length} ${projects.archived.length === 1 ? 'project' : 'projects'}`"
          @click="archivedFolded = !archivedFolded"
        >
          <span class="group-caret mono"><Icon :name="archivedFolded ? 'chevron-right' : 'chevron-down'" :size="8" /></span>
          <span class="group-name">Archived</span>
          <span class="group-count mono" data-testid="group-count-archived">{{ projects.archived.length }}</span>
        </div>
        <template v-if="!archivedFolded">
          <div
            v-for="item in projects.archived"
            :key="item.id"
            class="project archived"
            :data-testid="`archived-project-${item.name}`"
            :title="item.path"
          >
            <div class="content">
              <div class="row">
                <span class="name">{{ item.name }}</span>
                <button
                  class="restore mono"
                  :data-testid="`restore-project-${item.name}`"
                  title="Restore this project"
                  @click.stop="restore(item.id)"
                >
                  <Icon name="refresh" :size="12" />
                </button>
              </div>
            </div>
          </div>
        </template>
      </template>
    </div>

    <template v-if="dbServers.length > 0 && dbProject">
      <div v-if="!collapsed" class="section-row mcp-section">
        <span class="section-label">MCP</span>
      </div>
      <div
        v-for="s in dbServers"
        :key="s"
        class="mcp-item ui-card"
        :class="{ open: activeSession.mcpOpen }"
        :title="`${s} — ${mcpStatusOf(s)} · part of the combined MCP chat`"
        :data-testid="`mcp-server-${s}`"
        @click="activeSession.openMcp(true)"
      >
        <span class="mcp-ico"><Icon name="database" /></span>
        <template v-if="!collapsed">
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
      <Icon :name="theme === 'light' ? 'moon' : 'sun'" />
    </button>
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
        <span class="gear mono" aria-hidden="true"><Icon name="settings" /></span>
        <span class="settings-label">Settings</span>
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
      <span class="gear mono" aria-hidden="true"><Icon name="settings" /></span>
    </div>
  </aside>

  <div v-if="ctx" class="ctx-catcher" data-testid="project-ctx-catcher" @click="closeCtx" @contextmenu.prevent="closeCtx">
    <div
      class="ctx-menu"
      data-testid="project-ctx-menu"
      :style="{ left: `${ctx.x}px`, top: `${ctx.y}px` }"
      @click.stop
    >
      <div class="ctx-name mono">{{ ctx.name }}</div>
      <button class="ctx-item" data-testid="ctx-rename" @click="startRename">
        <span class="icon-accent"><Icon name="pencil" /></span>Rename
      </button>
      <button class="ctx-item" data-testid="ctx-move-up" @click="ctxMove(-1)">
        <span><Icon name="arrow-up" /></span>Move up
      </button>
      <button class="ctx-item" data-testid="ctx-move-down" @click="ctxMove(1)">
        <span><Icon name="arrow-down" /></span>Move down
      </button>
      <template v-if="ctx.kind === 'project'">
        <button class="ctx-item" data-testid="ctx-new-session" @click="ctxNewSession">
          <span class="icon-accent"><Icon name="plus" /></span>New session here
        </button>
        <button
          v-if="ctxLiveSessions.length > 1"
          class="ctx-item"
          data-testid="ctx-end-all"
          @click="ctxEndAll"
        >
          <span class="icon-danger"><Icon name="stop" /></span>End all {{ ctxLiveSessions.length }} sessions
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-testid="ctx-repoint" @click="startRepoint">
          <span class="icon-accent"><Icon name="swap" /></span>Change folder…
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-testid="ctx-new-group" @click="ctxNewGroup">
          <span class="icon-accent"><Icon name="grid" /></span>New group with this
        </button>
        <button
          v-for="g in groups"
          :key="g.id"
          class="ctx-item"
          :data-testid="`ctx-move-to-${g.name}`"
          @click="ctxAssign(g.id)"
        >
          <span><Icon name="arrow-right" /></span>Move to {{ g.name }}
        </button>
        <button
          v-if="groupOf[ctx.id]"
          class="ctx-item"
          data-testid="ctx-move-to-ungrouped"
          @click="ctxAssign(null)"
        >
          <span><Icon name="arrow-right" /></span>Move out of group
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-testid="ctx-remove" @click="ctxDelete">
          <span><Icon name="folder" /></span>Archive
        </button>
      </template>
      <button
        v-else
        class="ctx-item danger"
        data-testid="ctx-remove-group"
        @click="ctxRemoveGroup"
      >
        <span><Icon name="trash" /></span>Remove group (keeps projects)
      </button>
    </div>
  </div>

  <div v-if="repointTarget" class="overlay" data-testid="repoint-overlay" @click.self="cancelRepoint">
    <div
      class="dialog remove-dialog"
      data-testid="repoint-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repoint-dialog-title"
    >
      <div class="rd-icon" aria-hidden="true"><Icon name="swap" :size="18" /></div>
      <div id="repoint-dialog-title" class="rd-title">
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
        <p v-if="repointError" class="rd-error" data-testid="repoint-error">
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

  <div v-if="confirmRemove" class="overlay" data-testid="remove-overlay" @click.self="cancelRemove">
    <div
      class="dialog remove-dialog"
      data-testid="remove-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-dialog-title"
    >
      <div class="rd-icon" aria-hidden="true"><Icon name="folder" :size="18" /></div>
      <div id="remove-dialog-title" class="rd-title">Archive {{ confirmRemove.name }}?</div>
      <div class="rd-body">
        <div class="rd-path faint mono">{{ confirmRemove.path }}</div>
        <p class="rd-note dim">
          It moves to the Archived section at the foot of the list, and can be restored from
          there. Sessions, settings, files and git history are untouched.
        </p>
        <p v-if="removeError" class="rd-error" data-testid="remove-error">{{ removeError }}</p>
      </div>
      <div class="rd-actions">
        <button
          class="btn-solid"
          data-testid="remove-confirm"
          :disabled="busy"
          @click="confirmRemoveNow"
        >
          Archive
        </button>
        <button class="btn-outline" data-testid="remove-cancel" @click="cancelRemove">Keep it</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  --add-h: 21px;
  --section-row-pad: 5px;
  --section-row-h: calc(var(--add-h) + 2 * var(--section-row-pad) + 1px);
  width: 280px;
  min-width: 280px;
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
  padding: 22px 16px 20px;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  min-height: var(--add-h);
  color: var(--text-faint);
  font-size: var(--fs-meta);
  padding: 1px 6px;
  line-height: 1;
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rp);
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
  padding: 0 4px;
  line-height: 12px;
}

.project.drop-before {
  box-shadow: inset 0 2px 0 var(--green);
}

.project.drop-after {
  box-shadow: inset 0 -2px 0 var(--green);
}

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
  font-weight: var(--w-em);
  color: var(--text-bright);
  letter-spacing: 0.02em;
}

.icon-accent {
  color: var(--green);
}

.icon-danger {
  color: var(--red);
}

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

.section-row {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--section-row-pad) 14px var(--section-row-pad) 18px;
  background: var(--bg-sticky);
}

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
}


.group-head {
  position: sticky;
  top: var(--section-row-h);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
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
  color: var(--text-faint);
}

.group-swatch {
  width: 6px;
  min-width: 6px;
  height: 6px;
  border-radius: var(--rc);
}

.group-name {
  flex: 1;
  min-width: 0;
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

.group-empty {
  margin: 0 10px 3px;
  padding: 8px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  font-size: var(--fs-meta);
  color: var(--text-faint);
  text-align: center;
}

.project {
  position: relative;
  margin: 3px 8px;
  padding: 10px;
  border-radius: var(--rc);
  background: transparent;
  cursor: pointer;
  transition: background 0.12s var(--ease);
}

.project:hover {
  background: var(--bg-hover);
}

.project:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--green);
}



.brace {
  position: absolute;
  right: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 3px;
  background: var(--idle);
  pointer-events: none;
  transition: background-color 0.12s var(--ease);
}

.project.live .brace {
  background: var(--running);
}


.active-bg {
  display: none;
}

.project.active .active-bg {
  display: block;
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--green) 9%, var(--bg-panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--green) 20%, transparent);
  border-radius: var(--rc);
}

.content {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mark {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--text-meta);
  padding: 2px;
}

.mark .glyph {
  width: 14px;
  height: 12px;
  font-family: var(--mono);
  font-size: var(--fs-glyph);
  font-weight: var(--w-em);
  line-height: 12px;
  text-align: center;
}

.mark.needs_you {
  color: var(--amber);
}

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

.name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-name);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project.active .name {
  color: var(--text-bright);
}

.project.active .timer,
.project.active .path,
.project.active .branch {
  color: var(--text-on-wash);
}

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

.project.archived {
  cursor: default;
}

.project.archived .name {
  color: var(--text-faint);
  font-weight: normal;
}

.archived-head {
  position: static;
}

.restore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: var(--fs-ui);
  line-height: 1;
  color: var(--text-faint);
  opacity: 0.7;
  padding: 0;
}

.restore:hover {
  color: var(--green);
  opacity: 1;
}

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

.remove-dialog {
  width: 400px;
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
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
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
  border-radius: var(--rc);
}

.rd-title {
  font-size: var(--fs-head);
  font-weight: var(--w-em);
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

.subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 5px;
  padding-left: 15px;
}

.sub-row {
  display: flex;
  align-items: center;
}

.sub-row.st-working {
  box-shadow: inset -2px 0 0 var(--running);
}

.sub-row.st-needs_you {
  box-shadow: inset -2px 0 0 var(--amber);
}

.sub-row.st-error {
  box-shadow: inset -2px 0 0 var(--red);
}

.sub-row .sub-line {
  flex: 1;
  min-width: 0;
}

.sub-x {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  color: var(--text-ghost);
  background: none;
  border: none;
  border-radius: var(--rp);
  opacity: 0;
  cursor: pointer;
}

.sub-row:hover .sub-x,
.sub-x:focus-visible {
  opacity: 1;
}

.sub-x:hover {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 14%, transparent);
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

.sub-model {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

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

.mcp-item {
  position: relative;
  margin: 4px 8px 0;
  display: flex;
  align-items: center;
  gap: 9px;
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
  border-radius: 50% !important;
  flex-shrink: 0;
}

.mcp-accent {
  position: absolute;
  right: 3px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  background: var(--teal);
}

.ctx-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-panel);
  overflow: hidden;
  box-shadow: var(--shadow-menu);
  animation: sbIn 0.12s var(--ease);
}

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

.foot {
  flex-shrink: 0;
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding: 6px 14px 7px 18px;
}
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

.settings-row.rail {
  margin: 10px 0 12px;
  justify-content: center;
}

.gear {
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
