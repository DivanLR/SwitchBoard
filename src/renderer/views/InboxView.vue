<script setup lang="ts">
// Central inbox panel — 1:1 with the design reference: inbox/history tabs with
// amber count badge, per-project groups (status dot, name, "N pending",
// "approve all"), item cards with risk chip / explanation / detail box /
// approve+deny, and the history list of ✓/✗ rows (FR-007..013, SC-004).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PermissionRequest } from '@shared/domain'
import { useInboxStore } from '@renderer/stores/inbox'
import { useProjectsStore } from '@renderer/stores/projects'

const inbox = useInboxStore()
const projects = useProjectsStore()

const tab = ref<'inbox' | 'history'>('inbox')
const confirmingId = ref<string | null>(null)
const ruleOfferId = ref<string | null>(null)
const historyFilter = ref<string>('')
const expandedHistory = ref(new Set<string>())

function toggleHistory(id: string): void {
  const next = new Set(expandedHistory.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedHistory.value = next
}

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void inbox.refresh()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 5000)
})
onUnmounted(() => clearInterval(timer))

watch(tab, (value) => {
  if (value === 'history') void inbox.loadHistory(historyFilter.value || undefined)
})

watch(historyFilter, () => {
  if (tab.value === 'history') void inbox.loadHistory(historyFilter.value || undefined)
})

watch(
  () => inbox.focusRequestId,
  (requestId) => {
    if (!requestId) return
    tab.value = 'inbox'
    void nextTick(() => {
      document.querySelector(`[data-request-id="${requestId}"]`)?.scrollIntoView({ block: 'center' })
      inbox.focusRequestId = null
    })
  },
)

function projectName(projectId: string): string {
  return projects.items.find((p) => p.id === projectId)?.name ?? 'unknown'
}

