<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { Session } from '@shared/domain'
import { modelLabel } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { useFlowStore } from '@renderer/stores/flow'
import { formatTokens as fmtTok, useSessionUsage } from '@renderer/composables/useSessionUsage'
import { useNow } from '@renderer/composables/useNow'
import { elapsedClock } from '@renderer/relative-time'
import { accentFor } from '@renderer/project-accent'
import Icon from '@renderer/components/Icon.vue'
import EffortBar from '@renderer/components/EffortBar.vue'
import SessionWaitOverlay from '@renderer/components/SessionWaitOverlay.vue'

const props = defineProps<{
  project: ProjectListItem
  liveSession: Session | null
  endedSession: Session | null
  agentCount: number
  backgroundCount: number
  ending: boolean
}>()
const emit = defineEmits<{
  (e: 'open-flow'): void
  (e: 'end'): void
  (e: 'usage'): void
}>()

const projects = useProjectsStore()
const active = useActiveSessionStore()
const settingsStore = useSettingsStore()
const flow = useFlowStore()

const headerColor = computed(() => accentFor(props.project.id))

const flowActiveCount = computed(
  () => flow.runsFor(props.project.id).filter((r) => r.status === 'running' || r.status === 'waiting').length,
)

const PILL_LABELS: Record<string, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  done: 'Done',
  error: 'Error',
}
function pillLabel(status: string): string {
  return PILL_LABELS[status] ?? status
}

const now = useNow(1000)

const sessionTimer = computed(() =>
  props.liveSession ? elapsedClock(props.liveSession.startedAt, now.value) : null,
)

const showTimer = computed(() => settingsStore.settings?.showSessionTimer ?? true)

const sessionStamp = computed(() => {
  const id = props.liveSession?.id ?? props.endedSession?.id ?? null
  return id ? { short: id.slice(0, 8), full: id } : null
})

const { cacheHitPct, cacheColor, sessionUsage, currentModelLabel } = useSessionUsage(
  computed(() => props.liveSession),
)

const nameDraft = ref<string | null>(null)
const nameInputEl = ref<HTMLInputElement | null>(null)

function openNameEdit(): void {
  const target = props.liveSession ?? props.endedSession
  if (!target) return
  nameDraft.value = target.label ?? ''
  void nextTick(() => nameInputEl.value?.select())
}

function saveName(): void {
  const draft = nameDraft.value
  const target = props.liveSession ?? props.endedSession
  nameDraft.value = null
  if (draft === null || !target || draft.trim() === (target.label ?? '')) return
  void projects.renameSession(target.id, draft)
}

function startAnother(): void {
  void projects.startSession(props.project.id)
}

function onContainersToggle(e: Event): void {
  void projects.setUseContainers(props.project.id, (e.target as HTMLInputElement).checked)
}
</script>

