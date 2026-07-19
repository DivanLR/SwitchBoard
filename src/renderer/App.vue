<script setup lang="ts">
// Application shell — 1:1 with the Switchboard design reference: sidebar
// (252px) | session stream | inbox panel (332px, always visible). Push
// subscriptions and notification click routing (FR-013a) live here.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import Sidebar from '@renderer/components/Sidebar.vue'
import SessionView from '@renderer/views/SessionView.vue'
import InboxView from '@renderer/views/InboxView.vue'
import ProjectRegistration from '@renderer/components/ProjectRegistration.vue'
import RuleEditors from '@renderer/components/RuleEditors.vue'
import SettingsPanel from '@renderer/components/SettingsPanel.vue'

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()

const showRegistration = ref(false)
const showRules = ref(false)
const showSettings = ref(false)
const bridgeMissing = ref(false)

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
    window.switchboard.on('push.focusRequest', (push) => {
      if (push.target === 'inbox') {
        inbox.focusRequest(push.requestId)
      } else {
        const project = projects.items.find((p) => p.session?.id === push.sessionId)
        if (project) projects.select(project.id)
        if (push.eventId) active.focusEvent(push.eventId)
      }
    }),
  )

  const settings = await window.switchboard.invoke('settings.get', undefined)
  active.defaultView = settings.defaultView
  await Promise.all([projects.refresh(), inbox.refresh()])
})

onUnmounted(() => {
  for (const unsubscribe of unsubscribers) unsubscribe()
})

const selectedProject = computed(() => projects.selected)
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
    <div class="panes">
      <Sidebar
        @add-project="showRegistration = true"
        @open-rules="showRules = true"
        @open-settings="showSettings = true"
      />

      <main class="main">
        <SessionView v-if="selectedProject" :project="selectedProject" />
        <div v-else class="no-project">
          <div class="mono faint" style="font-size: 12px">no project selected</div>
          <button class="btn-solid" @click="showRegistration = true">add a project</button>
        </div>
      </main>

      <InboxView />
    </div>

    <ProjectRegistration v-if="showRegistration" @close="showRegistration = false" />
    <RuleEditors v-if="showRules" @close="showRules = false" />
    <SettingsPanel v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  background: var(--bg);
  overflow: auto;
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
