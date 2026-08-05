<script setup lang="ts">
// "New session" dialog (design reference): folder input with a live session
// name, the default folder-access summary, a bypass-permissions toggle with
// warning, and Start/Cancel. Claude Code suggestions (FR-001a) fill the
// folder input on click.
import { useTemplateRef, computed, onMounted, ref } from 'vue'
import { useModal } from '@renderer/composables/useModal'
import { isIpcError } from '@shared/ipc-types'
import { DEFAULT_SESSION_MODE, SESSION_MODES, type SessionMode } from '@shared/domain'
import { useProjectsStore } from '@renderer/stores/projects'

const projects = useProjectsStore()
const emit = defineEmits<{ (e: 'close'): void }>()

// Escape closes, Tab stays inside, focus returns to the opener on close.
const dialogEl = useTemplateRef<HTMLElement>('dialog')
useModal(dialogEl, () => emit('close'))

const folder = ref('')

// One control for one SDK setting. This was a pair of switches (bypass, plan)
// that each had to clear the other, because a plan under bypass raises no
// approval at all and reads as simply not working. A single choice cannot
// express that contradiction, and it is now the project's own setting rather
// than this dialogue's: it persists and applies to every session the project
// starts, changeable later in Settings.
const mode = ref<SessionMode>(DEFAULT_SESSION_MODE)
const error = ref<string | null>(null)
const busy = ref(false)

onMounted(() => {
  void projects.loadSuggestions()
})

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
    // The mode is registered ON the project, so the start call names nothing: it
    // reads the project's own setting. That way the session the dialogue starts
    // and every session after it agree by construction.
    const project = await projects.register(path, undefined, mode.value)
    projects.select(project.id)
    await projects.startSession(project.id)
    emit('close')
  } catch (e) {
    if (isIpcError(e) && e.code === 'DUPLICATE') {
      // Pointing New session at an already-registered folder just opens it —
      // and starts a session if none is live.
      await projects.refresh()
      const norm = (p: string): string => stripSlash(p).toLowerCase()
      const existing = projects.items.find((p) => norm(p.path) === norm(path))
      if (existing) {
        projects.select(existing.id)
        // Pointing the dialogue at a registered folder is still a mode choice, so
        // it lands on the project before anything starts.
        if (existing.defaultSessionMode !== mode.value) {
          await projects.setSessionMode(existing.id, mode.value)
        }
        if (!existing.session || existing.session.endedAt) {
          try {
            await projects.startSession(existing.id)
          } catch (startError) {
            // Starting can fail on its own terms (a bypass session needs Docker
            // running). Report it here rather than letting it escape this catch
            // block as an unhandled rejection with the dialog looking idle.
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
  <div class="overlay" @click.self="emit('close')">
    <div
      ref="dialog"
      class="dialog reg"
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      tabindex="-1" data-testid="registration-dialog">
      <div class="reg-head">
        <div class="title mono"><span style="color: var(--green)">＋</span> New session</div>
        <p class="sub">Point Claude Code at a folder and it shows up in the sidebar.</p>
      </div>

      <div class="reg-body">
      <p v-if="error" class="error mono" data-testid="registration-error">{{ error }}</p>

      <div class="section-label mono">FOLDER</div>
      <input
        v-model="folder"
        class="mono folder-input"
        data-testid="folder-input"
        placeholder="~/dev/my-project"
        spellcheck="false"
        @keydown.enter="startSession"
      />
      <div class="name-preview mono" data-testid="session-name-preview">
        Session name: <span class="name-val">{{ sessionName }}</span>
      </div>

      <div class="access-card">
        <div class="access-label mono">FOLDER ACCESS — DEFAULT</div>
        <div class="access mono">
          <div class="access-row">
            <span class="ok">✓</span> Read — everything inside this folder, no asking
          </div>
          <div class="access-row">
            <span class="ok">✓</span> Write — create and edit files inside this folder, no asking
          </div>
          <div class="access-row">
            <span class="ask">?</span> Anything outside the folder, shell commands, and deletes
            still ask first
          </div>
        </div>
      </div>

      <!-- One choice, five values, because the SDK takes one permission mode. Native
           radios rather than buttons: arrow-key navigation, a single tab stop and the
           group semantics all come for free. The input IS the mark — appearance: none
           and styled square like everything else in this world — so there is no second
           element mirroring its state, and what a test clicks is what a user clicks. -->
      <div class="section-label mono">SESSION TYPE</div>
      <div class="mode-list">
        <label
          v-for="m in SESSION_MODES"
          :key="m.value"
          class="mode-row"
          :class="{ on: mode === m.value, danger: m.value === 'bypass' }"
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
      <div v-if="mode === 'bypass'" class="bypass-warn" data-testid="bypass-warning">
        ⚠ Nothing will ask for approval — only use this in throwaway or fully trusted folders.
      </div>
      <p class="mode-note">
        Saved on the project: every session it starts uses this, and you can change it in Settings.
      </p>

      <template v-if="projects.suggestions.length > 0">
        <div class="section-label mono">SUGGESTED · Claude Code has been used here</div>
        <button
          v-for="s in projects.suggestions"
          :key="s.path"
          type="button"
          class="suggestion"
          :data-testid="`suggestion-${s.name}`"
          :aria-label="`Use ${s.path}`"
          @click="folder = s.path"
        >
          <div class="s-meta">
            <div class="s-name mono">{{ s.name }}</div>
            <div class="s-path mono">{{ s.path }}</div>
          </div>
          <span class="s-use mono">Use</span>
        </button>
      </template>

      </div>

      <!-- Pinned footer: Start session stays visible no matter how long the
           suggestions list grows. -->
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
  /* Flex column: header + scrollable body + pinned footer. The dialog itself
     no longer scrolls, so the actions stay put. */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 22px;
  /* A card, not a pill — 99px bows the corners in and clips the content. */
  border-radius: var(--rc);
  box-shadow: var(--shadow-dlg);
}

.reg-head {
  flex-shrink: 0;
}

/* Only the middle scrolls; the negative margins + padding keep focus rings and
   the suggestion hover from being clipped at the scroll edges. */
.reg-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 -22px;
  padding: 0 22px;
}


.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
}

.sub {
  font-size: 12px;
  color: var(--text-meta);
  margin: 4px 0 0;
}

.section-label {
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--text-faint);
  margin: 18px 0 6px;
}

/* The scoped .switch / .knob radius override that used to live here is gone with
   the two switches it reshaped: this dialogue renders no switch now, and the shared
   ones in styles.css already take var(--rp). */

.folder-input {
  width: 100%;
  font-size: 12.5px;
  padding: 9px 12px;
  background: var(--bg);
  border-radius: var(--rc);
}

.name-preview {
  font-size: 10.5px;
  color: var(--text-faint);
  margin-top: 6px;
}

.name-val {
  color: var(--text-mid);
}

.access-card {
  margin-top: 16px;
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  border-radius: var(--rc);
}

.access-label {
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--text-faint);
  margin-bottom: 9px;
}

