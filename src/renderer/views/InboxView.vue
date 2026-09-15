<script setup lang="ts">
import { nextTick, onMounted, onWatcherCleanup, ref, watch } from 'vue'
import { isDangerousCommand, type DecisionRecord, type PermissionRequest } from '@shared/domain'
import { useInboxStore } from '@renderer/stores/inbox'
import { useProjectsStore } from '@renderer/stores/projects'
import { relativeTime } from '@renderer/relative-time'
import { useNow } from '@renderer/composables/useNow'
import Icon from '@renderer/components/Icon.vue'

const RISK_LABEL: Record<'low' | 'medium' | 'high', string> = { low: 'Low', medium: 'Medium', high: 'High' }

const inbox = useInboxStore()
const projects = useProjectsStore()
const emit = defineEmits<{ (e: 'collapse'): void }>()

const tab = ref<'inbox' | 'history'>('inbox')
const confirmingId = ref<string | null>(null)
const alwaysConfirmId = ref<string | null>(null)
const expandedHistory = ref(new Set<string>())
const expandedExplain = ref(new Set<string>())

function toggleHistory(id: string): void {
  const set = expandedHistory.value
  if (set.has(id)) set.delete(id)
  else set.add(id)
}

function toggleExplain(id: string): void {
  const set = expandedExplain.value
  if (set.has(id)) set.delete(id)
  else set.add(id)
}

const now = useNow(5000)
onMounted(() => void inbox.refresh())

watch(
  () => inbox.groups.map((g) => g.projectId).join(','),
  () => void loadCoveredBases(),
  { immediate: true },
)
watch(tab, async (value) => {
  if (value !== 'history') return
  let superseded = false
  onWatcherCleanup(() => {
    superseded = true
  })
  await inbox.loadHistory()
  if (superseded) return
  await loadCoveredBases()
})

watch(
  () => inbox.focusRequestId,
  (requestId) => {
    if (!requestId) return
    tab.value = 'inbox'
    void nextTick(() => {
      document.querySelector(`[data-request-id="${requestId}"]`)?.scrollIntoView({ block: 'center' })
      inbox.clearFocusRequest()
    })
  },
)

function projectName(projectId: string): string {
  return projects.items.find((p) => p.id === projectId)?.name ?? 'unknown'
}

const age = (createdAt: string): string => relativeTime(createdAt, now.value)

async function approve(item: PermissionRequest): Promise<void> {
  if (item.risk === 'high' && item.type === 'tool_permission' && confirmingId.value !== item.id) {
    confirmingId.value = item.id
    alwaysConfirmId.value = null
    return
  }
  confirmingId.value = null
  await inbox.decide(item.id, 'approve', item.risk === 'high')
}

async function deny(item: PermissionRequest): Promise<void> {
  confirmingId.value = null
  alwaysConfirmId.value = null
  await inbox.decide(item.id, 'deny')
}

function isMcpItem(item: PermissionRequest): boolean {
  return item.toolName?.startsWith('mcp__') ?? false
}

const SELF_NAMING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'WebFetch', 'WebSearch'])

function showToolChip(item: PermissionRequest): boolean {
  return isMcpItem(item) || !SELF_NAMING_TOOLS.has(item.toolName ?? '')
}

function isDuplicateDetail(item: Pick<PermissionRequest, 'toolName' | 'title' | 'detail'>): boolean {
  return item.toolName === 'Bash' && item.title.endsWith(item.detail)
}

function toolShortName(item: PermissionRequest): string {
  const name = item.toolName ?? ''
  const parts = name.split('__')
  return parts.length >= 3 ? parts.slice(2).join('__') : name
}

const histCtx = ref<{
  id: string
  detail: string
  allowBase: string | null
  x: number
  y: number
} | null>(null)

function baseCmd(detail: string): string {
  const words = detail.trim().split(/\s+/)
  return words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : (words[0] ?? '')
}

const coveredBases = ref<Record<string, string[]>>({})

async function loadCoveredBases(): Promise<void> {
  const projectIds = [
    ...new Set([...inbox.groups.map((g) => g.projectId), ...inbox.history.map((h) => h.projectId)]),
  ]
  const entries = await Promise.all(
    projectIds.map(async (id) => [id, await inbox.allowedCommandBases(id)] as const),
  )
  coveredBases.value = Object.fromEntries(entries)
}

