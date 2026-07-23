<script setup lang="ts">
// Central inbox panel — 1:1 with the design reference: inbox/history tabs with
// amber count badge, per-project groups (status dot, name, "N pending",
// "approve all"), item cards with risk chip / explanation / detail box /
// approve+deny, and the history list of ✓/✗ rows (FR-007..013, SC-004).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isDangerousCommand, type DecisionRecord, type PermissionRequest } from '@shared/domain'
import { useInboxStore } from '@renderer/stores/inbox'
import { useProjectsStore } from '@renderer/stores/projects'

const RISK_LABEL: Record<'low' | 'medium' | 'high', string> = { low: 'Low', medium: 'Medium', high: 'High' }

const inbox = useInboxStore()
const projects = useProjectsStore()
const emit = defineEmits<{ (e: 'collapse'): void }>()

const tab = ref<'inbox' | 'history'>('inbox')
const confirmingId = ref<string | null>(null)
// Separate confirm state for the broad "Always allow <tool>" grant so it never
// gets conflated with the one-time high-risk Approve confirm.
const alwaysConfirmId = ref<string | null>(null)
const expandedHistory = ref(new Set<string>())

function toggleHistory(id: string): void {
  // Vue 3 tracks mutations on a reactive Set, so toggle in place — no clone.
  const set = expandedHistory.value
  if (set.has(id)) set.delete(id)
  else set.add(id)
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

// Covered bases are needed on BOTH tabs now: history for the right-click menu,
// inbox for the "Always allow similar" button. Reload whenever the pending
// project set changes; the history tab additionally reloads on switch.
watch(
  () => inbox.groups.map((g) => g.projectId).join(','),
  () => void loadCoveredBases(),
  { immediate: true },
)
watch(tab, async (value) => {
  if (value === 'history') {
    await inbox.loadHistory()
    await loadCoveredBases()
  }
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

/** An MCP server tool, e.g. `mcp__oracle-sqlcl__sql_run`. */
function isMcpItem(item: PermissionRequest): boolean {
  return item.toolName?.startsWith('mcp__') ?? false
}

/** `mcp__oracle-sqlcl__sql_run` → `sql_run` for a compact button label. */
function toolShortName(item: PermissionRequest): string {
  const name = item.toolName ?? ''
  const parts = name.split('__')
  return parts.length >= 3 ? parts.slice(2).join('__') : name
}

// --- History right-click menu (design: always allow a command from history) ---
const histCtx = ref<{
  id: string
  detail: string
  allowBase: string | null
  x: number
  y: number
} | null>(null)

/**
 * Flag-aware two-token base command — mirrors the server-side matcher
 * derivation (`deriveMatcher`); display only, the broker re-derives it.
 */
function baseCmd(detail: string): string {
  const words = detail.trim().split(/\s+/)
  return words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : (words[0] ?? '')
}

// Bash command-prefixes already always-allowed, per project — loaded when the
// history tab opens so the menu can hide "Always allow" for covered commands.
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

/** A command is already covered when an active rule prefix matches its base. */
function alreadyAllowed(projectId: string, base: string): boolean {
  return (coveredBases.value[projectId] ?? []).some(
    (v) => base === v || base.startsWith(`${v} `),
  )
}

/**
 * Whether to offer an "Always allow" button on a pending item.
 * - MCP tools: always — a pending item proves no tool_only rule covers it yet
 *   (one would have auto-approved it). The broad grant is gated by a confirm.
 * - Bash: same eligibility as the history menu, but never for high risk — one
 *   click must not both widen a rule and skip the high-risk confirm.
 */
function canAlwaysAllow(item: PermissionRequest): boolean {
  if (item.type !== 'tool_permission') return false
  if (isMcpItem(item)) return true
  if (item.toolName !== 'Bash' || item.risk === 'high') return false
  if (isDangerousCommand(item.detail)) return false
  return !alreadyAllowed(item.projectId, baseCmd(item.detail))
}

async function alwaysAllowSimilar(item: PermissionRequest): Promise<void> {
  // A broad MCP tool_only grant on a high-risk item (high by fail-safe) gets the
  // same deliberate two-step confirm as a high-risk Approve.
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

function openHistCtx(h: DecisionRecord, event: MouseEvent): void {
  // Any approved shell command can be always-allowed except the destructive set
  // — the risk classifier fails safe to `high` for ordinary unmatched commands,
  // so gating on risk would hide the option for most vetted commands. Hide it
  // too once an active standing rule already covers the command.
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
    // Clamped to the viewport so the menu never opens off-screen.
    x: Math.min(event.clientX, window.innerWidth - 345),
    y: Math.min(event.clientY, window.innerHeight - 130),
  }
}

async function allowFromHist(): Promise<void> {
  const ctx = histCtx.value
  histCtx.value = null
  if (ctx?.allowBase) {
    await inbox.alwaysAllow(ctx.id)
    await loadCoveredBases() // so re-opening the menu now hides the option
  }
}

async function removeHist(): Promise<void> {
  const ctx = histCtx.value
  histCtx.value = null
  if (ctx) await inbox.deleteHistory(ctx.id)
}

// Project group whose "Approve all" is awaiting the high-risk "are you sure".
const approveAllConfirmId = ref<string | null>(null)

function groupHighRiskCount(items: PermissionRequest[]): number {
  return items.filter((i) => i.risk === 'high' && i.type === 'tool_permission').length
}

async function approveAll(group: { projectId: string; items: PermissionRequest[] }): Promise<void> {
  const highRisk = groupHighRiskCount(group.items)
  // Groups with high-risk items get one "are you sure" before bulk approval
  // sweeps them in; safe-only groups approve straight away as before.
  if (highRisk > 0 && approveAllConfirmId.value !== group.projectId) {
    approveAllConfirmId.value = group.projectId
    return
  }
  approveAllConfirmId.value = null
  await inbox.approveAllForProject(group.projectId, highRisk > 0)
}

const historyItems = computed(() => inbox.history)
</script>

<template>
  <aside class="inbox" data-testid="inbox-view">
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
      <span style="flex: 1"></span>
      <button
        class="inbox-collapse"
        data-testid="inbox-collapse"
        title="Collapse the inbox"
        @click="emit('collapse')"
      >
        ›
      </button>
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
          <span class="group-dot"></span>
          <span class="group-name mono">{{ projectName(group.projectId) }}</span>
          <span class="group-count mono">· {{ group.items.length }} pending</span>
          <span style="flex: 1"></span>
          <template v-if="approveAllConfirmId === group.projectId">
            <span class="approve-all-warn mono" data-testid="approve-all-warn">
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
              {{ RISK_LABEL[item.risk] }}
            </span>
          </div>
          <div class="item-explain">{{ item.explanation }}</div>
          <div class="item-detail detail-box mono" data-testid="item-detail">{{ item.detail }}</div>

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
              <button
                v-if="canAlwaysAllow(item)"
                class="btn-outline"
                data-testid="always-allow-btn"
                :title="
                  isMcpItem(item)
                    ? `Auto-approve every ${item.toolName} call in this project from now on`
                    : 'Creates a standing rule for this command and approves it now'
                "
                @click="alwaysAllowSimilar(item)"
              >
                {{ isMcpItem(item) ? `Always allow ${toolShortName(item)}` : 'Always allow similar' }}
              </button>
              <button class="btn-outline" data-testid="deny-btn" @click="deny(item)">Deny</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- History tab -->
    <div v-else class="body history">
      <div class="hist-header">
        <span class="hist-count mono" data-testid="history-count">
          DECISIONS · {{ historyItems.length }}
        </span>
        <span style="flex: 1"></span>
        <button
          v-if="historyItems.length > 0"
          class="hist-clear mono"
          data-testid="history-clear"
          @click="inbox.clearHistory()"
        >
          <span class="hist-clear-x">✕</span>Clear history
        </button>
      </div>
      <div v-if="historyItems.length === 0" class="hist-empty">
        History cleared.<br />New approvals and denials will land here.
      </div>
      <div
        v-for="h in historyItems"
        :key="h.id"
        class="hist-row"
        :class="{ open: expandedHistory.has(h.id) }"
        data-testid="history-item"
        title="Right-click for options"
        @click="toggleHistory(h.id)"
        @contextmenu.prevent="openHistCtx(h, $event)"
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
          <pre class="hd-detail detail-box mono">{{ h.detail }}</pre>
        </div>
      </div>
    </div>

    <!-- History right-click context menu. Teleported to <body> so its fixed
         overlay covers the viewport: the .inbox pane uses backdrop-filter, which
         would otherwise make it the containing block for position:fixed. -->
    <Teleport to="body">
      <div
        v-if="histCtx"
        class="hctx-overlay"
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
            <span style="color: var(--green)">✓</span>
            <span>Always allow <span class="hctx-base">{{ histCtx.allowBase }}</span> commands</span>
          </button>
          <button class="hctx-item mono danger" data-testid="hist-ctx-remove" @click="removeHist">
            <span>✕</span>
            <span>Remove this entry</span>
          </button>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.inbox {
  /* Width is user-resizable (App sets --inbox-w on the panes container). */
  width: var(--inbox-w, 332px);
  min-width: var(--inbox-w, 332px);
  background: var(--gloss), var(--bg-panel);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 0 8px;
}

/* Collapse chevron on the tab row's right edge. */
.inbox-collapse {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  line-height: 1;
  color: var(--text-faint);
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  background: transparent;
  cursor: pointer;
}

.inbox-collapse:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.tab {
  padding: 11px 12px;
  font-family: var(--sans);
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

.tab .badge-count {
  line-height: 15px;
}

.notice {
  margin: 10px 12px 0;
  padding: 8px 10px;
  border: 1px solid rgba(154, 111, 42, 0.4);
  border-radius: var(--rc);
  color: var(--amber);
  font-size: 10.5px;
  line-height: 1.5;
}

.notice-dismiss {
  display: block;
  margin-top: 5px;
  color: var(--amber);
  font-family: var(--sans);
  font-size: 10.5px;
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

/* Pulsing amber status dot before the project name (design: 7x7, var(--rc)
   radius — resolves to a full circle since --rc > half the box size). Kept
   local rather than reusing the shared .dot class, whose sizes/colors serve
   other views. */
.group-dot {
  width: 7px;
  min-width: 7px;
  height: 7px;
  border-radius: var(--rc);
  background: var(--amber);
  animation: sbPulse 1.8s ease infinite;
  flex-shrink: 0;
}

/* "Approve all" high-risk confirm row (mono links, matching .link-green). */
.approve-all-warn {
  font-size: 10px;
  color: var(--amber);
}

.link-armed,
.link-quiet {
  font-family: var(--sans);
  font-size: 10.5px;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
}

/* .link-green is a shared class (styles.css); scoped here so the override
   only reaches elements this component renders. Design uses the UI (sans)
   face for this control, not the shared class's mono default. */
.link-green {
  font-family: var(--sans);
}

.link-armed {
  color: var(--amber);
  font-weight: 600;
}

.link-quiet {
  color: var(--text-faint);
}

.link-armed:hover,
.link-quiet:hover {
  text-decoration: underline;
}

.item {
  /* Design fills this card from --bg-hover (not --bg-card) with a glass blur. */
  background: var(--gloss), var(--bg-hover);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
  padding: 11px 12px;
  margin-bottom: 8px;
  animation: sbIn 0.25s ease;
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
  font-size: 10px;
  color: var(--detail);
  border: 1px solid var(--surface-inset-line);
  border-radius: var(--rc);
  padding: 1px 7px;
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
  margin-top: 8px;
  text-wrap: pretty;
  overflow-wrap: anywhere;
}

/* Shared "glass detail box" chrome (item detail + history detail): a
   translucent near-black pane with a blur, matching the design's inline
   rgba(--rgb-8-11-24) fill. No app token covers this exact translucent value,
   so it's kept literal per the brief's "no token → match design exactly"
   rule, with an explicit light-theme swap. */
.detail-box {
  color: var(--detail);
  background: rgba(8, 11, 24, 0.5);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: var(--rc);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

html.sb-light .detail-box {
  background: rgba(236, 243, 251, 0.5);
  border-color: rgba(96, 125, 160, 0.07);
}

.item-detail {
  font-size: 11px;
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

/* Risk chips are a shared class (styles.css) whose radius/padding are still
   hardcoded there; scoped here so the fix reaches this file's usage without
   touching the shared stylesheet. */
.item-head .chip-risk {
  border-radius: var(--rc);
  padding: 1px 7px;
}

/* Design gives Approve / Confirm high-risk / Deny a sans face (the shared
   .btn-* classes default to mono) and a subtle press/lift on hover+active. */
.item-actions .btn-solid,
.item-actions .btn-armed,
.item-actions .btn-outline {
  font-family: var(--sans);
  transition: transform 0.13s cubic-bezier(0.2, 0.7, 0.3, 1);
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
  font-size: 10.5px;
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
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

/* Design renders "Clear history" as a chip button (glass fill, border,
   elevation), not a bare underlined link. */
.hist-clear {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-body);
  background: var(--gloss), var(--bg-hover);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
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
  border-color: rgba(143, 59, 44, 0.6);
  background: rgba(143, 59, 44, 0.1);
}

.hist-empty {
  padding: 36px 16px;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-faint);
}

.hctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
}

.hctx-menu {
  position: fixed;
  min-width: 240px;
  max-width: 330px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-menu);
  padding: 4px;
}

.hctx-detail {
  font-size: 10px;
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
  font-size: 11.5px;
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
  font-size: 10px;
  color: var(--text-tab);
  width: 14px;
  min-width: 14px;
  height: 16px;
  line-height: 14px;
  text-align: center;
  border: 1px solid var(--border-card);
  border-radius: 99px;
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
  min-width: 14px;
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
  margin: 8px 0 3px 48px;
}

.hd-explain {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-mid);
  margin-bottom: 6px;
  text-wrap: pretty;
}

.hd-detail {
  font-size: 10.5px;
  padding: 5px 9px;
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
