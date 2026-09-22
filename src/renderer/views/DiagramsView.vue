<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ARCHIFY,
  ARCHIFY_COMMANDS,
  ARCHIFY_PREFIX,
  ARCHIFY_STAGES,
  ARCHIFY_TYPES,
  DEFAULT_ARCHIFY,
  DIAGRAM_COMMANDS,
  DIAGRAM_PLUGIN,
  DIAGRAMS_DIR,
  archifyCommandText,
  archifySpecFile,
  diagramCommandText,
  isDiagramFilePick,
  type ArchifyOptions,
  type ArchifyStage,
  type ArchifyType,
  type DiagramFilePick,
} from '@shared/diagram'
import { relativeTime } from '@renderer/relative-time'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'
import { useDiagramsStore } from '@renderer/stores/diagrams'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSkillsStore } from '@renderer/stores/skills'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  projectId: string
  available: string[]
  sessionId?: string | null
  installing?: boolean
  installError?: string | null
}>()

const emit = defineEmits<{ (e: 'install'): void; (e: 'run', command: string): void }>()

const diagrams = useDiagramsStore()
const settings = useSettingsStore()
const skills = useSkillsStore()
const active = useActiveSessionStore()

onMounted(() => {
  void diagrams.load(props.projectId)
  void skills.load()
  if (!settings.settings) void settings.load()
})
watch(() => props.projectId, (id) => void diagrams.load(id))

const description = ref('')
const fileName = ref('')
const input = ref<HTMLInputElement | null>(null)

const engine = computed(() => settings.settings?.diagramEngine ?? 'diagram-design')
const onArchify = computed(() => engine.value === 'archify')

function setEngine(next: 'diagram-design' | 'archify'): void {
  if (next === engine.value) return
  menuOpen.value = false
  void settings.save({ diagramEngine: next })
}

const archify = ref<ArchifyOptions>({ ...DEFAULT_ARCHIFY })

const archifyInstalled = computed(() => skills.enabled.some((s) => s.name === ARCHIFY.skill))

const importingArchify = computed(() => skills.importing)

async function installArchify(): Promise<void> {
  menuOpen.value = false
  await skills.import(ARCHIFY.source)
}

const isPluginCommand = computed(() => description.value.trimStart().startsWith('/'))
const isArchifyCommand = computed(() =>
  description.value.trimStart().toLowerCase().startsWith(ARCHIFY_PREFIX),
)
const isCommand = computed(() => isPluginCommand.value || isArchifyCommand.value)

