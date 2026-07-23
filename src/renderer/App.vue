<script setup lang="ts">
// Application shell — 1:1 with the Switchboard design reference: sidebar
// (252px) | session stream | inbox panel (332px, always visible). Push
// subscriptions and notification click routing (FR-013a) live here.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
import Sidebar from '@renderer/components/Sidebar.vue'
import SessionView from '@renderer/views/SessionView.vue'
import McpView from '@renderer/views/McpView.vue'
import InboxView from '@renderer/views/InboxView.vue'
import ProjectRegistration from '@renderer/components/ProjectRegistration.vue'
import SettingsPanel from '@renderer/components/SettingsPanel.vue'
import GlobalSpinner from '@renderer/components/GlobalSpinner.vue'

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const settingsStore = useSettingsStore()
const updates = useUpdatesStore()

const showRegistration = ref(false)
const showSettings = ref(false)
const settingsTab = ref<'models' | 'proj' | 'allowed' | 'term' | 'gen'>('models')

function openSettings(tab: 'models' | 'proj' | 'allowed' | 'term' | 'gen' = 'models'): void {
  settingsTab.value = tab
  showSettings.value = true
}
const bridgeMissing = ref(false)
const updateDismissed = ref(false)

// The inbox panel is drag-resizable; its width persists across launches.
const INBOX_MIN = 280
const INBOX_MAX = 680
function clampInbox(w: number): number {
  return Math.min(INBOX_MAX, Math.max(INBOX_MIN, w))
}
const inboxWidth = ref(clampInbox(Number(localStorage.getItem('sb-inbox-w')) || 332))

// The inbox can be collapsed to reclaim width; a glowing badge in the top-right
// reopens it and shows the pending count.
const inboxCollapsed = ref(localStorage.getItem('sb-inbox-collapsed') === '1')
function setInboxCollapsed(v: boolean): void {
  inboxCollapsed.value = v
  localStorage.setItem('sb-inbox-collapsed', v ? '1' : '0')
}

