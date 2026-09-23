<script setup lang="ts">
import { computed } from 'vue'
import type { Settings } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'

defineProps<{ settings: Settings }>()

const store = useSettingsStore()
const updates = useUpdatesStore()

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

const updateLine = computed(() => {
  const s = updates.status
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update ${s.version ?? ''} available — click Download to get the installer.`
    case 'downloading':
      return `Downloading update… ${s.percent ?? 0}%`
    case 'ready':
      return `Update ${s.version ?? ''} ready. Restart to apply.`
    case 'none':
      return 'You are on the latest version.'
    case 'error':
      return `Update problem: ${s.message ?? 'unknown error'}`
    default:
      return 'Updates are delivered from GitHub releases.'
  }
})
</script>

<template>
  <div class="ui-kicker group-label">NOTIFICATIONS</div>
  <div class="group-desc">How Switchboard gets your attention.</div>
  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Desktop notifications</div>
      <div class="sr-desc">
        Pop a notification when a session needs an approval, hits an error, or finishes —
        you can approve right from it.
      </div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.notificationsEnabled }"
      data-testid="setting-notifications"
      role="switch"
      :aria-checked="settings.notificationsEnabled"
      @click="save({ notificationsEnabled: !settings.notificationsEnabled })"
    >
      <span class="knob"></span>
    </button>
  </div>

  <div class="ui-kicker group-label" style="margin-top: 8px">APP UPDATES</div>
  <div class="group-desc">
    New versions are published to GitHub releases. Switchboard checks for a newer release
    and, when one exists, opens its download page so you can run the installer.
  </div>
  <div
    class="update-status"
    :class="updates.status.state === 'error' ? 'ui-err' : 'ui-card'"
    data-testid="update-status"
  >{{ updateLine }}</div>
  <div class="update-actions">
    <button
      class="btn-quiet"
      data-testid="update-check"
      :disabled="updates.busy"
      @click="updates.check()"
    >
      Check for updates
    </button>
    <button
      v-if="updates.available"
      class="btn-solid"
      data-testid="update-install"
      @click="updates.install()"
    >
      Download update
    </button>
  </div>

  <div class="ui-card" style="margin-top: 8px">
    Raw output is kept for the current and previous session per project; decision history
    for 30 days. All data stays on this machine.
  </div>
</template>

<style scoped>
.update-status {
  margin-bottom: 12px;
}

.update-actions {
  display: flex;
  gap: 8px;
}
</style>