const pickedCommand = computed<{ description: string; argumentHint: string } | null>(() => {
  const words = description.value.trim().split(/\s+/)
  if (isArchifyCommand.value) {
    const sub = (words[1] ?? '').toLowerCase()
    return ARCHIFY_COMMANDS.find((c) => c.command === sub) ?? null
  }
  const first = words[0] ?? ''
  const name = first.slice(first.lastIndexOf(':') + 1).replace(/^\//, '')
  return DIAGRAM_COMMANDS.find((c) => c.command === name) ?? null
})

const commandTakesFileOnly = computed(() => pickedCommand.value !== null && !isArchifyCommand.value)

const browsableCommand = computed<DiagramFilePick | null>(() => {
  if (isArchifyCommand.value) return null
  const first = description.value.trim().split(/\s+/)[0] ?? ''
  const name = first.slice(first.lastIndexOf(':') + 1).replace(/^\//, '')
  return isDiagramFilePick(name) ? name : null
})

function looksLikePath(token: string | undefined): boolean {
  const bare = token?.replace(/^"|"$/g, '')
  if (!bare || bare.startsWith('-')) return false
  return /[\\/]/.test(bare) || /\.[A-Za-z0-9]+$/.test(bare)
}

async function browseImport(): Promise<void> {
  const picked = await diagrams.pickImport()
  if (!picked) return
  const argument = /\s/.test(picked.path) ? `"${picked.path}"` : picked.path
  description.value = `/${DIAGRAM_PLUGIN.namespace}:${picked.command} ${argument} `
  void nextTick(() => {
    const field = input.value
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  })
}

const ARCHIFY_STEPS = [
  { key: 'type', label: '1. Type chosen' },
  { key: 'schema', label: '2. Schema and example read' },
  { key: 'spec', label: '3. Candidate written' },
  { key: 'validate', label: '4. Validated (freezes the candidate)' },
  { key: 'deliver', label: '5. Delivered' },
  { key: 'done', label: 'In docs/diagrams' },
] as const

const runOutput = computed(() => {
  const id = pending.value?.sessionId ?? props.sessionId
  if (!id) return ''
  return (active.tails[id] ?? [])
    .filter((e) => e.kind === 'tool_activity' || e.kind === 'raw_output')
    .map((e) => {
      const p = e.payload as Partial<{ text: string; inputPreview: string; resultPreview: string }>
      return `${p.inputPreview ?? ''} ${p.resultPreview ?? ''} ${p.text ?? ''}`
    })
    .join(' ')
})

const archifyStep = computed(() => {
  if (!pending.value) return list.value.length > 0 ? ARCHIFY_STEPS.length : 0
  const text = runOutput.value
  const spec = archifySpecFile(pending.value.file, archify.value.type)
  let reached = 1
  if (/schemas\/|examples\//.test(text)) reached = 2
  if (text.includes(spec)) reached = 3
  if (/archify\S*\s+validate\b/.test(text)) reached = 4
  if (/archify\S*\s+deliver\b/.test(text)) reached = 5
  return reached
})

async function pickReference(): Promise<void> {
  const path = await diagrams.pickFile('archify-reference')
  if (path) archify.value.reference = path
}

async function browse(): Promise<void> {
  const command = browsableCommand.value
  if (!command) return
  const path = await diagrams.pickFile(command)
  if (!path) return
  const argument = /\s/.test(path) ? `"${path}"` : path
  const text = description.value.trim()
  const head = text.split(/\s+/)[0] ?? ''
  let rest = text.slice(head.length).trimStart()
  const existing = /^("[^"]*"|\S+)/.exec(rest)?.[0]
  if (looksLikePath(existing)) rest = rest.slice(existing!.length).trimStart()
  description.value = `${head} ${argument} ${rest}`.trimEnd() + ' '
  void nextTick(() => {
    const field = input.value
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  })
}

const refusedCommand = computed(() => {
  if (!isArchifyCommand.value) return null
  const sub = (description.value.trim().split(/\s+/)[1] ?? '').toLowerCase()
  const entry = ARCHIFY_COMMANDS.find((c) => c.command === sub)
  return entry && !entry.sendable ? entry : null
})

async function generate(): Promise<void> {
  const text = description.value.trim()
  if (!text) return
  if (refusedCommand.value) return
  if (isArchifyCommand.value) {
    emit('run', archifyCommandText(text))
    description.value = ''
    return
  }
  if (isPluginCommand.value) {
    emit('run', diagramCommandText(text))
    description.value = ''
    return
  }
  const options = onArchify.value ? { ...archify.value } : undefined
  if (await diagrams.generate(props.projectId, text, options, fileName.value)) {
    description.value = ''
    fileName.value = ''
  }
}

const pending = computed(() =>
  diagrams.pending?.projectId === props.projectId ? diagrams.pending : null,
)

const list = computed(() =>
  [...diagrams.forProject(props.projectId)].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
)

const installed = computed(() => {
  if (onArchify.value) return archifyInstalled.value || skills.loading
  if (diagrams.byProject[props.projectId] === undefined) return true
  if (list.value.length > 0 || pending.value) return true
  if (props.available.length === 0) return true
  const key = normalizeForMatch(DIAGRAM_PLUGIN.probeCommand)
  return props.available.some((c) => normalizeForMatch(c.slice(c.lastIndexOf(':') + 1)) === key)
})

const ago = (iso: string): string => relativeTime(iso, Date.now())

const selected = computed(() =>
  diagrams.selected?.projectId === props.projectId ? diagrams.selected.file : null,
)
const selectedHtml = computed(() => (selected.value ? diagrams.html[selected.value] : undefined))
const selectedEntry = computed(() => list.value.find((d) => d.file === selected.value) ?? null)

const menuOpen = ref(false)

const cmdBtn = ref<HTMLElement | null>(null)
const menuPos = ref<{ left: number; top: string; bottom: string; maxHeight: number } | null>(null)

const MENU_W = 360
const MENU_GAP = 5
const MENU_EDGE = 8

function toggleMenu(): void {
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  const r = cmdBtn.value?.getBoundingClientRect()
  if (r) {
    const below = window.innerHeight - r.bottom - MENU_GAP - MENU_EDGE
    const above = r.top - MENU_GAP - MENU_EDGE
    const up = below < 220 && above > below
    menuPos.value = {
      left: Math.max(
        MENU_EDGE,
        Math.min(r.right - MENU_W, window.innerWidth - MENU_W - MENU_EDGE),
      ),
      top: up ? 'auto' : `${r.bottom + MENU_GAP}px`,
      bottom: up ? `${window.innerHeight - r.top + MENU_GAP}px` : 'auto',
      maxHeight: up ? above : below,
    }
  }
  menuOpen.value = true
}

interface MenuCommand {
  command: string
  description: string
  argumentHint: string
  available: boolean
  sendable: boolean
  stage?: ArchifyStage
}

const archifyGroups = computed(() =>
  ARCHIFY_STAGES.map((s) => ({
    ...s,
    items: commands.value.filter((c) => c.stage === s.stage),
  })).filter((g) => g.items.length > 0),
)

const commands = computed<MenuCommand[]>(() => {
  if (onArchify.value) {
    return ARCHIFY_COMMANDS.map((c) => ({ ...c, available: archifyInstalled.value }))
  }
  return DIAGRAM_COMMANDS.map((c) => ({
    ...c,
    sendable: true,
    available:
      props.available.length === 0 ||
      props.available.some(
        (name) => normalizeForMatch(name.slice(name.lastIndexOf(':') + 1)) === normalizeForMatch(c.command),
      ),
  }))
})

function pickCommand(entry: MenuCommand): void {
  menuOpen.value = false
  if (onArchify.value) {
    const wantsHtml = entry.command === 'check' || entry.command === 'visual-check'
    const argument = wantsHtml && selected.value ? ` ${DIAGRAMS_DIR}/${selected.value}` : ''
    description.value = `${ARCHIFY_PREFIX}${entry.command}${argument} `
  } else {
    const rest = description.value.replace(/^\s*\/\S*\s*/, '').trim()
    const takesDiagram = DIAGRAM_COMMANDS.find((c) => c.command === entry.command)?.takesDiagram
    const argument = takesDiagram && selected.value ? ` ${DIAGRAMS_DIR}/${selected.value}` : ''
    description.value = `/${DIAGRAM_PLUGIN.namespace}:${entry.command}${argument} ${rest}`.trimEnd() + ' '
  }
  void nextTick(() => {
    const field = input.value
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  })
}

function installFromMenu(): void {
  if (onArchify.value) {
    void installArchify()
    return
  }
  menuOpen.value = false
  emit('install')
}

const installBusy = computed(() =>
  onArchify.value ? importingArchify.value : props.installing === true,
)


watch(
  list,
  (entries) => {
    if (selected.value || entries.length === 0) return
    void diagrams.select(props.projectId, entries[0].file)
  },
  { immediate: true },
)
</script>

<template>
  <div class="dgm" data-testid="diagrams-view">
    <div class="rail">
      <div class="engine ui-segments" data-testid="diagram-engine">
        <button
          type="button"
          class="ui-seg"
          :class="{ on: !onArchify, 'is-on': !onArchify }"
          data-testid="diagram-engine-diagram-design"
          :aria-pressed="!onArchify"
          title="The diagram-design plugin: describe a drawing and it draws it."
          @click="setEngine('diagram-design')"
        >
          diagram-design
        </button>
        <button
          type="button"
          class="ui-seg"
          :class="{ on: onArchify, 'is-on': onArchify }"
          data-testid="diagram-engine-archify"
          :aria-pressed="onArchify"
          title="The archify skill: author typed JSON, validate it against a schema, then deliver."
          @click="setEngine('archify')"
        >
          archify
        </button>
      </div>

      <div class="intro">
        <template v-if="onArchify">
          Pick a type, describe the diagram, and the project's session authors a typed
          specification, validates it with archify, then delivers a standalone HTML file into
          <span class="mono">{{ DIAGRAMS_DIR }}</span>.
        </template>
        <template v-else>
          Describe a diagram and the project's session will draw it with the diagram-design plugin, as
          a standalone HTML file in <span class="mono">{{ DIAGRAMS_DIR }}</span>.
        </template>
      </div>

      <div v-if="!installed" class="install-card ui-card">
        <div class="install-text">
          <div class="install-title">
            <template v-if="onArchify">
              archify is not imported yet — add the skill to generate diagrams with it
            </template>
            <template v-else>
              diagram-design is not installed in this project — add it to generate diagrams
            </template>
          </div>
          <div class="install-cmds mono">
            <template v-if="onArchify">{{ ARCHIFY.source }}</template>
            <template v-else>{{ DIAGRAM_PLUGIN.marketplace }} · {{ DIAGRAM_PLUGIN.pkg }}</template>
          </div>
          <div
            v-if="onArchify ? skills.error : installError"
            class="install-error ui-err"
            data-testid="diagrams-install-error"
          >
            {{ onArchify ? skills.error : props.installError }}
          </div>
        </div>
        <button
          class="install-btn"
          data-testid="diagrams-install"
          :disabled="installBusy"
          @click="onArchify ? installArchify() : emit('install')"
        >
          <template v-if="installBusy">{{ onArchify ? 'Importing…' : 'Installing…' }}</template>
          <template v-else-if="onArchify"><Icon name="download" :size="12" /> Import the skill</template>
          <template v-else><Icon name="download" :size="12" /> Download to project</template>
        </button>
      </div>

      <div class="bar">
        <input
          ref="input"
          v-model="description"
          class="in"
          data-testid="diagram-input"
          placeholder="What should the diagram show — e.g. the auth flow from login to session refresh"
          :disabled="diagrams.generating"
          @keydown.enter="generate()"
        />
        <input
          v-if="!isCommand"
          v-model="fileName"
          class="in name-in"
          data-testid="diagram-name"
          placeholder="File name (optional) — otherwise named from the sentence above"
          :disabled="diagrams.generating"
          @keydown.enter="generate()"
        />
        <button
          class="add-btn"
          data-testid="diagram-generate"
          :disabled="diagrams.generating || !description.trim() || refusedCommand !== null"
          @click="generate()"
        >
          <template v-if="diagrams.generating">Asking…</template>
          <template v-else-if="isCommand"><Icon name="chevron-right" :size="12" /> Send</template>
          <template v-else><Icon name="pencil" :size="12" /> Generate</template>
        </button>
        <div class="cmds">
          <button
            v-if="!onArchify"
            type="button"
            class="cmd-btn"
            data-testid="diagram-import-file"
            :disabled="diagrams.generating"
            title="Pick a .drawio, .mmd or .xml file from this machine and import it as a diagram. Also takes an .html diagram to export."
            @click="browseImport()"
          >
            <Icon name="folder" :size="11" /> Browse…
          </button>
          <button
            ref="cmdBtn"
            class="cmd-btn"
            data-testid="diagram-commands"
            :aria-expanded="menuOpen"
            @click="toggleMenu()"
          >
            Commands <Icon name="chevron-down" :size="11" />
          </button>
          <div
            v-if="menuOpen"
            class="cmd-menu"
            data-testid="diagram-command-menu"
            :style="
              menuPos
                ? {
                    left: `${menuPos.left}px`,
                    top: menuPos.top,
                    bottom: menuPos.bottom,
                    maxHeight: `${menuPos.maxHeight}px`,
                  }
                : undefined
            "
          >
            <template v-if="onArchify">
              <div v-for="g in archifyGroups" :key="g.stage" class="cmd-group">
                <div class="cmd-group-label">{{ g.label }}</div>
                <button
                  v-for="c in g.items"
                  :key="c.command"
                  class="cmd-item"
                  :class="{ missing: !c.available, inert: c.available && !c.sendable }"
                  :data-testid="`diagram-command-${c.command}`"
                  :disabled="installBusy || (c.available && !c.sendable)"
                  @click="c.available ? pickCommand(c) : installFromMenu()"
                >
                  <span class="cmd-name mono">archify {{ c.command }}</span>
                  <span class="cmd-desc">{{ c.description }}</span>
                  <span class="cmd-args mono">{{ c.argumentHint }}</span>
                  <span
                    v-if="c.available && !c.sendable"
                    class="cmd-missing"
                    :data-testid="`diagram-command-inert-${c.command}`"
                  >
                    runs until Ctrl-C — not from here
                  </span>
                  <span
                    v-else-if="!c.available"
                    class="cmd-missing"
                    :data-testid="`diagram-install-hint-${c.command}`"
                  >
                    <Icon name="download" :size="11" />
                    <template v-if="installBusy">importing…</template>
                    <template v-else>import archify</template>
                  </span>
                </button>
              </div>
            </template>
            <button
              v-for="c in onArchify ? [] : commands"
              :key="c.command"
              class="cmd-item"
              :class="{ missing: !c.available, inert: c.available && !c.sendable }"
              :data-testid="`diagram-command-${c.command}`"
              :disabled="installBusy || (c.available && !c.sendable)"
              @click="c.available ? pickCommand(c) : installFromMenu()"
            >
              <span class="cmd-name mono">{{ onArchify ? 'archify ' : '/' }}{{ c.command }}</span>
              <span class="cmd-desc">{{ c.description }}</span>
              <span class="cmd-args mono">{{ c.argumentHint }}</span>
              <span
                v-if="c.available && !c.sendable"
                class="cmd-missing"
                :data-testid="`diagram-command-inert-${c.command}`"
              >
                runs until Ctrl-C — not from here
              </span>
              <span
                v-else-if="!c.available"
                class="cmd-missing"
                :data-testid="`diagram-install-hint-${c.command}`"
              >
                <Icon name="download" :size="11" />
                <template v-if="installBusy">{{ onArchify ? 'importing…' : 'installing…' }}</template>
                <template v-else>{{ onArchify ? 'import archify' : 'install diagram-design' }}</template>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="onArchify && !isCommand" class="archify-bar" data-testid="archify-options">
        <div class="ab-row">
          <span class="ab-label">type</span>
          <button
            v-for="t in ARCHIFY_TYPES"
            :key="t.type"
            type="button"
            class="ui-chip"
            :class="{ on: archify.type === t.type, 'is-on': archify.type === t.type }"
            :data-testid="`archify-type-${t.type}`"
            :aria-pressed="archify.type === t.type"
            :title="t.hint"
            @click="archify.type = t.type as ArchifyType"
          >
            {{ t.label }}
          </button>
        </div>
        <div class="ab-row">
          <span class="ab-label">quality</span>
          <button
            type="button"
            class="ui-chip"
            :class="{ on: archify.quality === 'showcase', 'is-on': archify.quality === 'showcase' }"
            data-testid="archify-quality-showcase"
            :aria-pressed="archify.quality === 'showcase'"
            title="archify's own authoring default: all nine artifact checks, no warnings."
            @click="archify.quality = 'showcase'"
          >
            showcase
          </button>
          <button
            type="button"
            class="ui-chip"
            :class="{ on: archify.quality === 'standard', 'is-on': archify.quality === 'standard' }"
            data-testid="archify-quality-standard"
            :aria-pressed="archify.quality === 'standard'"
            title="For a deliberately dense map, where the showcase budget would cut too much."
            @click="archify.quality = 'standard'"
          >
            standard
          </button>
          <span class="ab-gap"></span>
          <button
            type="button"
            class="ui-chip"
            :class="{ on: archify.motion, 'is-on': archify.motion }"
            data-testid="archify-motion"
            role="switch"
            :aria-checked="archify.motion"
            title="Turn on the viewer extras: traced motion and a few guided chapters. Off by default, which is the skill's own rule."
            @click="archify.motion = !archify.motion"
          >
            <Icon name="play" :size="11" /> interactive viewer
          </button>
        </div>
        <div class="ab-row">
          <span class="ab-label">reference</span>
          <button
            v-if="!archify.reference"
            type="button"
            class="ui-chip"
            data-testid="archify-reference-pick"
            :disabled="diagrams.generating"
            title="Pick a file for archify to draw from: an existing .drawio or .mmd, a photograph of a whiteboard, a spec, a README. It reads the file and carries over what is actually in it."
            @click="pickReference()"
          >
            <Icon name="folder" :size="11" /> Browse…
          </button>
          <template v-else>
            <span class="ab-ref mono" data-testid="archify-reference-name">{{
              archify.reference.replace(/^.*[\\/]/, '')
            }}</span>
            <button
              type="button"
              class="ui-chip"
              data-testid="archify-reference-clear"
              :title="`Drawing from ${archify.reference}. Clear it to describe a diagram from scratch instead.`"
              @click="archify.reference = undefined"
            >
              <Icon name="close" :size="11" /> clear
            </button>
          </template>
        </div>
        <div class="ab-hint">
          {{
            archify.reference
              ? 'archify reads that file first and carries over what is in it. The box above says what to make of it.'
              : ARCHIFY_TYPES.find((t) => t.type === archify.type)?.hint
          }}
        </div>
      </div>

      <div v-if="pickedCommand" class="cmd-hint" data-testid="diagram-command-hint">
        <span class="ch-args mono">{{ pickedCommand.argumentHint }}</span>
        <span class="ch-desc">{{ pickedCommand.description }}</span>
        <span v-if="commandTakesFileOnly" class="ch-note">
          Takes a file. To draw something new, clear this and describe it instead.
        </span>
        <button
          v-if="browsableCommand"
          type="button"
          class="ch-browse"
          data-testid="diagram-browse-file"
          :disabled="diagrams.generating"
          @click="browse()"
        >
          <Icon name="folder" :size="11" /> Browse…
        </button>
        <span v-if="refusedCommand" class="ch-refuse" data-testid="diagram-command-refused">
          Runs until Ctrl-C, and nothing can press it in a background session. Use
          <span class="mono">archify validate</span> or <span class="mono">archify deliver</span>.
        </span>
      </div>
      <div
        v-if="menuOpen"
        class="cmd-scrim"
        data-testid="diagram-command-scrim"
        @click="menuOpen = false"
      ></div>
      <div v-if="diagrams.error" class="err ui-err" data-testid="diagram-error">{{ diagrams.error }}</div>

      <MiniTerminal v-if="props.sessionId && !pending" :session-id="props.sessionId" label="running" />

      <div
        v-if="diagrams.generating && !pending"
        class="row pending ui-card is-warn"
        data-testid="diagram-starting"
        :aria-busy="true"
      >
        <div class="row-head">
          <span class="file">{{ description.trim() || 'diagram' }}</span>
          <span class="when">starting…</span>
        </div>
        <div class="desc">Starting the container session that will draw this.</div>
      </div>

      <div v-if="pending" class="row pending ui-card is-warn" data-testid="diagram-pending" :aria-busy="true">
        <div class="row-head">
          <span class="file mono">{{ pending.file }}</span>
          <span class="when">drawing…</span>
        </div>
        <div class="desc">{{ pending.description }}</div>
        <ol v-if="onArchify" class="steps" data-testid="archify-steps">
          <li
            v-for="(step, i) in ARCHIFY_STEPS"
            :key="step.key"
            class="step"
            :class="{ done: i < archifyStep, now: i === archifyStep }"
            :data-testid="`archify-step-${step.key}`"
          >
            <span class="step-mark" aria-hidden="true">{{ i < archifyStep ? '✓' : '·' }}</span>
            <span class="step-label">{{ step.label }}</span>
          </li>
        </ol>
        <MiniTerminal :session-id="pending.sessionId" label="drawing" />
      </div>

      <div v-if="list.length === 0 && !pending" class="empty ui-empty-line" data-testid="diagrams-empty">
        No diagrams yet. Generated diagrams are written to <span class="mono">{{ DIAGRAMS_DIR }}</span> in
        this project.
      </div>

      <div v-if="list.length > 0" class="table" data-testid="diagram-list">
        <div class="thead">
          <span>{{ DIAGRAMS_DIR }}</span><span class="r">modified</span>
        </div>
        <button
          v-for="d in list"
          :key="d.file"
          type="button"
          class="trow ui-row"
          :class="{ on: d.file === selected, 'is-selected': d.file === selected }"
          :data-testid="`diagram-row-${d.file}`"
          :title="`${d.file} — double-click to open in your browser`"
          @click="diagrams.select(projectId, d.file)"
          @dblclick="diagrams.open(projectId, d.file)"
        >
          <span class="nm">{{ d.file.replace(/\.html$/, '') }}</span>
          <span class="ag">{{ ago(d.modifiedAt) }}</span>
        </button>
      </div>
    </div>

    <aside v-if="list.length > 0" class="side" aria-label="Diagram preview">
      <div class="dock">
        <div class="mini">
          <iframe
            v-if="selectedHtml !== undefined"
            data-testid="diagram-frame"
            sandbox=""
            referrerpolicy="no-referrer"
            :title="selectedEntry?.file ?? 'diagram'"
            :srcdoc="selectedHtml"
          ></iframe>
          <div v-else class="frame-wait">reading…</div>
        </div>
        <div class="foot">
          <div class="foot-text">
            <span class="fn mono">{{ selectedEntry?.file ?? '—' }}</span>
            <div v-if="selectedEntry?.description" class="desc">{{ selectedEntry.description }}</div>
            <div v-if="selectedEntry?.plan" class="plan" data-testid="diagram-plan">
              <span v-if="selectedEntry.plan.type" class="pl mono ui-chip" data-testid="diagram-plan-type">
                <span class="pk">type</span>{{ selectedEntry.plan.type }}
              </span>
              <span v-if="selectedEntry.plan.pattern" class="pl mono ui-chip" data-testid="diagram-plan-pattern">
                <span class="pk">pattern</span>{{ selectedEntry.plan.pattern }}
              </span>
              <span v-if="selectedEntry.plan.size" class="pl mono ui-chip" data-testid="diagram-plan-size">
                <span class="pk">size</span>{{ selectedEntry.plan.size }}
              </span>
              <span
                v-for="cut in selectedEntry.plan.cuts"
                :key="cut"
                class="pl cut mono ui-chip"
                data-testid="diagram-plan-cut"
              >
                <span class="pk">cut</span>{{ cut }}
              </span>
            </div>
          </div>
          <span v-if="selectedEntry?.sessionId" class="chip ui-chip" :title="selectedEntry.sessionId">
            session <span class="mono">{{ selectedEntry.sessionId.slice(0, 8) }}</span>
          </span>
          <button v-if="selected" class="act" :data-testid="`diagram-open-${selected}`" @click="diagrams.open(projectId, selected)">
            <Icon name="external" :size="12" /> Open in browser
          </button>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.dgm {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
  padding: 12px 0 0 14px;
}

.bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.bar .in {
  flex: 1 1 100%;
  min-width: 0;
}

.bar .name-in {
  font-size: var(--fs-meta);
  color: var(--text-body);
}

.table {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 96px;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  box-shadow: var(--elev);
}

.thead,
.trow {
  display: grid;
  grid-template-columns: 1fr 58px;
  gap: 8px;
  align-items: baseline;
  padding: 4px 9px;
}

.thead {
  position: sticky;
  top: 0;
  background: var(--bg-sticky);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-meta);
}

.thead .r {
  text-align: right;
}

.trow {
  border-bottom: 1px solid var(--border-soft);
}

.trow .nm {
  font-family: var(--mono);
  font-size: var(--fs-meta);
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trow .ag {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.dock {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  box-shadow: var(--elev);
}

.mini {
  flex: 1 1 auto;
  align-self: stretch;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--diagram-page);
  border: 1px solid var(--border-card);
  border-radius: var(--rp);
}

.mini iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.intro {
  margin-bottom: 2px;
  font-size: var(--fs-micro);
  line-height: 1.5;
  color: var(--text-mid);
  text-wrap: pretty;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.engine {
  align-self: flex-start;
}

.archify-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.ab-row {
  display: flex;
  align-items: center;
  gap: 3px 6px;
  flex-wrap: wrap;
}

.ab-label {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-family: var(--sans);
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-faint);
}

.ab-label::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--border);
}

.ab-gap {
  flex: 1;
}

.ab-ref {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: var(--fs-micro);
  color: var(--text-body);
}

.steps {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 3px;
}

.step {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.step.done {
  color: var(--text-meta);
}

.step.now {
  color: var(--green);
}

.step-mark {
  flex-shrink: 0;
  width: 9px;
  font-family: var(--mono);
}

.ab-hint {
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-faint);
}

.install-card {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 6px 9px;
  margin-bottom: 6px;
  background: var(--bg-hover);
  border: 1px dashed var(--border-strong);
}

.install-text {
  flex: 1 1 100%;
  min-width: 0;
}

.install-title {
  font-size: var(--fs-micro);
  line-height: 1.45;
  color: var(--text-body);
}

.install-cmds {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  margin-top: 2px;
  overflow-wrap: anywhere;
}

.install-btn {
  flex: 0 0 auto;
  margin-left: auto;
  white-space: nowrap;
  background: var(--green);
  color: var(--green-ink);
  font-weight: var(--w-em);
  font-size: var(--fs-micro);
  padding: 3px 9px;
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
}

.install-btn:hover {
  background: var(--green-hover);
}

.in {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  font-size: var(--fs-ui);
  color: var(--text-body);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.in:focus {
  outline: none;
  border-color: var(--green);
}

.in:disabled {
  opacity: 0.6;
}

.add-btn {
  flex-shrink: 0;
  padding: 8px 15px;
  font-size: var(--fs-meta);
  font-weight: var(--w-em);
  color: var(--green-ink);
  background: var(--green);
  border-radius: var(--rc);
  cursor: pointer;
  white-space: nowrap;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: default;
  box-shadow: none;
}

.cmds {
  position: relative;
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}


.cmd-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 13px;
  font-size: var(--fs-meta);
  color: var(--text-body);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
  white-space: nowrap;
}

.cmd-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.cmd-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.cmd-menu {
  position: fixed;
  z-index: 30;
  width: 360px;
  max-width: calc(100vw - 16px);
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-card);
  border-radius: var(--r-panel);
  box-shadow: var(--shadow-overlay);
  animation: paletteIn var(--dur-panel-in) var(--ease-overlay);
}

