<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import type { QuestionPayload, Session, SessionEvent } from '@shared/domain'
import type { ActiveAgent } from '@shared/agents'
import type { RawLine } from '@shared/stream-lines'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useElicitationsStore } from '@renderer/stores/elicitations'
import StreamEvent from '@renderer/components/StreamEvent.vue'
import ElicitationCard from '@renderer/components/ElicitationCard.vue'
import SwallowedBlock from '@renderer/components/SwallowedBlock.vue'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import Icon from '@renderer/components/Icon.vue'

export type StreamItem =
  | { type: 'event'; event: SessionEvent }
  | { type: 'block'; noiseKind: string; events: SessionEvent[]; key: string }

const props = defineProps<{
  project: ProjectListItem
  liveSession: Session | null
  endedSession: Session | null
  selectedAgent: ActiveAgent | null
  workingAgents: ActiveAgent[]
  backgroundTasks: { taskId: string; description: string }[]
  items: StreamItem[]
  canShowEarlier: boolean
  inlineQuestion: { eventId: string; payload: QuestionPayload } | null
  rawLines: RawLine[]
  stamps: boolean
  zoom: string
}>()
const emit = defineEmits<{
  (e: 'show-earlier'): void
  (e: 'inline-answer', eventId: string, choice: string): void
  (e: 'edit-queued', eventId: string, text: string): void
  (e: 'scroll'): void
}>()

const agentsExpanded = defineModel<boolean>('agentsExpanded', { required: true })
const tasksExpanded = defineModel<boolean>('tasksExpanded', { required: true })

const active = useActiveSessionStore()
const inbox = useInboxStore()
const elicitations = useElicitationsStore()

const SHOW_LIMIT = 6
const shownAgents = computed(() =>
  agentsExpanded.value ? props.workingAgents : props.workingAgents.slice(0, SHOW_LIMIT),
)
const shownTasks = computed(() =>
  tasksExpanded.value ? props.backgroundTasks : props.backgroundTasks.slice(0, SHOW_LIMIT),
)

const pendingCount = computed(
  () => inbox.pending.filter((p) => p.projectId === props.project.id).length,
)

const streamEl = useTemplateRef<HTMLElement>('streamEl')
defineExpose({ el: streamEl })

function answerQuestion(eventId: string, choice: string): void {
  void active.answerQuestion(eventId, choice)
}

function openInbox(requestId: string): void {
  inbox.focusRequest(requestId)
}
</script>

