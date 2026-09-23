<script setup lang="ts">
import { computed } from 'vue'
import type { KeepCurrentResult, KeepCurrentStatus, Settings } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'

const props = defineProps<{ settings: Settings }>()

const store = useSettingsStore()
const updates = useUpdatesStore()

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

const KIND_LABELS: Record<KeepCurrentResult['kind'], string> = {
  marketplace: 'Marketplace',
  plugin: 'Plugin',
  skill: 'Skill',
  speckit: 'Spec Kit',
}

const STATUS_LABELS: Record<KeepCurrentStatus, string> = {
  needs_confirmation: 'Needs your confirmation',
  failed: 'Failed',
  updated: 'Updated',
  current: 'Current',
}

const STATUS_ORDER = Object.keys(STATUS_LABELS) as KeepCurrentStatus[]

const keepResults = computed(() =>
  [...(props.settings.keepCurrentLast?.results ?? [])].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  ),
)

const lastCheckLine = computed(() => {
  const last = props.settings.keepCurrentLast
  if (!last) return 'Not checked yet.'
  const counts = STATUS_ORDER.map((status) => [status, last.results.filter((r) => r.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${STATUS_LABELS[status].toLowerCase()}`)
  return `Last checked ${new Date(last.checkedAt).toLocaleString()}${counts.length ? `: ${counts.join(', ')}.` : '.'}`
})

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

  <div class="ui-kicker group-label" style="margin-top: 8px">PLUGINS AND SKILLS</div>
  <div class="group-desc">
    When Switchboard starts, and once a day while it runs, it refreshes your plugin marketplaces,
    updates every installed plugin, re-imports an imported skill whose source changed, and updates
    the Spec Kit extensions in your projects. Updates apply to sessions started afterwards. A
    session that is already running keeps the versions it started with.
  </div>
  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Keep plugins and skills up to date</div>
      <div class="sr-desc">
        A plugin whose update needs a marketplace command confirmed is never confirmed for you. It
        is listed below as needing your confirmation.
      </div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.keepCurrent }"
      data-testid="setting-keep-current"
      role="switch"
      :aria-checked="settings.keepCurrent"
      @click="save({ keepCurrent: !settings.keepCurrent })"
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="keep-line">
    <span class="keep-last" data-testid="keep-current-last">{{ lastCheckLine }}</span>
    <button
      class="btn-quiet"
      data-testid="keep-current-check"
      :disabled="store.checkingPlugins"
      @click="store.checkPluginsNow()"
    >
      {{ store.checkingPlugins ? 'Checking…' : 'Check now' }}
    </button>
  </div>
  <div v-if="store.pluginCheckError" class="ui-err" data-testid="keep-current-error">
    {{ store.pluginCheckError }}
  </div>
  <div v-if="keepResults.length > 0" class="keep-results" data-testid="keep-current-results">
    <div
      v-for="(result, index) in keepResults"
      :key="index"
      class="ui-row keep-row"
      :data-testid="`keep-result-${result.name}`"
      :title="result.detail"
    >
      <span class="keep-kind">{{ KIND_LABELS[result.kind] }}</span>
      <span class="keep-name mono">{{ result.name }}</span>
      <span class="keep-status" :class="result.status" data-testid="keep-result-status">
        {{ STATUS_LABELS[result.status] }}
      </span>
      <div v-if="result.status !== 'current'" class="ui-desc keep-detail">{{ result.detail }}</div>
    </div>
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

.keep-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.keep-last {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.keep-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.keep-row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  align-items: baseline;
  gap: 4px 10px;
}

.keep-kind {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.keep-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.keep-status {
  font-size: var(--fs-meta);
  color: var(--text-mid);
}

.keep-status.failed {
  color: var(--red);
}

.keep-status.needs_confirmation {
  color: var(--amber);
}

.keep-detail {
  grid-column: 2 / -1;
}
</style>