<template>
  <header class="head">
    <div class="head-row">
      <div class="ident ui-chip">
        <span class="h-dot" :style="{ background: headerColor }"></span>
        <span class="h-name" data-testid="session-project-name">{{ project.name }}</span>
        <span class="h-path code" data-testid="session-project-path">{{ project.path }}</span>
      </div>
      <span class="spacer"></span>
      <span
        v-if="liveSession?.bypassPermissions"
        class="pill bypass-pill"
        data-testid="bypass-pill"
        title="Started with --dangerously-skip-permissions"
      >
        <Icon name="warning" :size="12" /> Bypass
      </span>
      <button
        v-if="liveSession && !liveSession.bypassPermissions"
        class="pill plan-pill"
        :class="{ on: liveSession.inPlanMode }"
        data-testid="plan-mode-toggle"
        role="switch"
        :aria-checked="!!liveSession.inPlanMode"
        :title="
          liveSession.inPlanMode
            ? 'Read-only until a plan is approved. Click to leave plan mode; it applies from the next tool call.'
            : 'Switch to planning: read-only until a plan is approved. It applies from the next tool call.'
        "
        @click="active.setPlanMode(!liveSession.inPlanMode)"
      >
        <Icon name="panel" :size="12" /> {{ liveSession.inPlanMode ? 'Planning' : 'Plan' }}
      </button>
      <template v-if="settingsStore.settings">
        <EffortBar
          :model-value="settingsStore.settings.effort"
          label="Effort"
          icon="spark"
          testid="effort-bar"
          title="Reasoning effort for the main loop. Applies from the next message, to every session. Subagents exist only at max."
          @update:model-value="(effort) => settingsStore.save({ effort })"
        />
        <EffortBar
          v-if="settingsStore.settings.effort === 'max'"
          :model-value="settingsStore.settings.subagentEffort"
          label="Subagents"
          icon="fork"
          testid="subagent-effort-bar"
          title="Reasoning effort for the subagents a session creates. Max also switches on divide and conquer. Read at session start."
          @update:model-value="(subagentEffort) => settingsStore.save({ subagentEffort })"
        />
      </template>
      <span
        v-if="liveSession?.bypassPermissions && project.gitNotice"
        class="pill nogit-pill"
        data-testid="nogit-pill"
        :title="project.gitNotice"
      >
        <Icon name="warning" :size="12" /> No git
      </span>
      <span
        v-if="liveSession?.heavySubagents"
        class="pill fanout-pill"
        data-testid="fanout-pill"
        title="Started with the subagent effort bar at max: this session is told to split work across as many subagents as it can. Moving the bar applies from the next session."
      >
        <Icon name="fork" :size="12" /> Fan-out
      </span>
      <span
        v-if="agentCount > 1"
        class="pill agents-pill"
        data-testid="agents-pill"
      >
        <Icon name="fork" :size="12" /> {{ agentCount }} agents
      </span>
      <span
        v-if="backgroundCount > 0"
        class="pill bg-pill"
        data-testid="bg-pill"
        title="Background tasks running"
      >
        <Icon name="clock" :size="12" /> {{ backgroundCount }} background
      </span>
      <span
        v-if="liveSession"
        class="pill"
        :class="liveSession.status"
        data-testid="session-pill"
      >
        {{ pillLabel(liveSession.status) }}
      </span>
      <span v-else-if="endedSession" class="pill ended">Ended</span>

      <button
        class="ctl"
        data-testid="new-session"
        title="Start another session in this project, on its own defaults"
        :disabled="projects.starting"
        @click="startAnother()"
      >
        + Session
      </button>
      <button
        class="ctl"
        data-testid="open-flow"
        title="Take a feature from spec to shipped pull request"
        @click="emit('open-flow')"
      >
        Flow
        <span v-if="flowActiveCount > 0" class="mt-badge" data-testid="flow-badge">{{ flowActiveCount }}</span>
      </button>
      <button
        v-if="liveSession?.status === 'working'"
        class="stop-btn"
        data-testid="stop-session"
        aria-label="Interrupt the current turn"
        title="Interrupt the current turn (Ctrl+C)"
        @click="active.interrupt()"
      >
        <span class="stop-block" aria-hidden="true"></span>
      </button>
      <button
        v-if="liveSession"
        class="ctl"
        data-testid="end-session"
        title="End the session (resumable later)"
        :disabled="ending"
        @click="emit('end')"
      >
        {{ ending ? 'Ending…' : 'End session' }}
      </button>
      <SessionWaitOverlay
        v-if="ending"
        testid="ending-overlay"
        :title="`Ending ${project.name}…`"
        :sub="
          liveSession?.bypassPermissions || project.useContainers
            ? 'Draining the session and tearing its container down.'
            : 'Draining the session.'
        "
        ring-testid="ending-bar"
      />
    </div>
    <div class="head-meta">
      <div class="name-block ui-chip">
        <span class="name-cap" aria-hidden="true">session</span>
        <input
          v-if="nameDraft !== null"
          ref="nameInputEl"
          v-model="nameDraft"
          class="name-input"
          data-testid="session-name-input"
          maxlength="60"
          placeholder="Name this session"
          @keydown.enter="saveName()"
          @keydown.esc="nameDraft = null"
          @blur="saveName()"
        />
        <button
          v-else-if="liveSession || endedSession"
          class="name-btn"
          data-testid="session-name"
          title="Name this session"
          @click="openNameEdit()"
        >
          {{ (liveSession ?? endedSession)?.name ?? 'Name this session' }}
        </button>
      </div>
      <div class="run-block ui-chip">
        <span class="run-cap" aria-hidden="true">run</span>
        <label class="wsl-check" data-testid="project-containers">
          <input
            type="checkbox"
            data-testid="project-containers-input"
            :checked="project.useContainers"
            :title="
              project.useContainers
                ? 'This project runs its work inside WSL containers: the project folder is mounted read-write, and your Claude credentials, plugins and skills read-only. Nothing else of yours is. Slower to start, and only two containers may run at once machine-wide.'
                : 'This project runs its work on this machine. Tick to run it inside WSL containers instead: isolated from the rest of your drive, slower to start, two at a time. Needs WSL 2.9.3 or newer.'
            "
            @change="onContainersToggle"
          />
          Run in Container
        </label>
      </div>
      <span style="white-space: nowrap"><Icon name="branch" :size="12" /> <span class="mono">{{ liveSession?.branch ?? endedSession?.branch ?? '—' }}</span></span>
      <span
        v-if="currentModelLabel"
        data-testid="session-model"
        style="color: var(--text-faint); white-space: nowrap"
      >
        {{ currentModelLabel }}
      </span>
      <span
        v-if="liveSession?.jevRoute"
        class="ui-chip jev-chip"
        :class="{ switched: liveSession.jevRoute.switched }"
        data-testid="session-jev-chip"
        :title="liveSession.jevRoute.note"
        :aria-label="liveSession.jevRoute.note"
      >
        <Icon :name="liveSession.jevRoute.switched ? 'swap' : 'spark'" :size="12" />
        Jev · {{ modelLabel(liveSession.jevRoute.model) }}{{ liveSession.jevRoute.switched ? ' · switched' : '' }}
      </span>
      <span
        v-if="liveSession?.currentMode"
        class="ui-chip"
        data-testid="session-mode"
        :title="
          liveSession.currentMode === 'advisor'
            ? 'Advisor mode: cheap model executing, strong model consulted at decision points'
            : 'Orchestrator mode: strong model planning, cheap workers executing in parallel'
        "
      >
        <Icon :name="liveSession.currentMode === 'advisor' ? 'scales' : 'layers'" :size="12" />
        {{ liveSession.currentMode === 'advisor' ? 'Advisor' : 'Orchestrator' }}
      </span>
      <span
        v-if="liveSession && liveSession.diffAdds != null"
        data-testid="diff-stats"
        class="mono"
        style="white-space: nowrap"
      >
        <span style="color: var(--green)">+{{ liveSession.diffAdds }}</span>
        <span style="color: var(--red)"> −{{ liveSession.diffDels ?? 0 }}</span>
      </span>
      <span
        v-if="sessionTimer && showTimer"
        style="color: var(--text-faint); white-space: nowrap"
      >
        session <span class="mono" style="color: var(--text-meta)">{{ sessionTimer }}</span>
      </span>
      <span
        v-if="cacheHitPct != null"
        data-testid="session-cache"
        style="color: var(--text-faint); white-space: nowrap"
        title="Prompt-cache hit rate for the latest turn (cached prefix reused vs. re-billed)"
      >
        cache
        <span class="mono" :style="{ color: cacheColor }">{{ cacheHitPct }}%</span>
      </span>
      <button
        v-if="sessionUsage"
        class="usage-widget ui-chip"
        data-testid="session-model-usage"
        title="Session usage by model — click for the full /usage picture"
        @click="emit('usage')"
      >
        <span class="uw-total">{{ fmtTok(sessionUsage.total) }} tok</span>
        <span v-if="sessionUsage.cost > 0" class="uw-cost">${{ sessionUsage.cost.toFixed(2) }}</span>
        <span v-for="m in sessionUsage.top" :key="m.id" class="uw-model">
          {{ m.label }} <span class="uw-model-tok">{{ fmtTok(m.tokens) }}</span>
        </span>
      </button>
      <span
        v-if="sessionStamp"
        class="head-stamp"
        data-testid="session-stamp"
        :title="sessionStamp.full"
      >
        #{{ sessionStamp.short }}
      </span>
    </div>
  </header>