@media (prefers-reduced-motion: reduce) {
  .cmd-menu {
    animation: none;
  }
}

.cmd-group + .cmd-group {
  margin-top: 6px;
}

.cmd-group-label {
  padding: 5px 9px 3px;
  font-family: var(--sans);
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-faint);
}

.cmd-item {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 7px 9px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--rc);
  cursor: pointer;
}

.cmd-item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.cmd-item:disabled {
  cursor: default;
  opacity: 0.55;
}

.cmd-name {
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.cmd-desc {
  font-size: var(--fs-meta);
  color: var(--text-mid);
  text-wrap: pretty;
}

.cmd-args {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.cmd-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px;
  font-size: var(--fs-micro);
}

.ch-args {
  color: var(--teal);
}

.ch-desc {
  color: var(--text-meta);
}

.ch-note {
  color: var(--amber);
}

.ch-browse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  font-size: var(--fs-micro);
  color: var(--text-mid);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  cursor: pointer;
}

.ch-browse:hover:not(:disabled) {
  border-color: var(--green);
  color: var(--text-strong);
}

.ch-browse:disabled {
  opacity: 0.45;
  cursor: default;
}

.ch-refuse {
  color: var(--amber);
}

.plan {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pl {
  font-family: var(--mono);
}

.pk {
  color: var(--text-ghost);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pl.cut {
  color: var(--amber);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
}

.cmd-missing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-micro);
  color: var(--amber);
}