function startInboxResize(event: MouseEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startW = inboxWidth.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  const onMove = (e: MouseEvent): void => {
    // The handle sits on the inbox's left edge, so dragging left widens it.
    inboxWidth.value = clampInbox(startW - (e.clientX - startX))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    localStorage.setItem('sb-inbox-w', String(inboxWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const unsubscribers: (() => void)[] = []

onMounted(async () => {
  if (!window.switchboard) {
    bridgeMissing.value = true
    return
  }

  unsubscribers.push(
    window.switchboard.on('push.event', (event) => active.applyEventPush(event)),
    window.switchboard.on('push.sessionStatus', (push) => projects.applyStatusPush(push)),
    window.switchboard.on('push.counters', (counters) => projects.setCounters(counters)),
    window.switchboard.on('push.inboxChanged', (push) => inbox.applyInboxPush(push)),
    window.switchboard.on('push.queueChanged', (push) => queue.applyQueuePush(push)),
    window.switchboard.on('push.focusRequest', (push) => {
      if (push.target === 'inbox') {
        inbox.focusRequest(push.requestId)
      } else {
        const project = projects.items.find((p) => p.session?.id === push.sessionId)
        if (project) projects.select(project.id)
        if (push.eventId) active.focusEvent(push.eventId)
      }
    }),
    window.switchboard.on('push.updateStatus', (status) => {
      updates.apply(status)
      if (status.state === 'available') updateDismissed.value = false
    }),
  )

  await settingsStore.load()
  active.defaultView = settingsStore.settings?.defaultView ?? 'clean'
  await Promise.all([projects.refresh(), inbox.refresh()])
})

onUnmounted(() => {
  for (const unsubscribe of unsubscribers) unsubscribe()
})

const selectedProject = computed(() => projects.selected)
// The Database MCP view is global (bound to the reserved project). Its session
// outlives view switches; selecting a project just closes the view (see
// projects.select → openMcp(null)) so the chat swaps like any project switch.
const dbProject = computed(() => projects.dbProject)
</script>

<template>
  <div v-if="bridgeMissing" class="bridge-missing">
    <div class="mono" style="font-size: 15px; font-weight: 700">
      <span style="color: var(--green)">▣</span> switchboard
    </div>
    <p class="dim">
      The IPC bridge is not available. Start the application with <code>npm run dev</code>.
    </p>
  </div>

  <div v-else class="shell">
    <div
      v-if="updates.active && !updateDismissed"
      class="update-banner mono"
      data-testid="update-banner"
    >
      <span class="ub-dot"></span>
      <span class="ub-text">
        <template v-if="updates.downloading">
          Downloading update{{ updates.status.version ? ` (${updates.status.version})` : '' }}… {{ updates.percent }}%
        </template>
        <template v-else-if="updates.ready">
          Update downloaded — the installer is opening. The app will close.
        </template>
        <template v-else>
          A new version{{ updates.status.version ? ` (${updates.status.version})` : '' }} is available.
        </template>
      </span>
      <button
        v-if="updates.available"
        class="ub-install"
        data-testid="update-banner-install"
        @click="updates.install()"
      >
        download &amp; install
      </button>
      <button
        v-if="!updates.ready"
        class="ub-dismiss"
        data-testid="update-banner-dismiss"
        @click="updateDismissed = true"
      >
        ✕
      </button>
    </div>
    <div class="panes" :style="{ '--inbox-w': `${inboxWidth}px` }">
      <Sidebar
        @add-project="showRegistration = true"
        @open-settings="openSettings()"
      />

      <main class="main">
        <McpView
          v-if="dbProject && active.mcpOpen"
          :project="dbProject"
        />
        <SessionView
          v-else-if="selectedProject"
          :project="selectedProject"
          @open-proj-settings="openSettings('proj')"
        />
        <div v-else class="no-project">
          <div class="mono faint" style="font-size: 12px">no project selected</div>
          <button class="btn-solid" @click="showRegistration = true">add a project</button>
        </div>
      </main>

      <template v-if="!inboxCollapsed">
        <div
          class="inbox-resize"
          data-testid="inbox-resize"
          title="Drag to resize the inbox"
          @mousedown="startInboxResize"
        ></div>
        <InboxView @collapse="setInboxCollapsed(true)" />
      </template>

      <!-- Collapsed: a thin right rail. The glowing count at its top reopens the
           inbox and makes pending items impossible to miss. -->
      <div v-if="inboxCollapsed" class="inbox-rail" data-testid="inbox-rail">
        <button
          class="inbox-peek"
          :class="{ glow: inbox.pendingCount > 0 }"
          data-testid="inbox-peek"
          :title="inbox.pendingCount > 0 ? `${inbox.pendingCount} waiting — open inbox` : 'Open inbox'"
          @click="setInboxCollapsed(false)"
        >
          <span v-if="inbox.pendingCount > 0" data-testid="inbox-peek-count">{{ inbox.pendingCount }}</span>
          <span v-else class="inbox-peek-icon">‹</span>
        </button>
        <span class="inbox-rail-label mono">INBOX</span>
      </div>
    </div>

    <ProjectRegistration v-if="showRegistration" @close="showRegistration = false" />
    <SettingsPanel v-if="showSettings" :initial-tab="settingsTab" @close="showSettings = false" />
  </div>

  <!-- Global loading spinner — shows while any IPC call is in flight. -->
  <GlobalSpinner />
</template>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  /* Design's outer wrapper is transparent so the body's glow gradient
     shows through the glass sidebar/panels; the main pane stays opaque
     (see .main below) and covers it where the design does too. */
  background: transparent;
  overflow: auto;
}

.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: rgba(52, 211, 153, 0.08);
  border-bottom: 1px solid rgba(52, 211, 153, 0.3);
  font-size: 12px;
  color: var(--text-body);
}

.ub-dot {
  width: 8px;
  height: 8px;
  border-radius: 99px;
  background: var(--green);
  animation: sbFade 2.2s ease infinite;
}

.ub-text {
  flex: 1;
}

.ub-install {
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
  color: var(--green-ink);
  font-weight: 600;
  font-size: 11px;
  font-family: var(--sans);
  padding: 4px 12px;
  border-radius: var(--rc);
  cursor: pointer;
  box-shadow: var(--green-glow);
}

.ub-dismiss {
  color: var(--text-tab);
  font-size: 12px;
  padding: 2px 6px;
}

.ub-dismiss:hover {
  color: var(--text-body);
}

.panes {
  display: flex;
  flex: 1;
  min-width: 1080px;
  min-height: 560px;
  overflow: hidden;
}

/* Collapsed inbox: a thin rail on the right with the reopen control at its top. */
.inbox-rail {
  flex-shrink: 0;
  width: 44px;
  min-width: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  background: var(--gloss), var(--bg-panel);
  border-left: 1px solid var(--border);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.inbox-peek {
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 99px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-tab);
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
}

.inbox-peek:hover {
  color: var(--text-strong);
  border-color: var(--border-seg);
}

/* Pending items: amber pill that pulses so it draws the eye. */
.inbox-peek.glow {
  color: var(--amber-ink);
  background: var(--gloss), var(--amber);
  border-color: var(--amber);
  font-weight: 700;
  animation: inboxPeekGlow 1.8s ease-in-out infinite;
}

/* Vertical "INBOX" label down the rail. */
.inbox-rail-label {
  writing-mode: vertical-rl;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-faint);
  user-select: none;
}

@keyframes inboxPeekGlow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(154, 111, 42, 0.55);
  }
  50% {
    box-shadow: 0 0 10px 3px rgba(154, 111, 42, 0.75);
  }
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* Drag handle on the inbox's left edge (design seam sits on the inbox border). */
.inbox-resize {
  position: relative;
  flex-shrink: 0;
  width: 6px;
  margin-right: -6px;
  z-index: 2;
  cursor: col-resize;
  background: transparent;
}

.inbox-resize:hover {
  background: var(--border);
}

.no-project {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.bridge-missing {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
</style>
