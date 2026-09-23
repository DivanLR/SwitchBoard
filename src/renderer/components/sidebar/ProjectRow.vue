<script setup lang="ts">
import { modelLabel, type Session } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { elapsedClock } from '@renderer/relative-time'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  item: ProjectListItem
  collapsed: boolean
  status: string
  live: boolean
  pending: number
  agents: { id: string; name: string; task: string }[]
  showPath: boolean
  showTimer: boolean
  now: number
  renaming: boolean
}>()
const emit = defineEmits<{
  (e: 'commit-rename'): void
  (e: 'cancel-rename'): void
  (e: 'new-session'): void
  (e: 'remove'): void
}>()

const renameVal = defineModel<string>('renameVal', { required: true })

const projects = useProjectsStore()
const activeSession = useActiveSessionStore()

function initials(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toLowerCase()
}

function timerOf(startedAt: string): string {
  return elapsedClock(startedAt, props.now)
}

function sessionStatus(session: Session): string {
  return session.endedAt ? 'ended' : session.status
}

function isExpanded(): boolean {
  return (
    props.item.id === projects.selectedProjectId || props.item.sessions.some((s) => !s.endedAt)
  )
}

function markTitle(status: string): string {
  if (status === 'needs_you') return 'Needs you'
  if (status === 'working') return 'Working'
  if (status === 'error') return 'Error'
  if (status === 'ended') return 'Session ended'
  return 'Done'
}

function glyphFor(status: string): string {
  if (status === 'needs_you') return '!'
  if (status === 'working') return '»'
  if (status === 'error') return '×'
  if (status === 'ended') return '·'
  return '—'
}

function isFocusedSub(sessionId: string): boolean {
  return props.item.id === projects.selectedProjectId && props.item.session?.id === sessionId
}

function focusSub(sessionId: string): void {
  projects.select(props.item.id)
  projects.focusSession(props.item.id, sessionId)
}

function endOneSession(sessionId: string): void {
  void projects.endSessions([sessionId])
}

function openAgent(agentId: string): void {
  activeSession.selectAgent(agentId)
}

function focusOnMount(el: unknown): void {
  if (el instanceof HTMLInputElement && document.activeElement !== el) {
    el.focus()
    el.select()
  }
}
</script>