function alreadyAllowed(projectId: string, base: string): boolean {
  return (coveredBases.value[projectId] ?? []).some(
    (v) => base === v || base.startsWith(`${v} `),
  )
}

function canAlwaysAllow(item: PermissionRequest): boolean {
  if (item.type !== 'tool_permission') return false
  if (isMcpItem(item)) return true
  if (item.toolName !== 'Bash' || item.risk === 'high') return false
  if (isDangerousCommand(item.detail)) return false
  return !alreadyAllowed(item.projectId, baseCmd(item.detail))
}

async function alwaysAllowSimilar(item: PermissionRequest): Promise<void> {
  if (isMcpItem(item) && item.risk === 'high' && alwaysConfirmId.value !== item.id) {
    alwaysConfirmId.value = item.id
    confirmingId.value = null
    return
  }
  alwaysConfirmId.value = null
  confirmingId.value = null
  await inbox.approveAlways(item.id, item.risk === 'high')
  await loadCoveredBases()
}

function openHistCtxAt(h: DecisionRecord, x: number, y: number): void {
  const base = baseCmd(h.detail)
  const eligible =
    h.type === 'tool_permission' &&
    h.toolName === 'Bash' &&
    !isDangerousCommand(h.detail) &&
    !alreadyAllowed(h.projectId, base)
  histCtx.value = {
    id: h.id,
    detail: h.detail,
    allowBase: eligible ? base || null : null,
    x: Math.min(x, window.innerWidth - 345),
    y: Math.min(y, window.innerHeight - 130),
  }
}

function openHistCtx(h: DecisionRecord, event: MouseEvent): void {
  openHistCtxAt(h, event.clientX, event.clientY)
}

function openHistCtxKeyboard(h: DecisionRecord, event: KeyboardEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  openHistCtxAt(h, rect.left + 24, rect.bottom)
}

async function allowFromHist(): Promise<void> {
  const ctx = histCtx.value
  histCtx.value = null
  if (ctx?.allowBase) {
    await inbox.alwaysAllow(ctx.id)
    await loadCoveredBases() 
  }
}

async function removeHist(): Promise<void> {
  const ctx = histCtx.value
  histCtx.value = null
  if (ctx) await inbox.deleteHistory(ctx.id)
}

const approveAllConfirmId = ref<string | null>(null)

function groupHighRiskCount(items: PermissionRequest[]): number {
  return items.filter((i) => i.risk === 'high' && i.type === 'tool_permission').length
}

async function approveAll(group: { projectId: string; items: PermissionRequest[] }): Promise<void> {
  const highRisk = groupHighRiskCount(group.items)
  if (highRisk > 0 && approveAllConfirmId.value !== group.projectId) {
    approveAllConfirmId.value = group.projectId
    return
  }
  approveAllConfirmId.value = null
  await inbox.approveAllForProject(group.projectId, highRisk > 0)
}
</script>