.access {
  font-size: 12px;
  color: var(--text-body);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.access-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.access-row .ok,
.access-row .ask {
  font-size: 11px;
  width: 14px;
  min-width: 14px;
}

.access-row .ok {
  color: var(--green);
}

.access-row .ask {
  color: var(--amber);
}

/* The two switch rows this dressed are gone; the label and description classes
   below survive because the mode rows carry the same two-line shape. They are
   spans inside a mode row now, so the column has to be declared here. */
.bypass-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* The five session types. Rows sit flush in one stack rather than as five separate
   cards: they are one choice, and five bordered boxes read as five decisions. */
.mode-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  background: var(--bg-card);
  overflow: hidden;
}

.mode-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
}

.mode-row + .mode-row {
  border-top: 1px solid var(--border-soft);
}

.mode-row:hover {
  background: var(--bg-hover);
}

.mode-row.on {
  background: var(--bg-active);
}

/* The real radio, drawn rather than replaced: appearance: none strips the platform
   dot and the box below is square like every other mark in this world. Keeping the
   input as the visible control means the accessible name, the arrow keys and the
   focus ring belong to the thing being clicked, with no second element to keep in
   sync. */
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

/* Selection reads as a filled centre, so it survives without colour: the inner
   ring is the row's own surface and the fill is the accent behind it. */
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

/* On the row, not the 11px box: a focus ring that size is easy to miss. */
.mode-row:has(.mode-input:focus-visible) {
  outline: 1px solid var(--green);
  outline-offset: -1px;
}

.mode-row.on .bypass-label {
  color: var(--text-bright);
}

.mode-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}

.bypass-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
}

.bypass-desc {
  font-size: 11.5px;
  color: var(--text-tab);
  margin-top: 2px;
  line-height: 1.5;
}

.bypass-warn {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--red-hover);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
  background: color-mix(in srgb, var(--red) 6%, transparent);
  border-radius: var(--rc);
}

html.sb-light .bypass-warn {
  color: var(--red);
}

.suggestion {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* width + text-align: this is a <button> now, so it must be told to fill the
     row the div filled for free. */
  width: 100%;
  text-align: left;
  padding: 8px 4px;
  border-bottom: 1px solid var(--border-hist);
  cursor: pointer;
}

.suggestion:hover {
  background: var(--bg-card);
}

.s-meta {
  min-width: 0;
}

.s-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-name);
}

.s-path {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.s-use {
  font-size: 10.5px;
  color: var(--green);
}

/* Pinned footer: stays visible below the scrollable body. */
.actions {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.error {
  color: var(--red);
  font-size: 12px;
  margin: 8px 0 0;
}
</style>
