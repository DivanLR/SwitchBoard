<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import type { ConstitutionState, SddEntry, SddProcess } from '@shared/domain'
import { SPEC_KIT_COMMANDS, sddCommand, type SddCommand } from '@shared/sdd'
import { errorMessage } from '@renderer/ipc'
import { useSpecsStore } from '@renderer/stores/specs'
import { useFlowStore } from '@renderer/stores/flow'
import { useToastsStore } from '@renderer/stores/toasts'
import { useNewSpecDialog, type SddPrompt } from '@renderer/composables/useNewSpecDialog'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import Icon from '@renderer/components/Icon.vue'
import SddFeatures from '@renderer/components/sdd/SddFeatures.vue'
import SddProcessPanel from '@renderer/components/sdd/SddProcess.vue'

const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ (e: 'set-target', label: string): void; (e: 'open-flow'): void }>()

const specs = useSpecsStore()
const flow = useFlowStore()

type Section = 'features' | 'bugs' | 'ideas'

const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: 'features', label: 'Features' },
  { id: 'bugs', label: 'Bugs' },
  { id: 'ideas', label: 'Ideas' },
]

const PROCESS_OF: Record<Section, SddProcess | null> = { features: null, bugs: 'bug', ideas: 'assess' }

const CONSTITUTION: Record<ConstitutionState, string> = {
  missing: 'No constitution yet',
  template: 'The constitution is still the template',
  written: 'Constitution written',
}

const PROMPTS: Record<string, Omit<SddPrompt, 'command'>> = {
  'speckit-specify': {
    title: 'New spec',
    hint: '/speckit-specify scaffolds a spec for this feature in a fresh session.',
    placeholder: 'Describe the feature: the behaviour you want and what the spec must cover.',
    slug: false,
  },
  'speckit-bug-assess': {
    title: 'New bug',
    hint: '/speckit-bug-assess triages this symptom against the code and writes .specify/bugs/<slug>/assessment.md.',
    placeholder: 'The symptom: what happens, what should happen, a stack trace or an issue link.',
    slug: true,
  },
  'speckit-assess-intake': {
    title: 'New idea',
    hint: '/speckit-assess-intake captures the idea under .specify/assessments/<slug>/. It needs no source code.',
    placeholder: 'The idea, in a sentence or two, or a link to it.',
    slug: true,
  },
}

const section = ref<Section>('features')
const kind = computed(() => PROCESS_OF[section.value])
const state = computed(() => specs.stateFor(props.projectId))
const runs = computed(() => specs.liveRuns.filter((run) => run.projectId === props.projectId))
const busy = computed(() => runs.value.map((run) => run.key))
const constitution = SPEC_KIT_COMMANDS.find((c) => c.command === 'speckit-constitution') as SddCommand

watch(
  () => props.projectId,
  (id) => {
    section.value = 'features'
    void specs.load(id)
  },
  { immediate: true },
)

watch([kind, () => (kind.value ? specs.selectedSlugs[kind.value] : null)], ([process, slug]) => {
  if (process && slug && specs.report?.process !== process) void specs.selectEntry(props.projectId, process, slug)
})

watch(
  () => runs.value.length,
  (now, before) => {
    if (before !== undefined && now < before) void specs.settle(props.projectId)
  },
)

const dialogEl = useTemplateRef<HTMLElement>('dialog')
const dialog = useNewSpecDialog({
  dialog: dialogEl,
  onSubmit: (prompt, text, slug) =>
    specs.run(props.projectId, sddCommand(prompt.command, text, slug), prompt.command, prompt.title),
})
const { prompt, text, slug, slugValid, ready } = dialog

function dispatch(key: string, line: string, label: string, specId?: string): void {
  void specs.run(props.projectId, line, key, label, specId).catch((error: unknown) => {
    useToastsStore().show('error', 'Could not start that command', errorMessage(error))
  })
}

function run(command: SddCommand, target: string | null): void {
  if (command.needs === 'text') {
    dialog.open({ command: command.command, ...PROMPTS[command.command] })
    return
  }
  const line =
    command.needs === 'spec'
      ? `/${command.command} ${target ?? ''}`.trim()
      : command.needs === 'slug'
        ? sddCommand(command.command, '', target)
        : `/${command.command}`
  dispatch(command.command, line, `Running ${command.label}`, command.needs === 'spec' ? (target ?? undefined) : undefined)
}

function openSpecInFlow(specId: string): void {
  flow.seedIntake(props.projectId, { kind: 'spec', specId })
  emit('open-flow')
}

function openEntryInFlow(process: SddProcess, entry: SddEntry): void {
  const { title, slug } = entry
  flow.seedIntake(
    props.projectId,
    process === 'bug' ? { kind: 'bug', title, symptom: title, slug } : { kind: 'idea', title, idea: title, slug },
  )
  emit('open-flow')
}
</script>

