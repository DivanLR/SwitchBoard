<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import type { SessionMode } from '@shared/domain'
import { SESSION_MODES } from '@shared/domain'
import type { ProjectListItem } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ project: ProjectListItem | null }>()
const emit = defineEmits<{ (e: 'choose', projectId: string): void }>()

const projects = useProjectsStore()
const settingsStore = useSettingsStore()

const sandboxMemVal = ref('')
watch(
  () => settingsStore.settings?.sandboxMemory,
  (v) => {
    sandboxMemVal.value = v ?? '6g'
  },
  { immediate: true },
)

function saveSandboxMemory(): void {
  const value = sandboxMemVal.value.trim()
  if (!value || value === settingsStore.settings?.sandboxMemory) return
  void settingsStore.save({ sandboxMemory: value })
}

const projDd = ref(false)
const projFilter = ref('')
const projActive = ref(0)
const projFilterEl = useTemplateRef<HTMLInputElement>('projFilterEl')

const projMatches = computed(() => {
  const q = projFilter.value.trim().toLowerCase()
  const all = projects.items.filter((p) => !p.reserved)
  return q === '' ? all : all.filter((p) => p.name.toLowerCase().includes(q))
})

function openProjDd(): void {
  projDd.value = !projDd.value
  if (!projDd.value) return
  projFilter.value = ''
  projActive.value = Math.max(
    0,
    projMatches.value.findIndex((p) => p.id === props.project?.id),
  )
  void nextTick(() => projFilterEl.value?.focus())
}

function chooseProj(id: string): void {
  emit('choose', id)
  projDd.value = false
}

function onProjKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    projDd.value = false
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    projActive.value = Math.min(
      Math.max(projActive.value + step, 0),
      Math.max(projMatches.value.length - 1, 0),
    )
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const pick = projMatches.value[projActive.value]
    if (pick) chooseProj(pick.id)
  }
}

watch(projMatches, () => {
  projActive.value = 0
})

async function saveSessionMode(mode: SessionMode): Promise<void> {
  const target = props.project
  if (!target || target.defaultSessionMode === mode) return
  await projects.setSessionMode(target.id, mode)
}
</script>

