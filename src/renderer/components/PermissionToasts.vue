<script setup lang="ts">
// In-app approval toast: when a session raises a permission, a card appears
// (top-right) showing what is being asked, with Approve / View in inbox right
// there — so a request can be actioned from the notification without opening
// the inbox. One toast at a time (the most recent), matching the design.
import { ref, computed } from 'vue'
import type { PermissionRequest } from '@shared/domain'
import { useInboxStore } from '@renderer/stores/inbox'
import { useProjectsStore } from '@renderer/stores/projects'

const inbox = useInboxStore()
const projects = useProjectsStore()

// The most recent unresolved request drives the toast.
const item = computed<PermissionRequest | null>(() => inbox.toasts[0] ?? null)

// Whether the current high-risk toast is armed for its explicit confirm step.
const armed = ref<string | null>(null)

function projectName(projectId: string): string {
  return projects.items.find((p) => p.id === projectId)?.name ?? 'A project'
}

function riskLabel(req: PermissionRequest): string {
  if (req.type === 'plan_approval') return 'Plan'
  return req.risk === 'high' ? 'High' : req.risk === 'medium' ? 'Medium' : 'Low'
}

async function approve(req: PermissionRequest): Promise<void> {
  if (req.risk === 'high' && req.type === 'tool_permission' && armed.value !== req.id) {
    armed.value = req.id
    return
  }
  armed.value = null
  await inbox.decide(req.id, 'approve', req.risk === 'high')
}

function view(req: PermissionRequest): void {
  inbox.dismissToast(req.id)
  inbox.focusRequest(req.id)
}
</script>

<template>
  <div v-if="item" class="toast" data-testid="permission-toasts" :data-request-id="item.id">
    <div class="t-head">
      <span class="t-dot"></span>
      <span class="t-kind mono">PERMISSION REQUEST</span>
      <span class="t-project mono">· {{ projectName(item.projectId) }}</span>
      <span style="flex: 1"></span>
      <button class="t-x mono" data-testid="toast-dismiss" title="Dismiss" @click="inbox.dismissToast(item.id)">✕</button>
    </div>
    <div class="t-title">{{ item.title }}</div>
    <div class="t-explain">{{ item.explanation }}</div>
    <div class="t-detail mono" data-testid="toast-detail">{{ item.detail }}</div>
    <div class="t-actions">
      <button
        v-if="armed === item.id"
        class="btn-armed"
        :data-testid="`toast-confirm-${item.id}`"
        @click="approve(item)"
      >
        Confirm high-risk
      </button>
      <button v-else class="btn-solid" :data-testid="`toast-approve-${item.id}`" @click="approve(item)">
        Approve
      </button>
      <button class="btn-outline" data-testid="toast-view" @click="view(item)">View in inbox</button>
      <span style="flex: 1"></span>
      <span
        class="chip-risk"
        :class="item.type === 'plan_approval' ? 'plan' : item.risk"
        data-testid="toast-risk"
      >
        {{ riskLabel(item) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  top: 14px;
  right: 16px;
  z-index: 80;
  width: 344px;
  max-width: 86vw;
  background: var(--bg-panel-2, #12161f);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  padding: 13px 14px;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.03) inset;
  animation: sbIn 0.25s ease;
}

.t-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.t-dot {
  width: 7px;
  min-width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--amber);
  animation: sbPulse 1.8s ease infinite;
}

.t-kind {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--amber);
}

.t-project {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.t-x {
  color: var(--text-tab);
  font-size: 12px;
  padding: 0 4px;
}

.t-x:hover {
  color: var(--text-body);
}

.t-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
  margin-top: 8px;
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.t-explain {
  font-size: 12px;
  color: var(--text-mid);
  margin-top: 4px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.t-detail {
  font-size: 10.5px;
  color: var(--detail);
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  border-radius: 7px;
  padding: 5px 9px;
  margin-top: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

.t-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
}
</style>