<template>
  <aside class="inbox" data-testid="inbox-view">
    <div class="tabs" role="tablist" aria-label="Inbox and history">
      <button
        type="button"
        class="tab"
        :class="{ on: tab === 'inbox' }"
        data-testid="inbox-tab-pending"
        role="tab"
        :aria-selected="tab === 'inbox'"
        @click="tab = 'inbox'"
      >
        Inbox
        <span v-if="inbox.pendingCount > 0" class="badge-count" data-testid="inbox-badge">
          {{ inbox.pendingCount }}
        </span>
      </button>
      <button
        type="button"
        class="tab"
        :class="{ on: tab === 'history' }"
        data-testid="inbox-tab-history"
        role="tab"
        :aria-selected="tab === 'history'"
        @click="tab = 'history'"
      >
        History
      </button>
      <span class="spacer"></span>
      <button
        class="inbox-collapse"
        data-testid="inbox-collapse"
        title="Collapse the inbox"
        @click="emit('collapse')"
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M5.75 3.5 L10.25 8 L5.75 12.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <div v-if="inbox.undeliverableNotice" class="notice" data-testid="undeliverable-notice">
      {{ inbox.undeliverableNotice }}
      <button class="notice-dismiss" data-testid="notice-dismiss" @click="inbox.dismissNotice()">
        Dismiss
      </button>
    </div>

    <div v-if="tab === 'inbox'" class="body" aria-live="polite" aria-relevant="additions">
      <div v-if="inbox.groups.length === 0" class="empty" data-testid="inbox-zero">
        <Icon name="check" class="empty-icon" :size="18" />
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
          <span class="group-dot"></span>
          <span class="group-name mono">{{ projectName(group.projectId) }}</span>
          <span class="group-count mono">· {{ group.items.length }} pending</span>
          <span class="spacer"></span>
          <template v-if="approveAllConfirmId === group.projectId">
            <span class="approve-all-warn" data-testid="approve-all-warn">
              Includes {{ groupHighRiskCount(group.items) }} high-risk. Sure?
            </span>
            <button
              class="link-armed"
              data-testid="approve-all-confirm"
              @click="approveAll(group)"
            >
              Approve all
            </button>
            <button class="link-quiet" data-testid="approve-all-cancel" @click="approveAllConfirmId = null">
              Cancel
            </button>
          </template>
          <button
            v-else-if="group.items.length > 1"
            class="link-green"
            data-testid="approve-all"
            title="Approves all pending items; high-risk items ask for confirmation first"
            @click="approveAll(group)"
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
                <span v-if="item.toolName && showToolChip(item)" class="item-tool mono">{{ item.toolName }}</span>
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
              {{ RISK_LABEL[item.risk] }}
            </span>
          </div>
          <button
            type="button"
            class="item-explain-toggle"
            data-testid="item-explain-toggle"
            :aria-expanded="expandedExplain.has(item.id)"
            @click="toggleExplain(item.id)"
          >
            <Icon name="chevron-right" class="hist-arrow" :class="{ open: expandedExplain.has(item.id) }" :size="10" />
            Why
          </button>
          <div v-if="expandedExplain.has(item.id)" class="item-explain">{{ item.explanation }}</div>
          <div
            v-if="!isDuplicateDetail(item)"
            class="item-detail detail-box mono"
            data-testid="item-detail"
          >{{ item.detail }}</div>

          <div class="item-actions">
            <template v-if="confirmingId === item.id">
              <button class="btn-armed" data-testid="confirm-high-risk" @click="approve(item)">
                Confirm high-risk
              </button>
              <button class="btn-outline" @click="confirmingId = null">Back</button>
            </template>
            <template v-else-if="alwaysConfirmId === item.id">
              <button
                class="btn-armed"
                data-testid="confirm-always-allow"
                :title="`Auto-approve every ${item.toolName} call in this project from now on`"
                @click="alwaysAllowSimilar(item)"
              >
                Confirm — always allow {{ toolShortName(item) }}
              </button>
              <button class="btn-outline" @click="alwaysConfirmId = null">Back</button>
            </template>
            <template v-else>
              <button class="btn-solid" data-testid="approve-btn" @click="approve(item)">Approve</button>
              <button class="btn-outline" data-testid="deny-btn" @click="deny(item)">Deny</button>
            </template>
          </div>

          <button
            v-if="canAlwaysAllow(item) && confirmingId !== item.id && alwaysConfirmId !== item.id"
            class="item-standing"
            data-testid="always-allow-btn"
            :title="
              isMcpItem(item)
                ? `Auto-approve every ${item.toolName} call in this project from now on`
                : 'Creates a standing rule for this command and approves it now'
            "
            @click="alwaysAllowSimilar(item)"
          >
            {{ isMcpItem(item) ? `Always allow ${toolShortName(item)}` : 'Always allow similar' }}
            <Icon name="arrow-right" :size="12" />
          </button>
        </div>
      </div>
    </div>

    <div v-else class="body history">
      <div class="hist-header">
        <span class="hist-count mono" data-testid="history-count">
          DECISIONS · {{ inbox.history.length }}
        </span>
        <span class="spacer"></span>
        <button
          v-if="inbox.history.length > 0"
          class="hist-clear mono"
          data-testid="history-clear"
          @click="inbox.clearHistory()"
        >
          <Icon name="close" class="hist-clear-x" :size="11" />Clear history
        </button>
      </div>
      <div v-if="inbox.history.length === 0" class="hist-empty">
        History cleared.<br />New approvals and denials will land here.
      </div>
      <div
        v-for="h in inbox.history"
        :key="h.id"
        class="hist-row"
        :class="{ open: expandedHistory.has(h.id) }"
        data-testid="history-item"
        title="Right-click, or press the Menu key, for options"
        role="button"
        tabindex="0"
        :aria-expanded="expandedHistory.has(h.id)"
        @click="toggleHistory(h.id)"
        @keydown.enter.prevent="toggleHistory(h.id)"
        @keydown.space.prevent="toggleHistory(h.id)"
        @keydown.f10.shift.prevent="openHistCtxKeyboard(h, $event)"
        @keydown.context-menu.prevent="openHistCtxKeyboard(h, $event)"
        @contextmenu.prevent="openHistCtx(h, $event)"
      >
        <div class="hist-head">
          <Icon
            name="chevron-right"
            class="hist-arrow"
            :data-testid="`history-arrow-${h.id}`"
            :class="{ open: expandedHistory.has(h.id) }"
            :size="10"
          />
          <Icon
            v-if="h.status === 'approved' || h.status === 'rule_approved'"
            name="check"
            class="hist-mark"
            style="color: var(--green)"
            :data-testid="`outcome-${h.status}`"
            :size="12"
          />
          <Icon
            v-else
            name="cross"
            class="hist-mark"
            style="color: var(--red)"
            :data-testid="`outcome-${h.status}`"
            :size="12"
          />
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
          <pre v-if="!isDuplicateDetail(h)" class="hd-detail detail-box mono">{{ h.detail }}</pre>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="histCtx"
        class="ctx-catcher"
        @click="histCtx = null"
        @contextmenu.prevent="histCtx = null"
      >
        <div
          class="hctx-menu"
          data-testid="hist-ctx-menu"
          :style="{ left: `${histCtx.x}px`, top: `${histCtx.y}px` }"
          @click.stop
        >
          <div class="hctx-detail mono">{{ histCtx.detail }}</div>
          <button
            v-if="histCtx.allowBase"
            class="hctx-item mono"
            data-testid="hist-ctx-allow"
            @click="allowFromHist"
          >
            <Icon name="check" style="color: var(--green)" :size="12" />
            <span>Always allow <span class="hctx-base">{{ histCtx.allowBase }}</span> commands</span>
          </button>
          <button class="hctx-item mono danger" data-testid="hist-ctx-remove" @click="removeHist">
            <Icon name="close" :size="12" />
            <span>Remove this entry</span>
          </button>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.inbox {
  width: var(--inbox-w, 332px);
  min-width: var(--inbox-w, 332px);
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 6px 12px 0;
}

