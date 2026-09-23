<script setup lang="ts">
import type { ProjectListItem } from '@shared/ipc-types'
import Icon from '@renderer/components/Icon.vue'

defineProps<{ project: ProjectListItem; error: string | null; busy: boolean }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <div class="overlay" data-testid="remove-overlay" @click.self="emit('cancel')">
    <div
      class="dialog remove-dialog"
      data-testid="remove-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-dialog-title"
    >
      <div class="rd-icon" aria-hidden="true"><Icon name="folder" :size="18" /></div>
      <div id="remove-dialog-title" class="rd-title">Archive {{ project.name }}?</div>
      <div class="rd-body">
        <div class="rd-path faint mono">{{ project.path }}</div>
        <p class="rd-note dim">
          It moves to the Archived section at the foot of the list, and can be restored from
          there. Sessions, settings, files and git history are untouched.
        </p>
        <p v-if="error" class="rd-error" data-testid="remove-error">{{ error }}</p>
      </div>
      <div class="rd-actions">
        <button
          class="btn-solid"
          data-testid="remove-confirm"
          :disabled="busy"
          @click="emit('confirm')"
        >
          Archive
        </button>
        <button class="btn-outline" data-testid="remove-cancel" @click="emit('cancel')">Keep it</button>
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

.rd-path {
  font-size: var(--fs-micro);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
