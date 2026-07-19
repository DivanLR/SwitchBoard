<script setup lang="ts">
// Sidebar — 1:1 with the design reference: logo, PROJECTS list with animated
// status dots, mono names, per-project pending badges, branch + timer line,
// and the running / needs-you / cost-today stats card (FR-003/004/005).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { MODEL_CHOICES } from '@shared/domain'
import { useProjectsStore } from '@renderer/stores/projects'
import { useInboxStore } from '@renderer/stores/inbox'
import { useSettingsStore } from '@renderer/stores/settings'

const projects = useProjectsStore()
const inbox = useInboxStore()
const settings = useSettingsStore()
const emit = defineEmits<{
  (e: 'add-project'): void
  (e: 'open-rules'): void
  (e: 'open-settings'): void
}>()

// Short label of the current work model for the settings row (design).
const modelSummary = computed(() => {
  const id = settings.settings?.workModel ?? 'default'
  if (id === 'default') return 'default model'
  const choice = MODEL_CHOICES.find((m) => m.id === id)
  return choice ? choice.label.replace(/\s*\(.*\)$/, '') : id
})

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

// --- Context menu (right-click) + inline rename ---
const ctx = ref<{ id: string; name: string; x: number; y: number } | null>(null)
const renamingId = ref<string | null>(null)
const renameVal = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

watch(renamingId, (id) => {
  if (id) void nextTick(() => renameInput.value?.focus())
})

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
  <aside class="sidebar">
    <div class="brand">
      <div class="logo mono"><span style="color: var(--green)">▣</span> switchboard</div>
      <div class="tagline mono">claude code sessions · one inbox</div>
    </div>

    <div class="section-row">
      <span class="section-label mono">PROJECTS</span>
      <button class="add mono" data-testid="add-project" title="Add a project" @click="emit('add-project')">
        +
      </button>
    </div>

    <div class="project-list">
      <div
        v-for="item in projects.items"
        :key="item.id"
        class="project"
        :class="{ active: item.id === projects.selectedProjectId }"
        :data-testid="`sidebar-project-${item.name}`"
        @click="projects.select(item.id)"
        @contextmenu.prevent="openCtx(item, $event)"
      >
        <div class="active-bg"></div>
        <div class="content">
          <div class="row">
            <span
              v-if="statusOf(item) !== 'none'"
              class="dot"
              :class="statusOf(item)"
              :data-testid="`status-badge-${item.name}`"
              :data-status="statusOf(item)"
              :title="statusOf(item) === 'needs_you' ? 'needs you' : statusOf(item)"
            ></span>
            <input
              v-if="renamingId === item.id"
              ref="renameInput"
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
          </div>
          <div class="meta">
            <span class="branch mono">⎇ {{ item.session?.branch ?? '—' }}</span>
            <span
              v-if="item.session && !item.session.endedAt"
              class="timer mono"
              :data-testid="`timer-${item.name}`"
            >
              {{ timerOf(item.session.startedAt) }}
            </span>
          </div>
          <div v-if="collisions.has(item.name)" class="path mono">{{ item.path }}</div>
        </div>
      </div>
      <div v-if="projects.loaded && projects.items.length === 0" class="empty mono">
        no projects yet — press + to add one
      </div>
    </div>

    <div class="settings-row" data-testid="open-settings" @click="emit('open-settings')">
      <span class="gear mono">⚙</span>
      <span class="settings-label mono">settings</span>
      <span class="model-summary mono" data-testid="model-summary">{{ modelSummary }}</span>
    </div>

    <div class="stats">
      <div class="stat mono" data-testid="counter-running">
        <span>running</span><span class="val" data-testid="counter-running-value">{{ projects.counters.running }}</span>
      </div>
      <div class="stat mono" data-testid="counter-needsyou">
        <span>needs you</span
        ><span class="val amber" data-testid="counter-needsyou-value">{{ projects.counters.needsYou }}</span>
      </div>
      <div class="stat mono" data-testid="counter-cost">
        <span>cost today</span><span class="val" data-testid="counter-cost-value">{{ costLabel }}</span>
      </div>
      <div class="stat mono" data-testid="counter-tokens">
        <span>tokens today</span
        ><span class="val" data-testid="counter-tokens-value">{{ tokensLabel }}</span>
      </div>
    </div>

    <div v-if="usagePct !== null" class="usage-card" data-testid="usage-meter">
      <div class="usage-head mono">
        <span>session usage</span>
        <span :style="{ color: usageColor }">{{ usagePct }}% of {{ usageLimitLabel }}</span>
      </div>
      <div class="usage-bar">
        <div class="usage-fill" :style="{ width: `${usagePct}%`, background: usageColor }"></div>
      </div>
      <div class="usage-foot mono">
        <span>{{ tokensLabel }} tok</span>
        <span v-if="usageReset">resets {{ usageReset }}</span>
      </div>
    </div>

    <div class="footer mono">
      <button class="foot-link" data-testid="open-rules" @click="emit('open-rules')">rules</button>
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
        <span style="color: var(--green)">✎</span>rename
      </button>
      <button class="ctx-item mono danger" data-testid="ctx-remove" @click="ctxDelete">
        <span>🗑</span>remove from list
      </button>
    </div>
  </div>

  <!-- Remove-project confirmation popup -->
  <div v-if="confirmRemove" class="overlay" @click.self="cancelRemove">
    <div class="dialog remove-dialog" data-testid="remove-dialog">
      <div class="rd-title mono">Remove project?</div>
      <div class="rd-body">
        <div class="rd-name mono">{{ confirmRemove.name }}</div>
        <div class="rd-path faint mono">{{ confirmRemove.path }}</div>
        <p class="rd-note dim">
          This removes the project from Switchboard. Its folder and files on disk are not touched.
        </p>
        <p v-if="removeError" class="rd-error mono" data-testid="remove-error">{{ removeError }}</p>
      </div>
      <div class="rd-actions">
        <button class="btn-outline" data-testid="remove-cancel" @click="cancelRemove">cancel</button>
        <button
          class="btn-solid danger-solid"
          data-testid="remove-confirm"
          :disabled="busy"
          @click="confirmRemoveNow"
        >
          remove
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  width: 252px;
  min-width: 252px;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.brand {
  padding: 16px 16px 12px;
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
  border-radius: 6px;
  cursor: pointer;
}

.project:hover {
  background: var(--bg-hover);
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
  border-radius: 6px;
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
  font-size: 12px;
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  padding: 0 2px;
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

.rd-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.rd-body {
  margin: 12px 0 16px;
}

.rd-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-name);
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
  border-radius: 6px;
  outline: none;
  color: var(--text-strong);
  font-size: 12px;
  padding: 2px 7px;
}

.usage-card {
  margin: 8px 10px 0;
  padding: 9px 12px;
  border: 1px solid var(--border-card-alt);
  border-radius: 12px;
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
  background: var(--bg-code);
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
  background: rgba(224, 108, 85, 0.08);
  color: var(--red);
}

.settings-row {
  margin: 10px 10px 0;
  padding: 9px 12px;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--border-card-alt);
  border-radius: 12px;
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
  border-radius: 12px;
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

.footer {
  padding: 0 12px 10px;
  font-size: 10.5px;
  color: var(--text-faint);
  display: flex;
  gap: 6px;
}

.foot-link {
  color: var(--text-faint);
  font-size: 10.5px;
  font-family: var(--mono);
}

.foot-link:hover {
  color: var(--text-body);
}

.sep {
  color: var(--text-ghost);
}
</style>
