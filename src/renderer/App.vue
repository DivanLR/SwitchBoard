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
    <div class="panes">
      <Sidebar
        @add-project="showRegistration = true"
        @open-settings="openSettings()"
      />

      <main class="main">
        <McpView
          v-if="dbProject && active.mcpTarget"
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

      <InboxView />
    </div>

    <ProjectRegistration v-if="showRegistration" @close="showRegistration = false" />
    <SettingsPanel v-if="showSettings" :initial-tab="settingsTab" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
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
  background: var(--green);
  color: var(--green-ink);
  font-weight: 600;
  font-size: 11px;
  font-family: var(--sans);
  padding: 4px 12px;
  border-radius: 10px;
  cursor: pointer;
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

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
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