<template>
  <div v-if="!project" class="ui-card">No projects yet — add one from the sidebar first.</div>
  <template v-else>
    <div class="ui-card proj-card">
      <div class="ui-kicker group-label">PROJECT</div>
      <div class="dd-wrap">
        <button
          class="dd"
          :class="{ open: projDd }"
          data-testid="proj-settings-picker"
          :aria-expanded="projDd"
          aria-haspopup="listbox"
          @click="openProjDd"
        >
          <span class="dd-dot"></span>
          <span class="dd-name">{{ project.name }}</span>
          <Icon name="chevron-down" class="dd-arrow" :class="{ open: projDd }" :size="11" />
        </button>
        <div v-if="projDd" class="suggest-list dd-list">
          <input
            ref="projFilterEl"
            v-model="projFilter"
            class="dd-search"
            data-testid="proj-settings-search"
            placeholder="Filter projects…"
            role="combobox"
            aria-controls="proj-dd-list"
            :aria-expanded="projDd"
            :aria-activedescendant="
              projMatches[projActive] ? `proj-dd-${projMatches[projActive].id}` : undefined
            "
            @keydown="onProjKeydown"
          />
          <div id="proj-dd-list" class="dd-scroll" role="listbox" aria-label="Projects">
            <button
              v-for="(p, i) in projMatches"
              :id="`proj-dd-${p.id}`"
              :key="p.id"
              class="suggest-item dd-item"
              :class="{ sel: p.id === project.id, active: i === projActive }"
              role="option"
              :aria-selected="p.id === project.id"
              :data-testid="`proj-settings-option-${p.id}`"
              @click="chooseProj(p.id)"
              @mouseenter="projActive = i"
            >
              <span class="dd-check">
                <Icon v-if="p.id === project.id" name="check" :size="11" />
              </span>
              <span>{{ p.name }}</span>
            </button>
            <div
              v-if="projMatches.length === 0"
              class="dd-empty"
              data-testid="proj-settings-empty"
            >
              No project matches “{{ projFilter }}”.
            </div>
          </div>
        </div>
      </div>
      <div class="proj-note">
        Everything below applies only to <span class="proj-name">{{ project.name }}</span>
      </div>
    </div>

    <div class="group">
      <div class="ui-kicker group-label">SESSION TYPE</div>
      <div class="group-desc">
        What this project's sessions may do without asking. Applies to the next session
        it starts, not one already running.
      </div>
      <div class="cards" data-testid="proj-session-mode">
        <button
          v-for="m in SESSION_MODES"
          :key="m.value"
          class="ui-card card-opt is-actionable"
          :class="{ sel: project.defaultSessionMode === m.value, 'is-selected': project.defaultSessionMode === m.value }"
          :data-testid="`proj-session-mode-${m.value}`"
          @click="saveSessionMode(m.value)"
        >
          <span class="opt-dot" :class="{ on: project.defaultSessionMode === m.value }"></span>
          <div class="opt-body">
            <div class="opt-name">{{ m.label }}</div>
            <div class="opt-sub">{{ m.detail }}</div>
          </div>
          <span class="opt-price mono">
            <Icon v-if="m.value === 'bypass'" name="warning" :size="12" />
            <template v-else>—</template>
          </span>
        </button>
      </div>
    </div>
  </template>

  <div class="group">
    <div class="ui-kicker group-label">BYPASS SANDBOX</div>
    <div class="group-desc">
      For every project. Container sessions run in a WSL container capped at this much memory,
      so one hungry build stops alone instead of killing every session (exit 137). A size such as
      <span class="mono">6g</span> or <span class="mono">12g</span>, or
      <span class="mono">0</span> for no cap. Applies from the next container session.
    </div>
    <div class="ui-card setting-row is-actionable">
      <div class="sr-text">
        <div class="sr-label">Sandbox memory</div>
        <div class="sr-desc">
          Raise it if container sessions die with exit 137 during builds or test runs
        </div>
      </div>
      <input
        v-model="sandboxMemVal"
        class="add-cmd-input mono sandbox-mem-input"
        data-testid="setting-sandbox-memory"
        spellcheck="false"
        @keydown.enter="saveSandboxMemory"
        @blur="saveSandboxMemory"
      />
    </div>
  </div>
</template>

<style scoped>
.proj-card {
  margin-bottom: 10px;
}

.dd-wrap {
  position: relative;
}

.dd {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  padding: 9px 13px;
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  text-align: left;
  border-radius: var(--r-panel);
  transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
}

.dd.open {
  border-color: var(--green);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 16%, transparent);
}

.dd-arrow {
  transition: transform 160ms var(--ease-overlay);
}

.dd-arrow.open {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  .dd,
  .dd-arrow {
    transition: none;
  }
}

.dd:hover {
  border-color: var(--green);
}

.dd-dot {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: var(--rp);
  background: var(--green);
}

.dd-name {
  flex: 1;
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-strong);
}

.dd-arrow {
  color: var(--text-tab);
}

.dd-list {
  top: calc(100% + 6px);
  bottom: auto;
  padding: 0;
  overflow: hidden;
  animation: ddIn 160ms var(--ease-overlay);
}

@keyframes ddIn {
  from {
    opacity: 0;
    transform: scale(0.98) translateY(-4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dd-list {
    animation: none;
  }
}

.dd-search {
  width: 100%;
  padding: 9px 12px;
  font-size: var(--fs-ui);
  color: var(--text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border);
}

.dd-search:focus {
  outline: none;
}

.dd-scroll {
  max-height: 260px;
  overflow-y: auto;
  padding: 6px;
}

.dd-empty {
  padding: 12px;
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.dd-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
}

.dd-item:hover {
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.dd-item.sel {
  background: color-mix(in srgb, var(--green) 7%, transparent);
  color: var(--text-strong);
}

.dd-check {
  display: inline-flex;
  width: 12px;
  min-width: 12px;
  color: var(--green);
}

.proj-note {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 8px;
}

.sandbox-mem-input {
  flex: 0 0 72px;
  text-align: right;
  padding: 5px 9px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rc);
}
</style>
