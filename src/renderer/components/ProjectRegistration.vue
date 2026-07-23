<script setup lang="ts">
// "New session" dialog (design reference): folder input with a live session
// name, the default folder-access summary, a bypass-permissions toggle with
// warning, and Start/Cancel. Claude Code suggestions (FR-001a) fill the
// folder input on click.
import { computed, onMounted, ref } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'

const projects = useProjectsStore()
const emit = defineEmits<{ (e: 'close'): void }>()

const folder = ref('')
const bypass = ref(false)
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
    const project = await projects.register(path)
    projects.select(project.id)
    await projects.startSession(project.id, false, bypass.value)
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
        if (!existing.session || existing.session.endedAt) {
          await projects.startSession(existing.id, false, bypass.value)
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
    <div class="dialog reg" data-testid="registration-dialog">
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

      <div class="bypass-row">
        <div class="bypass-text">
          <div class="bypass-label">Bypass permissions</div>
          <div class="bypass-desc">
            Skips every approval — runs commands, edits, and deletes without asking
            (<span class="mono bypass-code">--dangerously-skip-permissions</span>)
          </div>
        </div>
        <button
          class="switch danger"
          :class="{ on: bypass }"
          data-testid="bypass-toggle"
          role="switch"
          :aria-checked="bypass"
          @click="bypass = !bypass"
        >
          <span class="knob"></span>
        </button>
      </div>
      <div v-if="bypass" class="bypass-warn mono" data-testid="bypass-warning">
        ⚠ Nothing will ask for approval — only use this in throwaway or fully trusted folders.
      </div>

      <template v-if="projects.suggestions.length > 0">
        <div class="section-label mono">SUGGESTED · Claude Code has been used here</div>
        <div
          v-for="s in projects.suggestions"
          :key="s.path"
          class="suggestion"
          :data-testid="`suggestion-${s.name}`"
          @click="folder = s.path"
        >
          <div class="s-meta">
            <div class="s-name mono">{{ s.name }}</div>
            <div class="s-path mono">{{ s.path }}</div>
          </div>
          <span class="s-use mono">Use</span>
        </div>
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
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
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

/* Design's toggle track/knob is a rounded rect (var(--rc)), not a pill —
   scoped here so it only reshapes the bypass switch this dialog renders. */
.switch {
  border-radius: var(--rc);
}

.switch .knob {
  border-radius: var(--rc);
}

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
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(52, 211, 153, 0.18);
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

.bypass-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 12px 14px;
  background: var(--bg-card);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.bypass-text {
  flex: 1;
  min-width: 0;
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

.bypass-code {
  font-size: 10.5px;
}

.bypass-warn {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #e0937f;
  border: 1px solid rgba(143, 59, 44, 0.4);
  background: rgba(143, 59, 44, 0.06);
  border-radius: var(--rc);
}

html.sb-light .bypass-warn {
  color: #f87171;
}

.suggestion {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