function age(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((now.value - Date.parse(createdAt)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

async function approve(item: PermissionRequest): Promise<void> {
  if (item.risk === 'high' && item.type === 'tool_permission' && confirmingId.value !== item.id) {
    confirmingId.value = item.id
    return
  }
  confirmingId.value = null
  await inbox.decide(item.id, 'approve', item.risk === 'high')
}

async function deny(item: PermissionRequest): Promise<void> {
  confirmingId.value = null
  await inbox.decide(item.id, 'deny')
}

const ruleEligible = (item: PermissionRequest): boolean =>
  item.type === 'tool_permission' && item.risk !== 'high'

/**
 * Human description of the rule that will be saved. The exact matcher is derived
 * server-side from the real tool input (the broker never trusts a client-sent
 * matcher); this only mirrors that logic for the preview.
 */
function ruleDescription(item: PermissionRequest): string {
  if (item.toolName === 'Bash') {
    const words = item.detail.replace(/^Bash:\s*/, '').trim().split(/\s+/)
    return `commands starting "${words.slice(0, 2).join(' ')}"`
  }
  return `${item.toolName} within this file's folder`
}

async function saveAlwaysAllow(item: PermissionRequest): Promise<void> {
  ruleOfferId.value = null
  // Matcher is derived server-side from the original request; pass nothing.
  await inbox.alwaysAllow(item.id)
}

async function approveAll(projectId: string): Promise<void> {
  await inbox.approveAllForProject(projectId)
}

const historyItems = computed(() => inbox.history)
</script>

<template>
  <aside class="inbox">
    <!-- Tabs -->
    <div class="tabs">
      <div
        class="tab"
        :class="{ on: tab === 'inbox' }"
        data-testid="inbox-tab-pending"
        @click="tab = 'inbox'"
      >
        Inbox
        <span v-if="inbox.pendingCount > 0" class="badge-count" data-testid="inbox-badge">
          {{ inbox.pendingCount }}
        </span>
      </div>
      <div
        class="tab"
        :class="{ on: tab === 'history' }"
        data-testid="inbox-tab-history"
        @click="tab = 'history'"
      >
        History
      </div>
    </div>

    <div v-if="inbox.undeliverableNotice" class="notice mono" data-testid="undeliverable-notice">
      {{ inbox.undeliverableNotice }}
      <button class="notice-dismiss" @click="inbox.dismissNotice()">Dismiss</button>
    </div>

    <!-- Inbox tab -->
    <div v-if="tab === 'inbox'" class="body">
      <div v-if="inbox.groups.length === 0" class="empty" data-testid="inbox-zero">
        <div class="empty-icon mono">✓</div>
        <div class="empty-title">Inbox zero</div>
        <div class="empty-sub">New permission requests from any project land here.</div>
      </div>

      <div
        v-for="group in inbox.groups"
        :key="group.projectId"
        class="group"
        :data-testid="`inbox-group-${projectName(group.projectId)}`"
      >
        <div class="group-head">
          <span class="dot needs_you"></span>
          <span class="group-name mono">{{ projectName(group.projectId) }}</span>
          <span class="group-count mono">· {{ group.items.length }} pending</span>
          <span style="flex: 1"></span>
          <button
            v-if="group.items.length > 1"
            class="link-green"
            data-testid="approve-all"
            title="Approves all pending non-high-risk items in this group"
            @click="approveAll(group.projectId)"
          >
            Approve all
          </button>
        </div>

        <div
          v-for="item in group.items"
          :key="item.id"
          class="item"
          data-testid="inbox-item"
          :data-request-id="item.id"
        >
          <div class="item-head">
            <div class="item-main">
              <div class="item-title" data-testid="item-title">{{ item.title }}</div>
              <div class="item-sub">
                <span v-if="item.toolName" class="item-tool mono">{{ item.toolName }}</span>
                <span class="item-ago mono">{{ age(item.createdAt) }}</span>
              </div>
            </div>
            <span
              v-if="item.type === 'plan_approval'"
              class="chip-risk plan"
              data-testid="item-risk"
              >Plan</span
            >
            <span v-else class="chip-risk" :class="item.risk" data-testid="item-risk">
              {{ item.risk === 'high' ? 'High' : item.risk === 'medium' ? 'Medium' : 'Low' }}
            </span>
          </div>
          <div class="item-explain">{{ item.explanation }}</div>
          <div class="item-detail mono" data-testid="item-detail">{{ item.detail }}</div>

          <div class="item-actions">
            <template v-if="confirmingId === item.id">
              <button class="btn-armed" data-testid="confirm-high-risk" @click="approve(item)">
                Confirm high-risk
              </button>
              <button class="btn-outline" @click="confirmingId = null">Back</button>
            </template>
            <template v-else-if="ruleOfferId === item.id">
              <span class="rule-offer mono">Always allow {{ ruleDescription(item) }}?</span>
              <button class="btn-solid" data-testid="confirm-always-allow" @click="saveAlwaysAllow(item)">
                Save rule
              </button>
              <button class="btn-outline" @click="ruleOfferId = null">Back</button>
            </template>
            <template v-else>
              <button class="btn-solid" data-testid="approve-btn" @click="approve(item)">Approve</button>
              <button class="btn-outline" data-testid="deny-btn" @click="deny(item)">Deny</button>
              <button
                v-if="ruleEligible(item)"
                class="always-link mono"
                data-testid="always-allow-btn"
                @click="ruleOfferId = item.id"
              >
                Always allow
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- History tab -->
    <div v-else class="body history">
      <div class="history-filter-row">
        <select v-model="historyFilter" class="history-filter mono" data-testid="history-filter">
          <option value="">All projects</option>
          <option v-for="p in projects.items" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <div v-if="historyItems.length === 0" class="empty-sub" style="padding: 24px 4px">
        No decisions recorded yet.
      </div>
      <div
        v-for="h in historyItems"
        :key="h.id"
        class="hist-row"
        :class="{ open: expandedHistory.has(h.id) }"
        data-testid="history-item"
        @click="toggleHistory(h.id)"
      >
        <div class="hist-head">
          <span
            class="hist-arrow mono"
            :data-testid="`history-arrow-${h.id}`"
            :class="{ open: expandedHistory.has(h.id) }"
            >▸</span
          >
          <span
            v-if="h.status === 'approved' || h.status === 'rule_approved'"
            class="hist-mark mono"
            style="color: var(--green)"
            :data-testid="`outcome-${h.status}`"
          >
            ✓
          </span>
          <span v-else class="hist-mark mono" style="color: var(--red)" :data-testid="`outcome-${h.status}`">
            ✗
          </span>
          <div class="hist-main">
            <div class="hist-title">{{ h.title }}</div>
            <div class="hist-sub mono">
              {{ projectName(h.projectId) }} · {{ h.detail
              }}<span v-if="h.deliveryFailed" data-testid="delivery-failed"> · delivery failed</span>
            </div>
          </div>
          <span class="hist-ago mono">{{ age(h.resolvedAt) }}</span>
        </div>
        <div v-if="expandedHistory.has(h.id)" class="hist-detail" data-testid="history-detail" @click.stop>
          <div v-if="h.explanation" class="hd-explain">{{ h.explanation }}</div>
          <pre class="hd-detail mono">{{ h.detail }}</pre>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.inbox {
  width: 332px;
  min-width: 332px;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  padding: 0 8px;
}

.tab {
  padding: 11px 12px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-tab);
  cursor: pointer;
  display: flex;
  gap: 7px;
  align-items: center;
}

.tab:hover {
  color: var(--text-body);
}

.tab.on {
  color: var(--text-strong);
  box-shadow: inset 0 -2px 0 var(--green);
  cursor: default;
}

.tab.on .badge-count {
  line-height: 15px;
}

.notice {
  margin: 10px 12px 0;
  padding: 8px 10px;
  border: 1px solid rgba(232, 180, 90, 0.4);
  border-radius: 6px;
  color: var(--amber);
  font-size: 10.5px;
  line-height: 1.5;
}

.notice-dismiss {
  display: block;
  margin-top: 5px;
  color: var(--amber);
  font-family: var(--mono);
  font-size: 10.5px;
  text-decoration: underline;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.empty {
  padding: 48px 16px;
  text-align: center;
}

.empty-icon {
  font-size: 22px;
  color: var(--green);
}

.empty-title {
  font-size: 13px;
  color: var(--text-mid);
  margin-top: 10px;
}

.empty-sub {
  font-size: 11.5px;
  color: var(--text-faint);
  margin-top: 4px;
  line-height: 1.5;
}

.group {
  margin-bottom: 16px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 2px 8px;
}

.group-name {
  font-size: 11.5px;
  color: var(--text-body);
}

.group-count {
  font-size: 10.5px;
  color: var(--text-faint);
}

.item {
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 8px;
  padding: 11px 12px;
  margin-bottom: 8px;
  animation: sbIn 0.25s ease;
}

.item-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.item-main {
  flex: 1;
  min-width: 0;
}

.item-sub {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.item-tool {
  font-size: 10px;
  color: var(--text-tab);
  background: var(--bg-chip);
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}

.item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
  /* Full ask, wrapped — never truncated or off-screen. */
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.item-explain {
  font-size: 12.2px;
  line-height: 1.5;
  color: var(--text-mid);
  margin-top: 5px;
  text-wrap: pretty;
  overflow-wrap: anywhere;
}

.item-detail {
  font-size: 11px;
  color: var(--detail);
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  border-radius: 5px;
  padding: 6px 9px;
  margin-top: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.always-link {
  color: var(--text-tab);
  font-size: 10.5px;
}

.always-link:hover {
  color: var(--green);
  text-decoration: underline;
}

.rule-offer {
  font-size: 10.5px;
  color: var(--text-mid);
}

.item-ago {
  font-size: 10.5px;
  color: var(--text-faint);
}

.history-filter-row {
  margin-bottom: 8px;
}

.history-filter {
  width: 100%;
  font-size: 11px;
  padding: 5px 8px;
  background: var(--bg-code);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-body);
}

.hist-row {
  padding: 3px 2px;
  border-bottom: 1px solid var(--border-hist);
  cursor: pointer;
}

.hist-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
}

.hist-arrow {
  font-size: 10px;
  color: var(--text-faint);
  width: 10px;
  transition: transform 0.12s ease;
}

.hist-arrow.open {
  transform: rotate(90deg);
}

.hist-row:hover .hist-arrow {
  color: var(--text-mid);
}

.hist-mark {
  font-size: 12px;
  width: 14px;
}

.hist-main {
  flex: 1;
  min-width: 0;
}

.hist-title {
  font-size: 12.5px;
  color: var(--text-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hist-detail {
  margin: 2px 0 8px 32px;
}

.hd-explain {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-mid);
  margin-bottom: 6px;
  text-wrap: pretty;
}

.hd-detail {
  font-size: 11px;
  color: var(--detail);
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  border-radius: 6px;
  padding: 6px 9px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 200px;
  overflow: auto;
}

.hist-sub {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.hist-ago {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
}
</style>