<template>
  <div
    v-if="active.view === 'clean' || selectedAgent"
    ref="streamEl"
    class="stream"
    data-testid="stream"
    :style="{ zoom }"
    @scroll.passive="emit('scroll')"
  >
    <div class="stream-inner">
      <div v-if="selectedAgent" class="agent-banner" data-testid="agent-banner">
        <button
          type="button"
          class="ab-back"
          data-testid="agent-back"
          :aria-label="`Back to ${project.name}`"
          @click="active.selectAgent(null)"
        >
          <Icon name="arrow-left" :size="12" /> {{ project.name }}
        </button>
        <span class="ab-sep">│</span>
        <span class="ab-dot"><Icon name="dot" :size="8" /></span>
        <span class="ab-name">{{ selectedAgent.task || selectedAgent.name }}</span>
        <span class="ab-chip ui-chip">subagent</span>
        <span class="spacer"></span>
      </div>

      <div v-if="!liveSession && !endedSession" class="stream-empty">
        <div class="faint" data-testid="no-session-hint">
          No session yet — press + in the sidebar and point New session at this folder.
        </div>
      </div>

      <slot />

      <button
        v-if="canShowEarlier"
        type="button"
        class="load-earlier"
        data-testid="show-earlier"
        @click="emit('show-earlier')"
      >
        <Icon name="chevron-up" :size="11" /> show earlier activity
      </button>

      <template
        v-for="item in items"
        :key="item.type === 'event' ? item.event.id : item.key"
      >
        <SwallowedBlock
          v-if="item.type === 'block'"
          :events="item.events"
          :noise-kind="item.noiseKind"
          @open-raw="active.setView('raw')"
        />
        <QuestionEvent
          v-else-if="item.event.kind === 'question'"
          :event-id="item.event.id"
          :payload="item.event.payload as never"
          @answer="answerQuestion"
        />
        <StreamEvent
          v-else
          :event="item.event"
          :stamps="stamps"
          @open-inbox="openInbox"
          @edit-queued="(eventId, text) => emit('edit-queued', eventId, text)"
        />
      </template>

      <ElicitationCard v-for="ask in elicitations.forSession(liveSession?.id)" :key="ask.id" :item="ask" />

      <QuestionEvent
        v-if="inlineQuestion"
        :event-id="inlineQuestion.eventId"
        :payload="inlineQuestion.payload"
        data-testid="inline-question"
        @answer="(eventId, choice) => emit('inline-answer', eventId, choice)"
      />

      <div v-if="selectedAgent" class="live" data-testid="live-line">
        <span class="blink" style="color: var(--green)">▊</span>
        {{ selectedAgent.task || selectedAgent.label }}
      </div>

      <div v-else-if="workingAgents.length > 1" class="agents ui-card is-warn" data-testid="agent-list">
        <div class="agents-head">
          <span class="agents-label"><Icon name="fork" :size="12" /> AGENTS</span>
          <span class="agents-count">{{ workingAgents.length }} working in parallel</span>
          <span class="spacer"></span>
          <button
            v-if="workingAgents.length > SHOW_LIMIT"
            class="agents-toggle"
            data-testid="agents-toggle"
            @click="agentsExpanded = !agentsExpanded"
          >
            {{ agentsExpanded ? 'show fewer' : `show all ${workingAgents.length}` }}
          </button>
        </div>
        <div class="agents-rows">
          <button
            v-for="agent in shownAgents"
            :key="agent.id"
            type="button"
            class="agent-row ui-row"
            data-testid="agent-row"
            :aria-label="`Open ${agent.name}'s chat`"
            @click="active.selectAgent(agent.id)"
          >
            <span class="agent-dot"><Icon name="dot" :size="8" /></span>
            <span class="agent-name">{{ agent.name }}</span>
            <span class="agent-task">{{ agent.task || agent.label }}</span>
            <span class="agent-chat">chat <Icon name="arrow-right" :size="11" /></span>
          </button>
          <div
            v-if="!agentsExpanded && workingAgents.length > SHOW_LIMIT"
            class="agents-more"
            data-testid="agents-more"
            role="button"
            tabindex="0"
            @click="agentsExpanded = true"
            @keydown.enter="agentsExpanded = true"
            @keydown.space.prevent="agentsExpanded = true"
          >
            <Icon name="plus" :size="11" /> {{ workingAgents.length - SHOW_LIMIT }} more
          </div>
        </div>
      </div>

      <div
        v-else-if="liveSession?.status === 'working'"
        class="live"
        data-testid="live-line"
        role="status"
      >
        <span class="blink" style="color: var(--green)" aria-hidden="true">▊</span>
        {{ liveSession.statusDetail || 'Working…' }}
      </div>
      <div
        v-else-if="liveSession?.status === 'needs_you'"
        class="live live-blocked"
        data-testid="live-line"
        role="alert"
      >
        <span class="blink" aria-hidden="true">▊</span>
        Blocked — {{ pendingCount > 0 ? `${pendingCount} pending` : 'needs your answer' }}
      </div>

      <div
        v-if="backgroundTasks.length > 0"
        class="agents bg-tasks ui-card is-danger"
        data-testid="bg-task-list"
      >
        <div class="agents-head">
          <span class="agents-label bg"><Icon name="clock" :size="12" /> BACKGROUND</span>
          <span class="agents-count">{{ backgroundTasks.length }} running</span>
          <span class="spacer"></span>
          <button
            v-if="backgroundTasks.length > SHOW_LIMIT"
            class="agents-toggle"
            data-testid="bg-task-toggle"
            @click="tasksExpanded = !tasksExpanded"
          >
            {{ tasksExpanded ? 'show fewer' : `show all ${backgroundTasks.length}` }}
          </button>
          <button
            class="agents-toggle"
            data-testid="bg-task-clear"
            title="Forget these tasks. Use it when the work has clearly finished but the session still lists it: the session can then finish, and its planned queue can run. Work that is genuinely running reappears the moment the CLI next reports."
            @click="active.clearBackgroundTasks()"
          >
            clear
          </button>
        </div>
        <div class="agents-rows">
          <div
            v-for="task in shownTasks"
            :key="task.taskId"
            class="agent-row bg-row ui-row"
            data-testid="bg-task-row"
          >
            <span class="agent-dot bg"><Icon name="clock" :size="8" /></span>
            <span class="agent-task">{{ task.description || task.taskId }}</span>
          </div>
          <div
            v-if="!tasksExpanded && backgroundTasks.length > SHOW_LIMIT"
            class="agents-more"
            data-testid="bg-task-more"
            role="button"
            tabindex="0"
            @click="tasksExpanded = true"
            @keydown.enter="tasksExpanded = true"
            @keydown.space.prevent="tasksExpanded = true"
          >
            <Icon name="plus" :size="11" /> {{ backgroundTasks.length - SHOW_LIMIT }} more
          </div>
        </div>
      </div>
    </div>
  </div>

  <div
    v-else
    ref="streamEl"
    class="raw-view"
    data-testid="stream"
    :style="{ zoom }"
    @scroll.passive="emit('scroll')"
  >
    <div
      v-for="line in rawLines"
      :key="line.key"
      class="raw-line mono"
      :class="[`t-${line.tone}`, { stamped: stamps }]"
      data-testid="raw-line"
    >
      <span v-if="stamps" class="raw-stamp" data-testid="raw-stamp">{{ line.stamp }}</span>
      <span>{{ line.text }}</span>
    </div>
    <div v-if="liveSession?.status === 'working'" class="raw-line mono term-caret" data-testid="term-caret">
      <span class="blink">█</span>
    </div>
  </div>