.cmd-item.missing .cmd-name,
.cmd-item.missing .cmd-desc {
  color: var(--text-meta);
}

.cmd-item.inert .cmd-name,
.cmd-item.inert .cmd-desc {
  color: var(--text-faint);
}

.cmd-item.inert .cmd-missing {
  color: var(--text-faint);
}

.cmd-scrim {
  position: fixed;
  inset: 0;
  z-index: 20;
}

.err {
  max-width: 840px;
  margin-bottom: 8px;
}

.install-error {
  margin-top: 6px;
}

.empty {
  text-wrap: pretty;
}

.row {
  margin-bottom: 5px;
}

.frame-wait {
  height: 62vh;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-meta);
  color: var(--text-faint);
  border: 1px dashed var(--border-soft);
  border-radius: var(--rc);
}

.row-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.file {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.when {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.row .desc {
  margin-top: 2px;
}

.desc {
  margin-top: 5px;
  font-size: var(--fs-meta);
  color: var(--text-mid);
  line-height: 1.5;
  text-wrap: pretty;
}

.chip {
  flex-shrink: 0;
}

.act {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: var(--fs-meta);
  color: var(--text-body);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  cursor: pointer;
}

.act:hover {
  border-color: var(--green);
}
.rail > *:not(.table) {
  flex: none;
}

.rail {
  flex: 0 0 300px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 14px 12px 0;
  overflow-y: auto;
}

.side {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  padding: 0 14px 12px;
  border-left: 1px solid var(--border);
}

.foot {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 6px 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-soft);
}

.foot-text {
  flex: 1 1 150px;
  min-width: 0;
}

.foot .fn {
  display: block;
  font-size: var(--fs-micro);
  color: var(--text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot .desc {
  margin-top: 3px;
}

.foot .plan {
  margin-top: 6px;
}

.rail :deep(.mini-term) {
  margin-top: 4px;
}

.rail :deep(.mt-label) {
  margin-bottom: 2px;
}

.rail :deep(.mt-box) {
  height: 72px;
  padding: 4px 6px;
  border-radius: var(--sq);
}
</style>
