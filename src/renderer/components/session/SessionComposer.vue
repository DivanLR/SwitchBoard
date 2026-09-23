<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import type { ProjectListItem } from '@shared/ipc-types'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useQueueStore } from '@renderer/stores/queue'
import type { useCommandSuggestions } from '@renderer/composables/useCommandSuggestions'
import type { useProjectRefs } from '@renderer/composables/useProjectRefs'
import { useQueuedTasks } from '@renderer/composables/useQueuedTasks'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  project: ProjectListItem
  live: boolean
  sendTo: string
  busy: boolean
  atBottom: boolean
  restoredDraft: string | null
  stopConfirm: boolean
  queuedEditError: string
  suggest: ReturnType<typeof useCommandSuggestions>
  refEditor: ReturnType<typeof useProjectRefs>
}>()
const emit = defineEmits<{
  (e: 'send'): void
  (e: 'to-bottom'): void
  (e: 'confirm-stop'): void
  (e: 'cancel-stop'): void
}>()

const composer = defineModel<string>({ required: true })

const active = useActiveSessionStore()
const queue = useQueueStore()

const {
  suggestions,
  ghostRest,
  isCommandMatch,
  suggestIndex,
  acceptSuggestion,
  onComposerInput,
  onComposerKeydown,
  onComposerScroll,
  hintFor,
  reset: resetSuggestions,
} = props.suggest

const { addingRef, refInput, refError, commitRef, cancelRef, removeRef } = props.refEditor

const {
  editingQueued,
  queuedDraft,
  addQueued,
  removeQueued,
  beginEditQueued,
  saveQueued,
  cancelEditQueued,
} = useQueuedTasks(() => props.project.id)

const queuedTasks = computed(() => queue.forProject(props.project.id))

const composerEl = useTemplateRef<HTMLTextAreaElement>('composerEl')
defineExpose({ input: composerEl })

const composerPlaceholder = computed(() =>
  props.live ? `Send a message to ${props.sendTo}…` : 'Start a session first',
)

const composerDead = computed(() => !props.live)

const composerEmpty = computed(() => composer.value.trim().length === 0)

const commandParts = computed(() => {
  const text = composer.value
  const lead = text.length - text.trimStart().length
  const first = text.trim().split(/\s+/)[0] ?? ''
  const end = lead + first.length
  return { cmd: text.slice(0, end), rest: text.slice(end) }
})