.inbox-collapse {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-faint);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  background: transparent;
  cursor: pointer;
}

.inbox-collapse:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.inbox-collapse svg {
  display: block;
}

.tab {
  padding: 14px 12px;
  font-family: var(--sans);
  font-size: var(--fs-ui);
  font-weight: 500;
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
  color: var(--green);
  box-shadow: inset 0 -2px 0 var(--green);
  cursor: default;
}

.tab .badge-count {
  line-height: 15px;
}

.notice {
  margin: 10px 12px 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
  border-radius: var(--rc);
  color: var(--amber);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.notice-dismiss {
  display: block;
  margin-top: 5px;
  color: var(--amber);
  font-family: var(--sans);
  font-size: var(--fs-micro);
  text-decoration: underline;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.body.history {
  padding: 8px 14px;
}

.empty {
  padding: 48px 16px;
  text-align: center;
}

.empty-icon {
  color: var(--green);
}

.empty-title {
  font-size: var(--fs-body);
  color: var(--text-mid);
  margin-top: 10px;
}

.empty-sub {
  font-size: var(--fs-meta);
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
  font-size: var(--fs-meta);
  color: var(--text-body);
}

.group-count {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.group-dot {
  width: 7px;
  min-width: 7px;
  height: 7px;
  border-radius: var(--rp);
  background: var(--amber);
  animation: sbPulse 1.8s var(--ease) infinite;
  flex-shrink: 0;
}

.approve-all-warn {
  font-size: var(--fs-micro);
  color: var(--amber);
}

.link-armed,
.link-quiet {
  font-family: var(--sans);
  font-size: var(--fs-micro);
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
}

.link-green {
  font-family: var(--sans);
}

.link-armed {
  color: var(--amber);
  font-weight: var(--w-em);
}

.link-quiet {
  color: var(--text-faint);
}

.link-armed:hover,
.link-quiet:hover {
  text-decoration: underline;
}

.item {
  background: var(--bg-hover);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
  padding: var(--pad-card);
  margin-bottom: 8px;
  animation: sbIn 0.25s var(--ease);
  box-shadow: var(--elev);
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
  font-size: var(--fs-micro);
  color: var(--detail);
  border: 1px solid var(--surface-inset-line);
  border-radius: var(--rc);
  padding: 1px 7px;
  white-space: nowrap;
}

.item-title {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-title);
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.item-explain-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-family: var(--sans);
  font-size: var(--fs-micro);
  color: var(--text-faint);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
}

.item-explain-toggle:hover,
.item-explain-toggle:hover .hist-arrow {
  color: var(--text-mid);
}

.item-explain {
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-mid);
  margin-top: 6px;
  text-wrap: pretty;
  overflow-wrap: anywhere;
}

.detail-box {
  color: var(--detail);
  background: color-mix(in srgb, var(--bg) 50%, transparent);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: var(--rc);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

html.sb-light .detail-box {
  background: var(--bg-code);
  border-color: var(--border-code);
}

.item-detail {
  font-size: var(--fs-meta);
  padding: 6px 9px;
  margin-top: 8px;
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

.item-standing {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 0;
  background: transparent;
  border: none;
  font-family: var(--sans);
  font-size: var(--fs-meta);
  color: var(--text-mid);
  cursor: pointer;
  text-align: left;
}

.item-standing:hover {
  color: var(--green);
}

.item-head .chip-risk {
  border-radius: var(--rc);
  padding: 1px 7px;
}

.item-actions .btn-solid,
.item-actions .btn-armed,
.item-actions .btn-outline {
  font-family: var(--sans);
  transition: transform 0.13s var(--ease);
}

.item-actions .btn-solid:hover,
.item-actions .btn-armed:hover,
.item-actions .btn-outline:hover {
  transform: translateY(-1px);
}

.item-actions .btn-solid:active,
.item-actions .btn-armed:active,
.item-actions .btn-outline:active {
  transform: scale(0.975);
}

.item-ago {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.hist-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px 10px;
  border-bottom: 1px solid var(--border);
}

.hist-count {
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  color: var(--text-faint);
}

.hist-clear {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-micro);
  color: var(--text-body);
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 4px 11px;
  user-select: none;
}

.hist-clear-x {
  color: var(--text-faint);
}

.hist-clear:hover {
  color: var(--text-strong);
  border-color: color-mix(in srgb, var(--red) 60%, transparent);
  background: color-mix(in srgb, var(--red) 10%, transparent);
}

.hist-empty {
  padding: 36px 16px;
  text-align: center;
  font-size: var(--fs-meta);
  line-height: 1.6;
  color: var(--text-faint);
}

.hctx-menu {
  position: fixed;
  min-width: 240px;
  max-width: 330px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  box-shadow: var(--shadow-menu);
  padding: 4px;
}

.hctx-detail {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-faint);
  padding: 6px 9px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hctx-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  text-align: left;
  font-size: var(--fs-meta);
  color: var(--text-body);
  padding: 7px 9px;
}

.hctx-item:hover {
  background: var(--bg-card);
}

.hctx-item.danger:hover {
  color: var(--red);
}

.hctx-base {
  color: var(--green);
}

.hist-row {
  padding: 9px 2px;
  border-bottom: 1px solid var(--border-hist);
  cursor: pointer;
}

.hist-head {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 0 -4px;
  padding: 0 4px;
  border-radius: var(--rc);
}

.hist-row:hover .hist-head {
  background: var(--bg-panel-2);
}

.hist-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tab);
  width: 14px;
  min-width: 14px;
  height: 16px;
  border: 1px solid var(--border-card);
  border-radius: var(--rp);
  transition: transform 0.12s var(--ease);
}

.hist-arrow.open {
  transform: rotate(90deg);
}

.hist-row:hover .hist-arrow {
  color: var(--text-mid);
}

.hist-mark {
  width: 14px;
  min-width: 14px;
}

.hist-main {
  flex: 1;
  min-width: 0;
}

.hist-title {
  font-size: var(--fs-ui);
  color: var(--text-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hist-detail {
  margin: 8px 0 3px 48px;
}

.hd-explain {
  font-size: var(--fs-ui);
  line-height: 1.55;
  color: var(--text-mid);
  margin-bottom: 6px;
  text-wrap: pretty;
}

.hd-detail {
  font-size: var(--fs-micro);
  padding: 5px 9px;
  margin: 0;
  max-height: 200px;
  overflow: auto;
}

.hist-sub {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.hist-ago {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
}
</style>
