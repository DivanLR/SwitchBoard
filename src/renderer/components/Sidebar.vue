<script setup lang="ts">
// Sidebar — 1:1 with the design reference: logo, PROJECTS list with animated
// status dots, mono names, per-project pending badges, branch + timer line,
// and the running / needs-you / cost-today stats card (FR-003/004/005).
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'
import { useInboxStore } from '@renderer/stores/inbox'

const projects = useProjectsStore()
const inbox = useInboxStore()
const emit = defineEmits<{
  (e: 'add-project'): void
  (e: 'open-rules'): void
  (e: 'open-settings'): void
}>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
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
            <span class="name mono">{{ item.name }}</span>
            <span
              v-if="pendingFor(item.id) > 0"
              class="badge-count"
              :data-testid="`project-badge-${item.name}`"
            >
              {{ pendingFor(item.id) }}
            </span>
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
    </div>

    <div class="footer mono">
      <button class="foot-link" data-testid="open-rules" @click="emit('open-rules')">rules</button>
      <span class="sep">·</span>
      <button class="foot-link" data-testid="open-settings" @click="emit('open-settings')">
        settings
      </button>
    </div>
  </aside>
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

.stats {
  margin: 10px;
  padding: 10px 12px;
  background: var(--bg-card-alt);
  border: 1px solid var(--border-card-alt);
  border-radius: 8px;
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
