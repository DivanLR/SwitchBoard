<script setup lang="ts">
import type { Settings } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { MATCHER_KIND_LABEL, useAllowedRules } from '@renderer/composables/useAllowedRules'
import { useSettingsStore } from '@renderer/stores/settings'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ settings: Settings; project: ProjectListItem | null }>()

const store = useSettingsStore()

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

const { allowedRules, newCmd, setRuleMode, addAllowedCommand } = useAllowedRules({
  projectId: () => props.project?.id,
})
</script>

<template>
  <div class="ui-kicker group-label">AUTO-APPROVE BY RISK</div>
  <div class="group-desc">
    Requests at these risk levels are approved automatically and land in history as
    rule-approved. High risk always asks.
  </div>
  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Low risk</div>
      <div class="sr-desc">Read-only inspection — file reads, git status, listings</div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.autoApproveLow }"
      data-testid="setting-auto-low"
      role="switch"
      :aria-checked="settings.autoApproveLow"
      @click="save({ autoApproveLow: !settings.autoApproveLow })"
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Medium risk</div>
      <div class="sr-desc">Routine changes — file edits, package installs, builds</div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.autoApproveMedium }"
      data-testid="setting-auto-medium"
      role="switch"
      :aria-checked="settings.autoApproveMedium"
      @click="save({ autoApproveMedium: !settings.autoApproveMedium })"
    >
      <span class="knob"></span>
    </button>
  </div>

  <div class="ui-kicker group-label" style="margin-top: 8px">ALLOWED COMMANDS</div>
  <div class="group-desc">
    Standing rules for
    <span class="proj-name">{{ project?.name ?? 'this project' }}</span> — created from
    history (right-click a command) or added here. Auto approves without asking; Ask
    restores the inbox prompt.
  </div>
  <div class="cards" data-testid="allowed-rules">
    <div v-for="r in allowedRules" :key="r.id" class="ui-card card-opt static">
      <div class="opt-body">
        <div class="opt-name mono">{{ r.matcher.value ?? r.toolName }}</div>
        <div class="opt-sub">{{ MATCHER_KIND_LABEL[r.matcher.kind] }}</div>
      </div>
      <div class="ui-segments">
        <button
          class="ui-seg"
          :class="{ on: r.revokedAt !== null, 'is-on': r.revokedAt !== null }"
          :data-testid="`rule-ask-${r.id}`"
          @click="setRuleMode(r, 'ask')"
        >
          Ask
        </button>
        <button
          class="ui-seg seg-auto"
          :class="{ on: r.revokedAt === null, 'is-on': r.revokedAt === null }"
          :data-testid="`rule-auto-${r.id}`"
          @click="setRuleMode(r, 'auto')"
        >
          Auto
        </button>
      </div>
    </div>
    <div class="ui-card card-opt static">
      <div class="opt-body">
        <div class="opt-name mono">rm · sudo · git push</div>
        <div class="opt-sub">Destructive or irreversible — can never be auto-approved</div>
      </div>
      <span class="chip-risk high">Always ask</span>
    </div>
  </div>
  <div class="add-cmd">
    <Icon name="plus" class="add-cmd-plus" />
    <input
      v-model="newCmd"
      class="add-cmd-input mono"
      data-testid="allowed-add-input"
      placeholder="Add a command — e.g. make build"
      @keydown.enter="addAllowedCommand"
    />
    <button class="btn-quiet" data-testid="allowed-add-btn" @click="addAllowedCommand">
      Allow
    </button>
  </div>
</template>

<style scoped>
.seg-auto.is-on {
  background: color-mix(in srgb, var(--green) 15%, transparent);
  color: var(--green);
}
</style>