</template>

<style scoped>
.session-view.is-ended .raw-view {
  opacity: 0.7;
  filter: saturate(0.4);
}

.session-view.is-ended .stream-inner > *:not(.ended):not(.load-earlier) {
  opacity: 0.7;
}

.session-view.is-ended .stream-inner:hover > *:not(.ended),
.session-view.is-ended .stream-inner:focus-within > *:not(.ended) {
  opacity: 1;
}

.session-view.is-ended
  .stream-inner:not(:hover):not(:focus-within)
  > *:not(.ended):not(.load-earlier) {
  --green: var(--text-mid);
  --green-hover: var(--text-strong);
  --green2: var(--text-mid);
  --running: var(--text-mid);
  --amber: var(--text-meta);
  --amber-hover: var(--text-mid);
  --idle: var(--text-meta);
  --blue: var(--text-meta);
  --red: var(--text-mid);
  --red-hover: var(--text-strong);
  --teal: var(--text-meta);
  --purple: var(--text-meta);
}

.stream-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 80px;
}

.load-earlier {
  display: block;
  width: 100%;
  font-size: var(--fs-meta);
  color: var(--text-faint);
  cursor: pointer;
  text-align: center;
  margin-bottom: 12px;
}

.load-earlier:hover {
  color: var(--text-mid);
}

.agent-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--surface-inset) 55%, transparent);
  border: 1px solid var(--surface-inset-line);
  flex-wrap: wrap;
}

.ab-back {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.ab-back:hover {
  color: var(--text-strong);
}

.ab-sep {
  color: var(--border-seg);
}

.ab-dot {
  font-size: var(--fs-meta);
  color: var(--blue);
  animation: sbFade 1.6s var(--ease) infinite;
}

.ab-name {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-strong);
}

.ab-chip {
  white-space: nowrap;
}

.agents {
  margin-top: 6px;
}

.agents-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}

.agents-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--blue);
}

.agents-count {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.agents-toggle {
  font-size: var(--fs-micro);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 1px 9px;
  background: transparent;
  cursor: pointer;
}

.agents-toggle:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.agents-more {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  cursor: pointer;
  padding: 3px 6px;
}

.agents-more:hover {
  color: var(--green);
}

.bg-tasks {
  margin-top: 8px;
}

.agents-label.bg {
  color: var(--amber);
}

.agent-dot.bg {
  color: var(--amber);
  animation: sbFade 1.6s var(--ease) infinite;
}

.agents-rows {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.agent-row {
  margin: 0 -6px;
}

.agent-row:hover {
  box-shadow: var(--elev);
}

.agent-chat {
  font-size: var(--fs-micro);
  color: var(--green);
  white-space: nowrap;
}

.agent-dot {
  font-size: var(--fs-meta);
  color: var(--blue);
  animation: sbFade 1.6s var(--ease) infinite;
}

.agent-name {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-body);
  white-space: nowrap;
}

.agent-task {
  flex: 1;
  font-size: var(--fs-ui);
  color: var(--text-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.live-blocked {
  color: var(--amber);
}

.raw-view {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 52px;
  background: var(--bg-code);
}

.raw-line {
  font-family: var(--mono);
  font-size: var(--fs-meta);
  line-height: 1.65;
  color: var(--text-mid);
  white-space: pre-wrap;
  word-break: break-word;
}

.raw-line.t-prompt {
  color: var(--text-bright);
  font-weight: var(--w-em);
}

.raw-line.t-text {
  color: var(--text-body);
}

.raw-line.t-tool {
  color: var(--teal);
}

.raw-line.t-result {
  color: var(--text-ghost);
}

.raw-line.t-ok {
  color: var(--green);
}

.raw-line.t-warn {
  color: var(--amber);
}

.raw-line.t-err {
  color: var(--red);
}

.raw-line.t-inject {
  color: var(--text-noise);
  border-left: 1px solid var(--border);
  padding-left: 9px;
  margin-left: 1px;
}

.term-caret {
  color: var(--green);
}

.raw-line.stamped {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 12px;
  align-items: baseline;
}

.raw-stamp {
  color: var(--text-ghost);
  white-space: nowrap;
}

.session-view.is-ended
  .stream-inner
  > *:not(.ended):not(.agent-banner):not(.load-earlier) {
  display: none;
}

.session-view.is-ended .stream-inner {
  margin-top: auto;
  margin-bottom: auto;
}

.session-view.is-ended .load-earlier {
  max-width: var(--end-card-w);
  margin-inline: auto;
}
</style>