</template>

<style scoped>
.head {
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  box-shadow: var(--hairline-shine);
}

.mt-badge {
  font-size: var(--fs-micro);
  color: var(--text-meta);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  border-radius: var(--rp);
  padding: 0 6px;
  line-height: 15px;
}

.head-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.h-dot {
  width: 10px;
  min-width: 10px;
  height: 10px;
}

.h-name {
  font-size: var(--fs-head);
  font-weight: var(--w-em);
  color: var(--text-bright);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.h-path {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex-shrink: 6;
}

.ctl {
  flex-shrink: 0;
  font-size: var(--fs-ui);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 3px 9px;
}

.ctl:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.ctl:disabled {
  opacity: 0.7;
  cursor: default;
}

.name-btn {
  font-family: var(--sans);
  font-size: var(--fs-meta);
  color: var(--text-body);
  border-bottom: 1px dashed transparent;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.name-btn:hover {
  color: var(--text-strong);
  border-bottom-color: var(--border-strong);
}

.name-input {
  font-family: var(--sans);
  font-size: var(--fs-meta);
  color: var(--text-strong);
  background: var(--bg-panel);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 1px 6px;
  width: 220px;
}

.name-input:focus {
  outline: none;
  border-color: var(--blue);
}

.stop-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--red);
  border: 1px solid var(--red);
  border-radius: var(--rp);
  cursor: pointer;
}

