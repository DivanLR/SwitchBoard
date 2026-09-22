<script setup lang="ts">
import { useTemplateRef, computed, ref } from 'vue'
import { useModal } from '@renderer/composables/useModal'
import { isIpcError } from '@shared/ipc-types'
import { DEFAULT_SESSION_MODE, SESSION_MODES, type SessionMode } from '@shared/domain'
import { useProjectsStore } from '@renderer/stores/projects'
import Icon from '@renderer/components/Icon.vue'

const projects = useProjectsStore()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = useTemplateRef<HTMLElement>('dialog')
useModal(dialogEl, () => emit('close'))

const folder = ref('')

const mode = ref<SessionMode>(DEFAULT_SESSION_MODE)
const error = ref<string | null>(null)
const busy = ref(false)

async function browseFolder(): Promise<void> {
  const picked = await projects.pickFolder()
  if (picked) folder.value = picked
}

const stripSlash = (p: string): string => p.replace(/[\\/]+$/, '')

const sessionName = computed(() => {
  const trimmed = stripSlash(folder.value.trim())
  return trimmed.split(/[\\/]/).pop() || '—'
})

async function startSession(): Promise<void> {
  const path = folder.value.trim()
  if (!path) return
  error.value = null
  busy.value = true
  try {
    const project = await projects.register(path, undefined, mode.value)
    projects.select(project.id)
    await projects.startSession(project.id)
    emit('close')
  } catch (e) {
    if (isIpcError(e) && e.code === 'DUPLICATE') {
      await projects.refresh()
      const norm = (p: string): string => stripSlash(p).toLowerCase()
      const existing = projects.items.find((p) => norm(p.path) === norm(path))
      if (existing) {
        projects.select(existing.id)
        if (existing.defaultSessionMode !== mode.value) {
          await projects.setSessionMode(existing.id, mode.value)
        }
        if (!existing.session || existing.session.endedAt) {
          try {
            await projects.startSession(existing.id)
          } catch (startError) {
            error.value = isIpcError(startError) ? startError.message : String(startError)
            return
          }
        }
        emit('close')
      } else {
        error.value = 'That folder is already registered.'
      }
    } else if (isIpcError(e)) {
      error.value = e.code === 'INVALID_PATH' ? 'That folder does not exist.' : e.message
    } else {
      error.value = String(e)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="overlay" data-testid="registration-overlay" @click.self="emit('close')">
    <div
      ref="dialog"
      class="dialog reg"
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      tabindex="-1" data-testid="registration-dialog">
      <div class="reg-head">
        <div class="title"><Icon name="plus" style="color: var(--green)" /> New session</div>
        <p class="sub">Point Claude Code at a folder and it shows up in the sidebar.</p>
      </div>

      <div class="reg-body">
      <p v-if="error" class="ui-err" data-testid="registration-error">{{ error }}</p>

      <div class="ui-kicker section-label">FOLDER</div>
      <div class="folder-row">
        <input
          v-model="folder"
          class="mono folder-input"
          data-testid="folder-input"
          placeholder="~/dev/my-project"
          spellcheck="false"
          @keydown.enter="startSession"
        />
        <button
          type="button"
          class="btn-outline"
          data-testid="browse-folder"
          :disabled="busy"
          @click="browseFolder"
        >
          Browse…
        </button>
      </div>
      <div class="name-preview mono" data-testid="session-name-preview">
        Session name: <span class="name-val">{{ sessionName }}</span>
      </div>

      <div class="ui-card access-card">
        <div class="access-label">FOLDER ACCESS — DEFAULT</div>
        <div class="access">
          <div class="ui-row access-row">
            <Icon name="check" class="ok" /> Read — everything inside this folder, no asking
          </div>
          <div class="ui-row access-row">
            <Icon name="check" class="ok" /> Write — create and edit files inside this folder, no asking
          </div>
          <div class="ui-row access-row">
            <span class="ask">?</span> Anything outside the folder, shell commands, and deletes
            still ask first
          </div>
        </div>
      </div>

      <div class="ui-kicker section-label">SESSION TYPE</div>
      <div class="ui-card mode-list">
        <label
          v-for="m in SESSION_MODES"
          :key="m.value"
          class="ui-row mode-row"
          :class="{ on: mode === m.value, 'is-selected': mode === m.value, danger: m.value === 'bypass' }"
        >
          <input
            v-model="mode"
            class="mode-input"
            type="radio"
            name="session-mode"
            :value="m.value"
            :data-testid="`session-mode-${m.value}`"
          />
          <span class="bypass-text">
            <span class="bypass-label">{{ m.label }}</span>
            <span class="bypass-desc">{{ m.detail }}</span>
          </span>
        </label>
      </div>
      <div v-if="mode === 'bypass'" class="ui-err-banner is-warn" data-testid="bypass-warning">
        <Icon name="warning" :size="12" /> Nothing will ask for approval — only use this in
        throwaway or fully trusted folders.
      </div>
      <p class="mode-note">
        Saved on the project: every session it starts uses this, and you can change it in Settings.
      </p>

      </div>

      <div class="actions">
        <button
          class="btn-solid"
          data-testid="start-session"
          :disabled="busy || folder.trim().length === 0"
          @click="startSession"
        >
          Start session
        </button>
        <button class="btn-outline" data-testid="registration-cancel" @click="emit('close')">
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reg {
  width: 470px;
  max-width: 92vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.reg-head {
  flex-shrink: 0;
}

.reg-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 calc(-1 * var(--pad-dialog));
  padding: 0 var(--pad-dialog);
}


.title {
  font-size: var(--fs-title);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.sub {
  font-size: var(--fs-ui);
  color: var(--text-meta);
  margin: 4px 0 0;
}

.section-label {
  margin: 18px 0 6px;
}


.folder-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.folder-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  padding: 9px 12px;
  background: var(--bg);
  border-radius: var(--rc);
}

.folder-row .btn-outline {
  flex-shrink: 0;
  padding: 9px 14px;
}

.name-preview {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  margin-top: 6px;
}

.name-val {
  color: var(--text-mid);
}

.access-card {
  margin-top: 16px;
  border-color: color-mix(in srgb, var(--green) 18%, transparent);
}

.access-label {
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  color: var(--text-faint);
  margin-bottom: 9px;
}

.access {
  font-size: var(--fs-ui);
  color: var(--text-body);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.access-row {
  align-items: baseline;
  gap: 9px;
  padding: 0;
  min-height: auto;
}

.access-row:hover {
  background: none;
}

.access-row .ok,
.access-row .ask {
  font-size: var(--fs-meta);
  width: 14px;
  min-width: 14px;
}

.access-row .ok {
  color: var(--green);
}

.access-row .ask {
  color: var(--amber);
}

.bypass-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.mode-list {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.mode-row {
  align-items: flex-start;
  padding: var(--pad-card);
  cursor: pointer;
}

.mode-row + .mode-row {
  border-top: 1px solid var(--border-soft);
}

.mode-input {
  appearance: none;
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  margin: 4px 0 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  background: transparent;
  cursor: pointer;
}

.mode-input:checked {
  border-color: var(--green);
  box-shadow:
    inset 0 0 0 2px var(--bg-card),
    inset 0 0 0 11px var(--green);
}

.mode-row.danger .mode-input:checked {
  border-color: var(--red);
  box-shadow:
    inset 0 0 0 2px var(--bg-card),
    inset 0 0 0 11px var(--red);
}

.mode-row:has(.mode-input:focus-visible) {
  outline: 1px solid var(--green);
  outline-offset: -1px;
}

.mode-row.on .bypass-label {
  color: var(--text-bright);
}

.mode-note {
  margin: 8px 0 0;
  font-size: var(--fs-meta);
  line-height: 1.5;
  color: var(--text-faint);
}

.bypass-label {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-title);
}

.bypass-desc {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 2px;
  line-height: 1.5;
}

.actions {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
</style>
