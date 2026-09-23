<script setup lang="ts">
import type { ProjectListItem } from '@shared/ipc-types'
import Icon from '@renderer/components/Icon.vue'

defineProps<{ project: ProjectListItem; error: string | null; busy: boolean }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const path = defineModel<string>({ required: true })
</script>

<template>
  <div class="overlay" data-testid="repoint-overlay" @click.self="emit('cancel')">
    <div
      class="dialog remove-dialog"
      data-testid="repoint-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repoint-dialog-title"
    >
      <div class="rd-icon" aria-hidden="true"><Icon name="swap" :size="18" /></div>
      <div id="repoint-dialog-title" class="rd-title">
        Change folder for {{ project.name }}
      </div>
      <div class="rd-body">
        <input
          v-model="path"
          class="mono repoint-input"
          data-testid="repoint-input"
          spellcheck="false"
          @keydown.enter="emit('confirm')"
        />
        <p class="rd-note dim">
          Sessions, history, and folder access move to the new folder. The name stays
          {{ project.name }}.
        </p>
        <p v-if="error" class="rd-error" data-testid="repoint-error">
          {{ error }}
        </p>
      </div>
      <div class="rd-actions">
        <button
          class="btn-solid"
          data-testid="repoint-confirm"
          :disabled="busy || path.trim().length === 0"
          @click="emit('confirm')"
        >
          Change folder
        </button>
        <button class="btn-outline" data-testid="repoint-cancel" @click="emit('cancel')">
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remove-dialog {
  width: 400px;
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  padding: 24px;
  box-shadow: var(--shadow-dlg);
  animation: sbIn 0.18s var(--ease);
}

.rd-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
  border-radius: var(--rc);
}

.rd-title {
  font-size: var(--fs-head);
  font-weight: var(--w-em);
  color: var(--text-bright);
  margin-top: 14px;
}

.rd-body {
  margin: 6px 0 0;
}

.rd-note {
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-meta);
  margin: 0;
}

.rd-error {
  font-size: var(--fs-meta);
  color: var(--red);
  margin: 8px 0 0;
}

.repoint-input {
  width: 100%;
  font-size: var(--fs-ui);
  padding: 9px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  color: var(--text-strong);
  margin-bottom: 10px;
}

.rd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 20px;
}

.rd-actions .btn-solid,
.rd-actions .btn-outline {
  flex: 1;
  text-align: center;
  font-family: var(--sans);
  font-size: var(--fs-ui);
  padding: 9px 0;
}

.rd-actions .btn-outline {
  color: var(--text-body);
}

.rd-actions .btn-outline:hover {
  border-color: var(--border-strong);
  color: var(--text-strong);
}
</style>