<template>
  <div class="sdd" data-testid="sdd-view">
    <div v-if="!state.installed" class="ui-empty" data-testid="specs-not-installed">
      <div class="ui-empty-icon"><Icon name="diamond" :size="18" /></div>
      <div class="ui-empty-title">Spec Kit is not set up in this project</div>
      <div class="ui-empty-sub">
        Spec Kit adds spec-driven development to this project only: a constitution, then specify, plan, tasks,
        implement and converge per feature, plus the bug and idea extensions.
      </div>
      <button
        type="button"
        class="btn-solid"
        data-testid="specs-install"
        :disabled="specs.installing === 'speckit'"
        @click="specs.install(projectId)"
      >
        {{ specs.installing === 'speckit' ? 'Setting up…' : 'Set up Spec Kit in this project' }}
      </button>
      <div
        v-if="specs.installError?.what === 'speckit'"
        class="ui-err"
        role="alert"
        data-testid="specs-install-error"
      >
        {{ specs.installError.message }}
      </div>
    </div>

    <template v-else>
      <div class="ui-toolbar sdd-bar">
        <div class="ui-segments" role="tablist" aria-label="Process">
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            type="button"
            role="tab"
            class="ui-seg"
            :class="{ 'is-on': section === s.id }"
            :aria-selected="section === s.id"
            :data-testid="`sdd-section-${s.id}`"
            @click="section = s.id"
          >
            {{ s.label }}
          </button>
        </div>
        <span class="spacer"></span>
        <span class="sdd-constitution" :data-state="state.constitution" data-testid="sdd-constitution">
          <Icon :name="state.constitution === 'written' ? 'check' : 'warning'" :size="11" />
          {{ CONSTITUTION[state.constitution] }}
        </span>
        <button
          v-if="state.constitution !== 'written'"
          type="button"
          class="btn-outline"
          data-testid="sdd-constitution-write"
          :disabled="busy.includes(constitution.command)"
          @click="run(constitution, null)"
        >
          Write the constitution
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="sdd-refresh"
          aria-label="Read the Spec Kit folders again"
          title="Read the Spec Kit folders again"
          @click="specs.load(projectId)"
        >
          <Icon name="refresh" :size="12" />
        </button>
      </div>

      <div v-if="specs.error" class="ui-err-banner" role="alert" data-testid="sdd-error">{{ specs.error }}</div>

      <div v-for="r in runs" :key="r.sessionId" class="sdd-run" :data-testid="`sdd-run-${r.key}`">
        <MiniTerminal :session-id="r.sessionId" :label="r.label" />
      </div>

      <SddFeatures
        v-if="section === 'features'"
        :specs="state.specs"
        :detail="specs.detail"
        :selected-id="specs.selectedSpecId"
        :busy="busy"
        @select="(id) => specs.selectSpec(projectId, id)"
        @run="(c) => run(c, specs.selectedSpecId)"
        @set-target="(label) => emit('set-target', label)"
        @open-flow="openSpecInFlow"
      />
      <SddProcessPanel
        v-else-if="kind"
        :key="kind"
        :process="kind"
        :entries="kind === 'bug' ? state.bugs : state.ideas"
        :installed="state.extensions[kind]"
        :selected-slug="specs.selectedSlugs[kind]"
        :report="specs.report?.process === kind ? specs.report : null"
        :busy="busy"
        :installing="specs.installing === kind"
        :install-error="specs.installError?.what === kind ? specs.installError.message : null"
        @install="specs.installExtension(projectId, kind)"
        @select="(slug) => kind && specs.selectEntry(projectId, kind, slug)"
        @open-report="(slug, file) => kind && specs.openReport(projectId, kind, slug, file)"
        @run="(c) => kind && run(c, specs.selectedSlugs[kind])"
        @open-flow="(entry) => kind && openEntryInFlow(kind, entry)"
      />
    </template>

    <div v-if="prompt" class="overlay" data-testid="sdd-prompt" @click.self="dialog.cancel()">
      <div ref="dialog" class="dialog sdd-dialog" role="dialog" aria-modal="true" aria-labelledby="sdd-prompt-title">
        <div id="sdd-prompt-title" class="ui-title">{{ prompt.title }}</div>
        <div class="ui-meta">{{ prompt.hint }}</div>
        <textarea
          v-model="text"
          class="sdd-input"
          data-testid="sdd-prompt-input"
          rows="4"
          :placeholder="prompt.placeholder"
          @keydown.enter.exact.prevent="dialog.submit()"
        ></textarea>
        <label v-if="prompt.slug" class="sdd-slug">
          <span class="ui-meta">Slug</span>
          <input
            :value="slug"
            class="mono"
            data-testid="sdd-prompt-slug"
            :aria-invalid="!slugValid"
            @input="dialog.editSlug(($event.target as HTMLInputElement).value)"
          />
        </label>
        <div class="sdd-actions">
          <button type="button" class="btn-quiet" data-testid="sdd-prompt-cancel" @click="dialog.cancel()">Cancel</button>
          <button
            type="button"
            class="btn-solid"
            data-testid="sdd-prompt-submit"
            :disabled="!ready"
            @click="dialog.submit()"
          >
            Run
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sdd {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-5) var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.sdd-bar {
  gap: var(--sp-3);
}

.sdd-constitution {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  color: var(--amber);
}

.sdd-constitution[data-state='written'] {
  color: var(--text-meta);
}

.sdd-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: min(560px, 92vw);
}

.sdd-input {
  width: 100%;
  resize: vertical;
  font-size: var(--fs-ui);
  line-height: 1.5;
}

.sdd-slug {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.sdd-slug input {
  flex: 1;
}

.sdd-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-3);
}
</style>
