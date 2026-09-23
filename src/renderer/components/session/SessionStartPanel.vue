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
  startEngine,
  modeOpen,
  resumeSession,
  runInContainer,
  containerForced,
  containerOn,
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
      <div class="start-pick">
        <div class="ui-segments" data-testid="start-engine" role="radiogroup" aria-label="Engine">
          <button
            type="button"
            class="ui-seg"
            :class="{ 'is-on': startEngine === 'claude' }"
            data-testid="start-engine-claude"
            role="radio"
            :aria-checked="startEngine === 'claude'"
            :disabled="busy"
            title="Claude Code: the permission inbox, plan mode, containers and subagents."
            @click="startEngine = 'claude'"
          >
            Claude
          </button>
          <button
            type="button"
            class="ui-seg"
            :class="{ 'is-on': startEngine === 'codex' }"
            data-testid="start-engine-codex"
            role="radio"
            :aria-checked="startEngine === 'codex'"
            :disabled="busy"
            title="OpenAI Codex CLI. No permission inbox, no plan mode and no container: Codex decides inside its own sandbox, and the mode chooses which sandbox."
            @click="startEngine = 'codex'"
          >
            Codex
          </button>
        </div>
        <div class="mode-pick">
          <button
            type="button"
            class="mode-dd"
            :class="{ armed: startMode === 'bypass' }"
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
              :class="{ sel: m.value === startMode, armed: m.value === 'bypass' }"
              role="option"
              :aria-selected="m.value === startMode"
              :data-testid="`start-mode-${m.value}`"
              :title="m.detail"
              @click="((startMode = m.value), (modeOpen = false))"
            >
              <span class="mode-item-name">{{ m.label }}</span>
              <span class="mode-item-detail">{{ m.detail }}</span>
            </button>
            <div v-if="startEngine === 'codex'" class="mode-note">
              Codex runs on this machine in its own sandbox, so bypass, which always runs in a
              container, is not offered.
            </div>
            <div v-else-if="resumeSession" class="mode-note">
              Resuming keeps the last session's sandbox: its transcript lives
              {{
                session.containerised
                  ? 'inside the container, so the resumed session runs in one too.'
                  : 'on this machine, so bypass, which always runs in a container, is not offered.'
              }}
            </div>
          </div>
        </div>
      </div>

      <span class="resume-inline">
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

      <span v-if="startEngine === 'claude'" class="resume-inline container-inline">
        <button
          class="switch"
          :class="{ on: containerOn }"
          data-testid="run-in-container"
          role="switch"
          :aria-checked="containerOn"
          :disabled="containerForced"
          :title="
            resumeSession
              ? `Resuming carries on where the last session ran: ${session.containerised ? 'in a WSL container' : 'on this machine'}, which is where its transcript is.`
              : containerForced
              ? 'Bypass always runs in a container: it approves every tool call, so the container is the only thing left standing between it and your files.'
              :'The same setting as Run in Container in the header, for the whole project: every session and every section run goes into a WSL container. Your project folder is mounted read-write, and your Claude credentials, plugins and skills read-only. Nothing else of yours is. Slower to start, only two containers at once, and it needs WSL 2.9.3 or newer.'
          "
          @click="containerForced || (runInContainer = !runInContainer)"
        >
          <span class="knob"></span>
        </button>
        <span :class="{ faint: containerForced }">Use WSL containers</span>
      </span>

      <button class="btn-solid" data-testid="start-session" :disabled="busy" @click="start()">
        {{ resumeSession ? 'Resume' : 'Start session' }}
      </button>
    </div>
    <div v-if="startMode === 'bypass'" class="bypass-warn" data-testid="bypass-warning">
      <Icon name="warning" :size="12" /> Nothing will ask for approval. Only use this in throwaway
      or fully trusted folders.
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

.ended-actions .start-pick {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.ended-actions .btn-solid {
  grid-column: 2;
  grid-row: 1;
}

.resume-inline {
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

.ended-actions .resume-inline {
  grid-row: 2;
  margin-top: 14px;
  border-radius: var(--rc) var(--rc) 0 0;
}

.ended-actions .resume-inline:not(.container-inline):last-of-type {
  border-radius: var(--rc);
}

.ended-actions .container-inline {
  grid-row: 3;
  margin-top: 0;
  border-top: none;
  border-radius: 0 0 var(--rc) var(--rc);
}

.mode-dd.armed .mode-dd-name,
.mode-item.armed .mode-item-name {
  color: var(--red);
}

.mode-note {
  padding: 7px 11px;
  border-top: 1px solid var(--border-soft);
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-ghost);
}

.bypass-warn {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: var(--fs-meta);
  line-height: 1.5;
  color: var(--red-hover);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
  background: color-mix(in srgb, var(--red) 6%, transparent);
  border-radius: var(--rc);
}

html.sb-light .bypass-warn {
  color: var(--red);
}

.resume-inline .switch {
  background: var(--bg-seg);
  border: 1px solid var(--border-strong);
}

.resume-inline .switch .knob {
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  background: var(--text-mid);
}

.resume-inline .switch.on {
  background: var(--green);
  border-color: var(--green);
}

.resume-inline .switch.on .knob {
  left: auto;
  right: 2px;
  background: var(--green-ink);
}

.resume-inline .switch:disabled {
  opacity: 0.45;
  cursor: default;
}

.resume-inline .switch:focus-visible {
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