const suggestGroups = computed<{ label: string; items: { cmd: string; index: number }[] }[]>(() => {
  const groups = new Map<string, { cmd: string; index: number }[]>()
  suggestions.value.forEach((cmd, index) => {
    const bare = cmd.replace(/^\//, '')
    const colon = bare.indexOf(':')
    const label = colon === -1 ? 'Commands' : bare.slice(0, colon)
    const list = groups.get(label)
    if (list) list.push({ cmd, index })
    else groups.set(label, [{ cmd, index }])
  })
  return [...groups].map(([label, items]) => ({ label, items }))
})

const typedToken = computed<string>(() => {
  const match = /(?:^|\s)\/([^\s]*)$/.exec(composer.value)
  return match ? match[1].toLowerCase() : ''
})

function matchParts(cmd: string): { before: string; hit: string; after: string } {
  const token = typedToken.value
  if (token === '') return { before: cmd, hit: '', after: '' }
  const at = cmd.toLowerCase().indexOf(token)
  if (at === -1) return { before: cmd, hit: '', after: '' }
  return { before: cmd.slice(0, at), hit: cmd.slice(at, at + token.length), after: cmd.slice(at + token.length) }
}

async function enqueue(): Promise<void> {
  const text = composer.value.trim()
  if (!text) return
  await addQueued(text)
  composer.value = ''
  resetSuggestions()
}
</script>

<template>
  <footer
    class="composer"
    :class="{ dead: composerDead, term: active.view === 'raw' }"
    :data-testid="composerDead ? 'composer-dead' : 'composer-live'"
  >
    <button
      v-if="!atBottom"
      type="button"
      class="to-bottom"
      data-testid="scroll-to-bottom"
      title="Jump to the newest line"
      aria-label="Jump to the newest line"
      @click="emit('to-bottom')"
    >
      <Icon name="arrow-down" :size="14" />
    </button>
    <div class="refs-row" data-testid="refs-row">
      <span class="refs-label">REFS</span>
      <span
        v-for="r in project.refs"
        :key="r.path"
        class="ref-chip ui-chip"
        :title="r.path"
        :data-testid="`ref-chip-${r.label}`"
      >
        <span class="ref-ico"><Icon name="external" :size="12" /></span>
        <span class="ref-name mono">{{ r.label }}</span>
        <button
          class="ref-x"
          :data-testid="`ref-remove-${r.label}`"
          :aria-label="`Remove reference ${r.label}`"
          @click="removeRef(r.path)"
        >
          <Icon name="close" :size="11" />
        </button>
      </span>
      <input
        v-if="addingRef"
        v-model="refInput"
        class="ref-input"
        data-testid="ref-input"
        autofocus
        placeholder="~/path/to/folder or a project name — Enter to add"
        @keydown.enter="commitRef"
        @keydown.esc="cancelRef"
        @blur="cancelRef"
      />
      <button
        v-else
        class="ref-add"
        data-testid="ref-add"
        title="Give this session read access to another folder or project — or drag a project from the sidebar onto this view"
        @click="addingRef = true"
      >
        <Icon name="plus" :size="11" /> reference
      </button>
      <span v-if="refError" class="ref-error" data-testid="ref-error">{{ refError }}</span>
    </div>
    <div v-if="queuedTasks.length > 0" class="queue" data-testid="task-queue">
      <span class="queue-label">UP NEXT</span>
      <span
        v-for="(task, index) in queuedTasks"
        :key="task.id"
        class="queue-chip"
        :data-testid="`queue-item-${index}`"
      >
        <span class="queue-num">{{ index + 1 }}</span>
        <input
          v-if="editingQueued === task.id"
          v-model="queuedDraft"
          class="queue-edit"
          :data-testid="`queue-edit-${index}`"
          :aria-label="`Edit queued task ${index + 1}`"
          @keydown.enter.prevent="saveQueued()"
          @keydown.esc.prevent="cancelEditQueued()"
          @blur="saveQueued()"
        />
        <button
          v-else
          type="button"
          class="queue-text"
          :data-testid="`queue-text-${index}`"
          title="Click to edit this task"
          @click="beginEditQueued(task)"
        >
          {{ task.text }}
        </button>
        <button
          class="queue-x"
          :data-testid="`queue-remove-${index}`"
          title="Remove from the queue"
          @click="removeQueued(task.id)"
        >
          <Icon name="close" :size="11" />
        </button>
      </span>
      <span class="queue-note">Runs automatically when the current goal finishes</span>
    </div>
    <div v-if="queuedEditError" class="queued-edit-error" data-testid="queued-edit-error">
      {{ queuedEditError }}
    </div>
    <div v-if="restoredDraft !== null && composer === restoredDraft" class="draft-float" data-testid="draft-note">
      Restored draft from the previous run — send to deliver it.
    </div>

    <div v-if="stopConfirm" class="stop-confirm" data-testid="stop-confirm">
      <span class="sc-text"><Icon name="stop" :size="12" /> Ctrl+C again to stop the chat — are you sure?</span>
      <button class="sc-stop" data-testid="stop-confirm-yes" @click="emit('confirm-stop')">Stop</button>
      <button class="sc-cancel" data-testid="stop-confirm-no" @click="emit('cancel-stop')">Cancel</button>
    </div>

    <div class="composer-row">
      <span class="caret mono"><Icon name="chevron-right" :size="14" /></span>
      <div class="input-wrap">
        <div
          v-if="suggestions.length > 0"
          class="suggest-list mono"
          data-testid="suggest-list"
          role="listbox"
          aria-label="Commands"
        >
          <div v-for="group in suggestGroups" :key="group.label" class="suggest-group">
            <div class="suggest-label">{{ group.label }}</div>
            <div
              v-for="row in group.items"
              :id="`suggest-opt-${row.index}`"
              :key="row.cmd"
              class="suggest-item"
              :class="{ active: row.index === suggestIndex }"
              :data-testid="`suggest-item-${row.index}`"
              role="option"
              :aria-selected="row.index === suggestIndex"
              @mousedown.prevent="acceptSuggestion(row.cmd)"
              @mouseenter="suggestIndex = row.index"
            >
              <span class="suggest-typed"
                >{{ matchParts(row.cmd).before
                }}<span class="suggest-hit">{{ matchParts(row.cmd).hit }}</span
                >{{ matchParts(row.cmd).after }}</span
              >
              <span v-if="hintFor(row.cmd)" class="suggest-desc">{{ hintFor(row.cmd) }}</span>
            </div>
          </div>
        </div>
        <div class="ghost mono" aria-hidden="true">
          <template v-if="isCommandMatch"
            ><span class="ghost-cmd">{{ commandParts.cmd }}</span
            ><span class="ghost-args">{{ commandParts.rest }}</span></template
          ><span v-else class="ghost-typed">{{ composer }}</span
          ><span class="ghost-rest" data-testid="ghost-suggestion">{{ ghostRest }}</span>
        </div>
        <textarea
          ref="composerEl"
          v-model="composer"
          class="composer-input mono"
          :class="{ 'is-command': isCommandMatch }"
          data-testid="composer-input"
          rows="1"
          :placeholder="composerPlaceholder"
          :disabled="composerDead"
          spellcheck="false"
          autocomplete="off"
          @input="onComposerInput"
          @keydown="onComposerKeydown"
          @scroll="onComposerScroll"
        ></textarea>
      </div>
      <span class="to-inline" data-testid="composer-to">to {{ sendTo }}</span>
      <button
        class="queue-btn"
        data-testid="composer-queue"
        title="Add to the queue — runs after the current goal finishes"
        :disabled="composerEmpty"
        @click="enqueue()"
      >
        <Icon name="plus" :size="11" /> Queue
      </button>
      <button
        class="send-btn"
        data-testid="composer-send"
        :disabled="composerDead || busy || composerEmpty"
        @click="emit('send')"
      >
        Send <Icon name="send" :size="12" />
      </button>
    </div>
  </footer>
</template>

<style scoped>
.draft-float {
  margin-bottom: 5px;
  padding: 4px 8px;
  font-size: var(--fs-micro);
  color: var(--amber);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  box-shadow: var(--shadow-dd);
}

.to-inline {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
}

.refs-row {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 18px 10px;
  flex-wrap: wrap;
  pointer-events: none;
}

.refs-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  color: var(--text-faint);
}