<template>
  <div
    class="project"
    :class="{ active: item.id === projects.selectedProjectId, live }"
    :data-testid="`sidebar-project-${item.name}`"
    :draggable="!renaming"
    role="option"
    :aria-selected="item.id === projects.selectedProjectId"
    :tabindex="renaming ? -1 : 0"
    @click="projects.select(item.id)"
    @keydown.enter.self.prevent="projects.select(item.id)"
    @keydown.space.self.prevent="projects.select(item.id)"
  >
    <div class="active-bg"></div>
    <span
      class="brace"
      :data-testid="`project-accent-${item.name}`"
      aria-hidden="true"
    ></span>
    <div class="content">
      <div class="row">
        <span
          v-if="status !== 'none'"
          class="mark"
          :class="status"
          :data-testid="`status-badge-${item.name}`"
          :data-status="status"
          :title="markTitle(status)"
        >
          <span class="glyph" aria-hidden="true">{{ glyphFor(status) }}</span>
        </span>
        <template v-if="collapsed">
          <span class="initials mono">{{ initials(item.name) }}</span>
          <span
            v-if="pending > 0"
            class="badge-count collapsed-badge"
            :data-testid="`project-badge-${item.name}`"
          >
            {{ pending }}
          </span>
        </template>
        <template v-else>
          <input
            v-if="renaming"
            :ref="focusOnMount"
            v-model="renameVal"
            class="rename-input mono"
            :data-testid="`rename-input-${item.name}`"
            @click.stop
            @keydown.enter="emit('commit-rename')"
            @keydown.esc="emit('cancel-rename')"
            @blur="emit('commit-rename')"
          />
          <span v-else class="name">{{ item.name }}</span>
          <span
            v-if="pending > 0"
            class="badge-count"
            :data-testid="`project-badge-${item.name}`"
          >
            {{ pending }}
          </span>
          <span
            v-if="item.session && !item.session.endedAt && showTimer"
            class="timer mono"
            :data-testid="`timer-${item.name}`"
          >
            {{ timerOf(item.session.startedAt) }}
          </span>
          <button
            class="row-add mono"
            :data-testid="`new-session-${item.name}`"
            title="Start another session in this project"
            @click.stop="emit('new-session')"
          >
            <Icon name="plus" :size="12" />
          </button>
          <button
            class="remove mono"
            :data-testid="`remove-project-${item.name}`"
            title="Archive this project"
            @click.stop="emit('remove')"
          >
            <Icon name="close" :size="12" />
          </button>
        </template>
      </div>
      <div v-if="!collapsed && isExpanded()" class="meta">
        <span class="branch code"><Icon name="branch" :size="11" /> {{ item.session?.branch ?? '—' }}</span>
      </div>
      <div v-if="!collapsed && showPath" class="path code">{{ item.path }}</div>
      <div
        v-if="!collapsed && item.sessions.length > 1"
        class="subs"
        :data-testid="`sidebar-subsessions-${item.name}`"
      >
        <div
          v-for="(s, i) in item.sessions"
          :key="s.id"
          class="sub-row"
          :class="[`st-${sessionStatus(s)}`, { sel: isFocusedSub(s.id) }]"
        >
          <button
            type="button"
            class="sub-line"
            :class="{ sel: isFocusedSub(s.id) }"
            :data-testid="`sidebar-subsession-${s.id}`"
            :title="`${markTitle(sessionStatus(s))} — ${s.name ?? s.branch ?? 'no branch'} · session ${s.id}`"
            @click.stop="focusSub(s.id)"
          >
            <span class="mark sub-mark" :class="sessionStatus(s)">
              <span class="glyph" aria-hidden="true">{{ glyphFor(sessionStatus(s)) }}</span>
            </span>
            <span class="sub-ord mono">{{ i + 1 }}</span>
            <span class="sub-name code">{{ s.name ?? s.branch ?? s.id.slice(0, 8) }}</span>
            <span v-if="!s.endedAt && s.currentModel" class="sub-model mono">{{
              modelLabel(s.currentModel)
            }}</span>
            <span v-if="!s.endedAt && showTimer" class="timer mono">{{
              timerOf(s.startedAt)
            }}</span>
          </button>
          <button
            v-if="!s.endedAt"
            type="button"
            class="sub-x"
            :data-testid="`session-end-${s.id}`"
            :title="`End session ${i + 1}`"
            :aria-label="`End session ${i + 1}`"
            @click.stop="endOneSession(s.id)"
          >
            <Icon name="close" :size="10" />
          </button>
        </div>
      </div>
      <div
        v-if="!collapsed && agents.length > 0"
        class="agents"
        :data-testid="`sidebar-agents-${item.name}`"
      >
        <div
          v-for="agent in agents"
          :key="agent.id"
          class="agent-line"
          :data-testid="`sidebar-agent-${agent.name}`"
          @click.stop="openAgent(agent.id)"
        >
          <span class="agent-sq"></span>
          <span
            class="agent-name mono"
            :class="{ sel: activeSession.selectedAgentId === agent.id }"
          >
            {{ agent.task || agent.name }}
            <Icon
              v-if="activeSession.selectedAgentId === agent.id"
              name="arrow-left"
              :size="11"
              data-testid="sidebar-agent-selected"
            />
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.initials {
  font-size: var(--fs-meta);
  color: var(--text-body);
}

.sidebar.collapsed .content {
  padding: 1px 0;
}

.sidebar.collapsed .row {
  flex-direction: column;
  justify-content: center;
  gap: 5px;
}

