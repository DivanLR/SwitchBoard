<script setup lang="ts">
// Settings dialog (FR-021) styled to the Switchboard design language.
// State and transport live in the settings store; this view renders and acts.
import { computed, onMounted } from 'vue'
import type { Settings } from '@shared/domain'
import { MODEL_CHOICES } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'

const emit = defineEmits<{ (e: 'close'): void }>()
const store = useSettingsStore()
const settings = computed(() => store.settings)

onMounted(() => {
  void store.load()
})

function save(patch: Partial<Settings>): void {
  void store.save(patch)
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
        <div class="model-group">
          <div class="section-label mono">PLANNING MODEL</div>
          <div class="mg-desc">Used while a session is in plan mode.</div>
          <div class="model-cards">
            <button
              v-for="m in MODEL_CHOICES"
              :key="m.id"
              class="model-card"
              :class="{ sel: settings.planModel === m.id }"
              :data-testid="`plan-model-${m.id}`"
              @click="save({ planModel: m.id })"
            >
              <span class="mc-dot" :class="{ on: settings.planModel === m.id }"></span>
              <span class="mc-name mono">{{ m.label }}</span>
            </button>
          </div>
        </div>

        <div class="model-group">
          <div class="section-label mono">WORK MODEL</div>
          <div class="mg-desc">Runs normal work turns.</div>
          <div class="model-cards">
            <button
              v-for="m in MODEL_CHOICES"
              :key="m.id"
              class="model-card"
              :class="{ sel: settings.workModel === m.id }"
              :data-testid="`work-model-${m.id}`"
              @click="save({ workModel: m.id })"
            >
              <span class="mc-dot" :class="{ on: settings.workModel === m.id }"></span>
              <span class="mc-name mono">{{ m.label }}</span>
            </button>
          </div>
        </div>
        <p class="hint mono">Both apply to sessions started after the change.</p>

        <div class="section-label mono">DISPLAY & BEHAVIOR</div>
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
  width: 440px;
  max-height: 82vh;
  overflow-y: auto;
}

.section-label {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--text-faint);
  margin-top: 4px;
}

.model-group {
  margin-bottom: 4px;
}

.mg-desc {
  font-size: 12px;
  color: var(--text-meta);
  margin: 4px 0 10px;
}

.model-cards {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.model-card {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 13px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
}

.model-card:hover {
  border-color: var(--border-strong);
}

.model-card.sel {
  background: rgba(62, 207, 154, 0.06);
  border-color: rgba(62, 207, 154, 0.4);
}

.mc-dot {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: 99px;
  border: 1.5px solid var(--border-strong);
}

.mc-dot.on {
  background: var(--green);
  border-color: var(--green);
}

.mc-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-body);
}

.model-card.sel .mc-name {
  color: var(--text-strong);
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
