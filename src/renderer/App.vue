<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useTerminalStore } from '@renderer/stores/terminal'
import { useDiagramsStore } from '@renderer/stores/diagrams'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
import Sidebar from '@renderer/components/Sidebar.vue'
import StatusBar from '@renderer/components/StatusBar.vue'
import SessionView from '@renderer/views/SessionView.vue'
import McpView from '@renderer/views/McpView.vue'
import InboxView from '@renderer/views/InboxView.vue'
import ProjectRegistration from '@renderer/components/ProjectRegistration.vue'
import SettingsPanel, { type SettingsTab } from '@renderer/components/SettingsPanel.vue'
import FlowPopup from '@renderer/components/FlowPopup.vue'
import GlobalSpinner from '@renderer/components/GlobalSpinner.vue'
import ToastHost from '@renderer/components/ToastHost.vue'
import SessionWaitOverlay from '@renderer/components/SessionWaitOverlay.vue'
import Icon from '@renderer/components/Icon.vue'

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const terminal = useTerminalStore()
const diagrams = useDiagramsStore()
const settingsStore = useSettingsStore()
const updates = useUpdatesStore()

const showRegistration = ref(false)
const showSettings = ref(false)
const showFlow = ref(false)
const settingsTab = ref<SettingsTab>('models')

function openSettings(tab: SettingsTab = 'models'): void {
  settingsTab.value = tab
  showSettings.value = true
}
const bridgeMissing = ref(false)
const updateDismissed = ref(false)

const INBOX_MIN = 280
const INBOX_MAX = 680
function clampInbox(w: number): number {
  return Math.min(INBOX_MAX, Math.max(INBOX_MIN, w))
}
const inboxWidth = ref(clampInbox(Number(localStorage.getItem('sb-inbox-w')) || 332))

const inboxCollapsed = ref(localStorage.getItem('sb-inbox-collapsed') === '1')
function setInboxCollapsed(v: boolean): void {
  inboxCollapsed.value = v
  localStorage.setItem('sb-inbox-collapsed', v ? '1' : '0')
}

let stopInboxResize: (() => void) | null = null