.collapsed-badge {
  font-size: var(--fs-micro);
  background: color-mix(in srgb, var(--amber) 15%, transparent);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  padding: 0 4px;
  line-height: 12px;
}

.brace {
  position: absolute;
  right: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 3px;
  background: var(--idle);
  pointer-events: none;
  transition: background-color 0.12s var(--ease);
}

.project.live .brace {
  background: var(--running);
}

.active-bg {
  display: none;
}

.project.active .active-bg {
  display: block;
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--green) 9%, var(--bg-panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--green) 20%, transparent);
  border-radius: var(--rc);
}

.content {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mark {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--text-meta);
  padding: 2px;
}

.mark .glyph {
  width: 14px;
  height: 12px;
  font-family: var(--mono);
  font-size: var(--fs-glyph);
  font-weight: var(--w-em);
  line-height: 12px;
  text-align: center;
}

.mark.needs_you {
  color: var(--amber);
}

.mark.working {
  color: var(--running);
}

.mark.error {
  color: var(--red);
}

.mark.done {
  color: var(--text-mid);
}

.mark.ended {
  color: var(--text-ghost);
}

.name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-name);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project.active .name {
  color: var(--text-bright);
}

.project.active .timer,
.project.active .path,
.project.active .branch {
  color: var(--text-on-wash);
}

.remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: var(--fs-ui);
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  padding: 0;
}

.project:hover .remove {
  opacity: 1;
}

.remove:hover {
  color: var(--red);
}

.row-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: var(--fs-ui);
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  padding: 0;
}

.project:hover .row-add {
  opacity: 1;
}

.row-add:hover {
  color: var(--green);
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-left: 17px;
  margin-top: 1px;
}

.branch {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timer {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  font-variant-numeric: tabular-nums;
  color: var(--text-ghost);
}

.path {
  padding-left: 17px;
  margin-top: 2px;
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 5px;
  padding-left: 15px;
}

.sub-row {
  display: flex;
  align-items: center;
}

.sub-row.st-working {
  box-shadow: inset -2px 0 0 var(--running);
}

.sub-row.st-needs_you {
  box-shadow: inset -2px 0 0 var(--amber);
}

.sub-row.st-error {
  box-shadow: inset -2px 0 0 var(--red);
}

.sub-row .sub-line {
  flex: 1;
  min-width: 0;
}

.sub-x {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  color: var(--text-ghost);
  background: none;
  border: none;
  border-radius: var(--rp);
  opacity: 0;
  cursor: pointer;
}

.sub-row:hover .sub-x,
.sub-x:focus-visible {
  opacity: 1;
}

.sub-x:hover {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 14%, transparent);
}

.sub-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 -4px;
  padding: 2px 4px;
  border: none;
  border-radius: var(--rc);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.sub-line:hover {
  background: var(--bg-hover);
}

.sub-line.sel {
  background: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--green);
}

.sub-line:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: -1px;
}

.sub-mark {
  padding: 0;
}

.sub-model {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.sub-ord {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  font-variant-numeric: tabular-nums;
}

.sub-name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-tab);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-line.sel .sub-name {
  color: var(--text-strong);
}

.agents {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 5px;
  padding-left: 17px;
}

.agent-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 -4px;
  padding: 1px 4px;
  cursor: pointer;
}

.agent-line:hover {
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.agent-name.sel {
  color: var(--text-strong);
}

.agent-sq {
  width: 5px;
  min-width: 5px;
  height: 5px;
  background: var(--blue);
  animation: sbFade 1.8s var(--ease) infinite;
}

.agent-name {
  font-size: var(--fs-micro);
  color: var(--text-tab);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rename-input {
  flex: 1;
  min-width: 40px;
  background: var(--bg);
  border: 1px solid var(--green);
  border-radius: var(--rc);
  outline: none;
  color: var(--text-strong);
  font-size: var(--fs-ui);
  padding: 2px 7px;
}
</style>
