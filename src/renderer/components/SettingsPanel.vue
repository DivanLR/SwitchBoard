<script setup lang="ts">
// Settings dialog (FR-021) styled to the Switchboard design language.
import { onMounted, ref } from 'vue'
import type { Settings } from '@shared/domain'

const emit = defineEmits<{ (e: 'close'): void }>()
const settings = ref<Settings | null>(null)

onMounted(async () => {
  settings.value = await window.switchboard.invoke('settings.get', undefined)
})

async function save(patch: Partial<Settings>): Promise<void> {
  settings.value = await window.switchboard.invoke('settings.set', patch)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog settings" data-testid="settings-panel">
      <div class="head">
        <div class="title mono">settings</div>
        <button class="btn-outline" @click="emit('close')">close</button>
      </div>
      <div v-if="settings" class="body">
        <label class="row">
          <span class="mono">default stream view</span>
          <select
            class="mono"
            :value="settings.defaultView"
            data-testid="setting-default-view"
            @change="save({ defaultView: ($event.target as HTMLSelectElement).value as 'clean' | 'raw' })"
          >
            <option value="clean">clean</option>
            <option value="raw">raw</option>
          </select>
        </label>
        <label class="row">
          <span class="mono">desktop notifications</span>
          <input
            type="checkbox"
            :checked="settings.notificationsEnabled"
            data-testid="setting-notifications"
            @change="save({ notificationsEnabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <label class="row">
          <span class="mono">terse mode (fewer output tokens)</span>
          <input
            type="checkbox"
            :checked="settings.terseMode"
            data-testid="setting-terse-mode"
            @change="save({ terseMode: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <label v-if="settings.terseMode" class="row">
          <span class="mono">terse level</span>
          <select
            class="mono"
            :value="settings.terseLevel"
            data-testid="setting-terse-level"
            @change="save({ terseLevel: ($event.target as HTMLSelectElement).value as 'lite' | 'full' | 'ultra' })"
          >
            <option value="lite">lite</option>
            <option value="full">full</option>
            <option value="ultra">ultra</option>
          </select>
        </label>
        <p class="hint mono">
          Terse mode compresses only Claude's replies to you (output tokens); your prompts and the
          context Claude reads are unchanged. It applies to sessions started after the change. Code,
          commands, and errors are preserved exactly.
        </p>
        <p class="hint mono">
          Raw output is kept for the current and previous session per project; decision history for
          {{ settings.retentionDecisionDays }} days. All data stays on this machine.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: 420px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.body {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-body);
}

.row select {
  font-size: 11.5px;
}

.hint {
  font-size: 10.5px;
  color: var(--text-faint);
  line-height: 1.5;
  margin: 0;
}
</style>