function startInboxResize(event: MouseEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startW = inboxWidth.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  const onMove = (e: MouseEvent): void => {
    inboxWidth.value = clampInbox(startW - (e.clientX - startX))
  }
  const onUp = (): void => {
    stopInboxResize = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    localStorage.setItem('sb-inbox-w', String(inboxWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  stopInboxResize = onUp
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
    window.switchboard.on('push.terminalData', (push) => terminal.applyData(push)),
    window.switchboard.on('push.terminalExit', (push) => terminal.applyExit(push)),
    window.switchboard.on('push.diagramsChanged', (push) =>
      diagrams.applyChanged(push.projectId, push.entries),
    ),
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
  stopInboxResize?.()
})

const selectedProject = computed(() => projects.selected)
watch(selectedProject, (next, prev) => {
  if (showFlow.value && prev && next?.id !== prev.id) showFlow.value = false
})
const dbProject = computed(() => projects.dbProject)
</script>

<template>
  <div v-if="bridgeMissing" class="bridge-missing">
    <div class="logo">
      <span style="color: var(--green)"><Icon name="grid" :size="18" /></span> switchboard
    </div>
    <p class="dim">
      The IPC bridge is not available. Start the application with <code>npm run dev</code>.
    </p>
  </div>

  <div v-else class="shell">
    <div
      v-if="updates.active && !updateDismissed"
      class="update-banner"
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
        <template v-else-if="updates.failed">
          The update could not be installed{{
            updates.status.message ? ` — ${updates.status.message}` : ''
          }}. You are still on the current version; try again later or download it
          from the releases page.
        </template>
        <template v-else>
          A new version{{ updates.status.version ? ` (${updates.status.version})` : '' }} is available.
        </template>
      </span>
      <button
        v-if="updates.available"
        class="btn-solid"
        data-testid="update-banner-install"
        @click="updates.install()"
      >
        download &amp; install
      </button>
      <button
        v-if="!updates.ready"
        class="ub-dismiss"
        data-testid="update-banner-dismiss"
        aria-label="Dismiss"
        @click="updateDismissed = true"
      >
        <Icon name="close" />
      </button>
    </div>
    <div class="panes" :style="{ '--inbox-w': `${inboxWidth}px` }">
      <Sidebar
        v-if="!active.fullScreenSection"
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
          @open-flow="showFlow = true"
        />
        <div v-else class="no-project ui-empty">
          <div class="ui-empty-icon"><Icon name="folder" :size="24" /></div>
          <div class="ui-empty-title">No project selected</div>
          <div class="ui-empty-sub">Choose a project from the sidebar, or add a new one.</div>
          <button class="btn-solid" data-testid="add-project-empty" @click="showRegistration = true">
            add a project
          </button>
        </div>
      </main>

      <template v-if="!inboxCollapsed && !active.fullScreenSection">
        <div
          class="inbox-resize"
          data-testid="inbox-resize"
          title="Drag to resize the inbox"
          @mousedown="startInboxResize"
        ></div>
        <InboxView @collapse="setInboxCollapsed(true)" />
      </template>

      <div
        v-if="inboxCollapsed && !active.fullScreenSection"
        class="inbox-rail"
        data-testid="inbox-rail"
      >
        <button
          class="inbox-peek"
          data-testid="inbox-peek"
          :title="inbox.pendingCount > 0 ? `${inbox.pendingCount} waiting — open inbox` : 'Open inbox'"
          @click="setInboxCollapsed(false)"
        >
          <span v-if="inbox.pendingCount > 0" data-testid="inbox-peek-count">{{ inbox.pendingCount }}</span>
          <span v-else class="inbox-peek-icon"><Icon name="chevron-left" :size="12" /></span>
        </button>
        <span class="inbox-rail-label">INBOX</span>
      </div>
    </div>

    <StatusBar />

    <ProjectRegistration v-if="showRegistration" @close="showRegistration = false" />
    <SettingsPanel v-if="showSettings" :initial-tab="settingsTab" @close="showSettings = false" />
    <FlowPopup
      v-if="showFlow && selectedProject"
      :project-id="selectedProject.id"
      :project-name="selectedProject.name"
      @close="showFlow = false"
    />

    <SessionWaitOverlay
      v-if="projects.starting"
      testid="session-start-overlay"
      title="Starting session…"
      sub="This can take a few moments."
    />
  </div>

  <ToastHost />

  <GlobalSpinner />
</template>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: transparent;
  overflow: auto;
}

.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--green) 8%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.ub-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--rp);
  background: var(--green);
  animation: sbFade 2.2s ease infinite;
}

.ub-text {
  flex: 1;
}

.ub-dismiss {
  color: var(--text-tab);
  font-size: var(--fs-ui);
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

.inbox-rail {
  flex-shrink: 0;
  width: 44px;
  min-width: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  box-shadow: var(--hairline-shine);
}

.inbox-peek {
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--rp);
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-tab);
  font-family: var(--sans);
  font-size: var(--fs-ui);
  cursor: pointer;
}

.inbox-peek:hover {
  color: var(--text-strong);
  border-color: var(--border-seg);
}

.inbox-rail-label {
  writing-mode: vertical-rl;
  font-size: var(--fs-micro);
  letter-spacing: 0.18em;
  color: var(--text-faint);
  user-select: none;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}


.inbox-resize {
  position: relative;
  flex-shrink: 0;
  width: 6px;
  margin-right: -6px;
  z-index: 2;
  cursor: col-resize;
  background: transparent;
}

.inbox-resize::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 22px;
  transform: translate(-50%, -50%);
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  opacity: 0.7;
  transition: opacity 120ms ease;
}

.inbox-resize:hover {
  background: var(--border);
}

.inbox-resize:hover::after {
  opacity: 0;
}

.no-project {
  flex: 1;
}

.bridge-missing {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.logo {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-bright);
  letter-spacing: 0.02em;
}
</style>
