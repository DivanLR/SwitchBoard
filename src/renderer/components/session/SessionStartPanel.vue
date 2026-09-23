<script setup lang="ts">
import type { Session } from '@shared/domain'
import type { useSessionStart } from '@renderer/composables/useSessionStart'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  session: Session
  starter: ReturnType<typeof useSessionStart>
}>()

const {
  startMode,
  modeOpen,
  resumeSession,
  startError,
  modeChoices,
  startModeLabel,
  startModeDetail,
  canResume,
  busy,
  start,
} = props.starter
</script>

<template>
  <div class="ended ui-card" data-testid="ended-banner">
    <div class="ended-line">
      Session ended <span class="faint">({{ session.endReason ?? 'unknown' }})</span>
      <span v-if="session.statusDetail" class="faint"> — {{ session.statusDetail }}</span>
    </div>
    <div class="ended-actions">
      <div class="mode-pick">
        <button
          type="button"
          class="mode-dd"
          data-testid="start-mode-picker"
          :aria-expanded="modeOpen"
          aria-haspopup="listbox"
          :title="startModeDetail"
          :disabled="busy"
          @click="modeOpen = !modeOpen"
        >
          <span class="mode-dd-eyebrow">Mode</span>
          <span class="mode-dd-name">{{ startModeLabel }}</span>
          <span class="mode-dd-arrow" aria-hidden="true">
            <Icon :name="modeOpen ? 'chevron-up' : 'chevron-down'" :size="10" />
          </span>
        </button>
        <div v-if="modeOpen" class="mode-list" role="listbox" data-testid="start-mode-list">
          <button
            v-for="m in modeChoices"
            :key="m.value"
            type="button"
            class="mode-item"
            :class="{ sel: m.value === startMode }"
            role="option"
            :aria-selected="m.value === startMode"
            :data-testid="`start-mode-${m.value}`"
            :title="m.detail"
            @click="((startMode = m.value), (modeOpen = false))"
          >
            <span class="mode-item-name">{{ m.label }}</span>
            <span class="mode-item-detail">{{ m.detail }}</span>
          </button>
        </div>
      </div>

      <span class="bypass-inline">
        <button
          class="switch"
          :class="{ on: resumeSession }"
          data-testid="resume-session"
          role="switch"
          :aria-checked="resumeSession"
          :disabled="!canResume"
          :title="
            canResume
              ? 'Carry on the conversation that just ended: the new session opens with the previous one\'s context, so you can pick up mid-thought instead of re-explaining. Off starts an empty session in the same folder.'
              : 'Nothing to resume — this session never reached the point of having a conversation to carry on.'
          "
          @click="canResume && (resumeSession = !resumeSession)"
        >
          <span class="knob"></span>
        </button>
        <span :class="{ faint: !canResume }">Resume session</span>
      </span>

      <button class="btn-solid" data-testid="start-session" :disabled="busy" @click="start()">
        {{ resumeSession ? 'Resume' : 'Start session' }}
      </button>
    </div>
    <div v-if="startError" class="ui-err" data-testid="start-error">
      <Icon name="cross" :size="12" /> {{ startError }}
    </div>
  </div>
</template>

<style scoped>
.session-view.is-ended .stream-inner > .ended {
  position: sticky;
  top: 0;
  z-index: 2;
  border-color: var(--border-strong);
}

.stream-inner > .ended {
  margin-bottom: 13px;
}

.ended-actions {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 12px;
  align-items: center;
  margin-top: 10px;
}

.ended-actions .mode-pick {
  grid-column: 1;
  grid-row: 1;
}

.ended-actions .btn-solid {
  grid-column: 2;
  grid-row: 1;
}

.bypass-inline {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: row-reverse;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.ended-actions .bypass-inline {
  grid-row: 2;
  margin-top: 14px;
  border-radius: var(--rc);
}

.bypass-inline .switch {
  background: var(--bg-seg);
  border: 1px solid var(--border-strong);
}

.bypass-inline .switch .knob {
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  background: var(--text-mid);
}

.bypass-inline .switch.on {
  background: var(--green);
  border-color: var(--green);
}

.bypass-inline .switch.on .knob {
  left: auto;
  right: 2px;
  background: var(--green-ink);
}

.bypass-inline .switch:disabled {
  opacity: 0.45;
  cursor: default;
}

.bypass-inline .switch:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: 2px;
}

.mode-pick {
  position: relative;
}

.mode-dd {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 9px;
  background: var(--bg-seg);
  border: 1px solid var(--border-seg);
  border-radius: var(--rc);
  cursor: pointer;
  color: var(--text-body);
}

.mode-dd:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.mode-dd:disabled {
  opacity: 0.6;
  cursor: default;
}

.mode-dd-eyebrow {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: var(--track-label);
  color: var(--text-ghost);
}

.mode-dd-name {
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.mode-dd-arrow {
  color: var(--text-ghost);
}

.mode-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  box-shadow: var(--shadow-menu);
  overflow: hidden;
}

.mode-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 11px;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 1px solid transparent;
  cursor: pointer;
}

.mode-item:hover {
  background: var(--bg-hover);
}

.mode-item.sel {
  background: var(--bg-active);
  border-left-color: var(--green);
}

.mode-item-name {
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.mode-item.sel .mode-item-name {
  color: var(--green);
}

.mode-item-detail {
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-faint);
}

.session-view.is-ended .stream-inner > .ended {
  width: 100%;
  max-width: var(--end-card-w);
  margin-inline: auto;
  background: var(--bg-panel);
}

.session-view.is-ended .ended-actions {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
}

.ended-line {
  font-size: var(--fs-title);
  color: var(--text-bright);
}

.session-view.is-ended .ended-line .faint {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}
</style>