.stop-btn:hover {
  color: var(--red-ink);
  background: var(--red);
}

.stop-block {
  width: 9px;
  height: 9px;
  background: currentColor;
}

.pill.fanout-pill {
  color: var(--purple);
  border: 1px solid color-mix(in srgb, var(--purple) 30%, transparent);
  background: color-mix(in srgb, var(--purple) 10%, transparent);
}

.pill.agents-pill {
  color: var(--blue);
  border: 1px solid color-mix(in srgb, var(--blue) 30%, transparent);
}

.pill.bg-pill {
  color: var(--amber);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
}

.pill.bypass-pill {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
}

.pill.nogit-pill {
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
}

.pill.plan-pill {
  cursor: pointer;
  color: var(--text-tab);
  border: 1px solid var(--border-strong);
}

.pill.plan-pill:hover {
  color: var(--text-strong);
}

.pill.plan-pill.on {
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 9%, transparent);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
}

.jev-chip.switched {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 40%, transparent);
  background: color-mix(in srgb, var(--blue) 9%, transparent);
}

.head-meta {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  margin-top: 7px;
  font-size: var(--fs-meta);
  color: var(--text-meta);
  flex-wrap: wrap;
}

.head-stamp {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  white-space: nowrap;
}

.usage-widget {
  gap: 9px;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.uw-total {
  color: var(--text-body);
  font-weight: var(--w-em);
  font-family: var(--mono);
}

.uw-cost {
  color: var(--text-faint);
  font-family: var(--mono);
}

.uw-model {
  color: var(--text-tab);
}

.uw-model-tok {
  color: var(--green);
  font-family: var(--mono);
}

.ident {
  min-width: 0;
}

.ident .h-dot {
  border-radius: var(--rp);
}

.name-block,
.run-block {
  min-width: 0;
}

.run-block {
  order: 9;
  margin-left: auto;
}

.wsl-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-ui);
  color: var(--text-tab);
  cursor: pointer;
  user-select: none;
}

.wsl-check:hover {
  color: var(--text-strong);
}

.wsl-check input {
  accent-color: var(--green);
  cursor: pointer;
  margin: 0;
}

.wsl-check:has(input:checked) {
  color: var(--green);
}

.name-cap,
.run-cap {
  flex: none;
  margin-right: 7px;
  font-family: var(--sans);
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-ghost);
}
</style>