.ref-chip {
  box-shadow: var(--elev);
  pointer-events: auto;
}

.ref-ico {
  color: var(--green);
}

.ref-x {
  color: var(--text-faint);
  font-size: var(--fs-micro);
  padding: 0 1px;
}

.ref-x:hover {
  color: var(--red);
}

.ref-add {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  padding: 2px 10px;
  background: var(--bg-panel);
  box-shadow: var(--elev);
  pointer-events: auto;
}

.ref-add:hover {
  color: var(--green);
  border-color: var(--green);
}

.ref-input {
  width: 300px;
  font-size: var(--fs-meta);
  background: var(--bg);
  border: 1px solid var(--green);
  border-radius: var(--rc);
  outline: none;
  color: var(--text-strong);
  padding: 3px 9px;
  font-family: var(--sans);
  pointer-events: auto;
}

.ref-error {
  font-size: var(--fs-micro);
  color: var(--red);
  pointer-events: auto;
}

.composer {
  position: relative;
  box-shadow: var(--hairline-shine);
}

.composer.term {
  background: var(--bg-code);
  border-top-color: var(--border-code);
}

.composer.dead {
  background: var(--bg);
  box-shadow: none;
}

.composer.dead .composer-row {
  opacity: 0.55;
}

.composer.dead .composer-input,
.composer.dead .ghost-typed,
.composer.dead .to-inline {
  color: var(--text-ghost);
}

.composer.dead .composer-input::placeholder {
  color: var(--text-ghost);
}

.composer.dead .composer-input {
  caret-color: transparent;
}

.to-bottom {
  position: absolute;
  top: -44px;
  right: 22px;
  z-index: 5;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-body);
  color: var(--text-body);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  box-shadow: var(--shadow-dd);
  cursor: pointer;
}

.to-bottom:hover {
  color: var(--green);
  border-color: var(--green);
}

.caret {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  color: var(--green);
  font-weight: var(--w-em);
}
</style>
