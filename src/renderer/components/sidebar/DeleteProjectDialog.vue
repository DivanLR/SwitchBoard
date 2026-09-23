<script setup lang="ts">
import type { Project } from '@shared/domain'
import Icon from '@renderer/components/Icon.vue'

defineProps<{ project: Pick<Project, 'name' | 'path'>; error: string | null; busy: boolean }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <div class="overlay" data-testid="delete-overlay" @click.self="emit('cancel')">
    <div
      class="dialog delete-dialog"
      data-testid="delete-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
    >
      <div class="dd-icon" aria-hidden="true"><Icon name="trash" :size="18" /></div>
      <div id="delete-dialog-title" class="dd-title">Delete {{ project.name }} from Switchboard?</div>
      <div class="dd-path faint mono">{{ project.path }}</div>
      <div class="dd-lists">
        <div>
          <div class="dd-label">Goes, and cannot be restored</div>
          <ul data-testid="delete-goes">
            <li>its sessions and their history</li>
            <li>its standing rules and decisions</li>
            <li>drafts and the queue</li>
            <li>Tests, Diagrams and Flow run records</li>
            <li>its entries in Switchboard settings</li>
          </ul>
        </div>
        <div>
          <div class="dd-label">Stays on your machine</div>
          <ul data-testid="delete-stays">
            <li>the folder on disk</li>
            <li>its git history and branches</li>
            <li>worktrees on disk</li>
          </ul>
        </div>
      </div>
      <p v-if="error" class="dd-error" data-testid="delete-error">{{ error }}</p>
      <div class="dd-actions">
        <button class="btn-armed" data-testid="delete-confirm" :disabled="busy" @click="emit('confirm')">
          Delete from Switchboard
        </button>
        <button class="btn-outline" data-testid="delete-cancel" @click="emit('cancel')">Keep it</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.delete-dialog {
  width: 440px;
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  padding: 24px;
  box-shadow: var(--shadow-dlg);
  animation: sbIn 0.18s var(--ease);
}

.dd-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--red);
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
  border-radius: var(--rc);
}

.dd-title {
  font-size: var(--fs-head);
  font-weight: var(--w-em);
  color: var(--text-bright);
  margin-top: 14px;
}

.dd-path {
  font-size: var(--fs-micro);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dd-lists {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 14px;
}

.dd-label {
  font-size: var(--fs-meta);
  color: var(--text-mid);
}

.dd-lists ul {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-body);
}

.dd-error {
  font-size: var(--fs-meta);
  color: var(--red);
  margin: 12px 0 0;
}

.dd-actions {
  display: flex;
  gap: 9px;
  margin-top: 20px;
}

.dd-actions .btn-armed,
.dd-actions .btn-outline {
  flex: 1;
  text-align: center;
  font-size: var(--fs-ui);
  padding: 9px 0;
}
</style>
