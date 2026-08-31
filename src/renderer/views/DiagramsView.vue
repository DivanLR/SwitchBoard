<script setup lang="ts">
// Diagrams section: type what you want, the project's session hands it to the
// diagram-design plugin, and the plugin writes a standalone HTML file into the
// project's own docs/diagrams. Drawing one has no slash command — the skill
// activates on an ordinary request — but the plugin does ship commands for
// exporting and importing, and those are offered in the Commands menu.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ARCHIFY,
  ARCHIFY_COMMANDS,
  ARCHIFY_PREFIX,
  ARCHIFY_TYPES,
  DEFAULT_ARCHIFY,
  DIAGRAM_COMMANDS,
  DIAGRAM_PLUGIN,
  DIAGRAMS_DIR,
  archifyCommandText,
  diagramCommandText,
  type ArchifyOptions,
  type ArchifyType,
} from '@shared/diagram'
import { relativeTime } from '@renderer/relative-time'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'
import { useDiagramsStore } from '@renderer/stores/diagrams'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSkillsStore } from '@renderer/stores/skills'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  projectId: string
  available: string[]
  /** The section's own background session, so a dispatched command is watchable. */
  sessionId?: string | null
  /** True while this plugin's host-side install is running. */
  installing?: boolean
  /** Why the install failed, in the CLI's own words. Null when it has not. */
  installError?: string | null
}>()

const emit = defineEmits<{ (e: 'install'): void; (e: 'run', command: string): void }>()

const diagrams = useDiagramsStore()
const settings = useSettingsStore()
const skills = useSkillsStore()

onMounted(() => {
  void diagrams.load(props.projectId)
  // The archify engine is a SKILL, so whether it is available is a question
  // about the imported-skills list rather than about the session's command list
  // this view is handed. Loaded here for the same reason SkillsView loads it:
  // the store is shared, and nothing else guarantees it has been fetched.
  void skills.load()
  // Guarded, as Sidebar.vue does it: App.vue already loads settings at startup,
  // and a second load would replace the store wholesale mid-edit.
  if (!settings.settings) void settings.load()
})
watch(() => props.projectId, (id) => void diagrams.load(id))

const description = ref('')
/** The command/description field, so picking a command can put the caret after it. */
const input = ref<HTMLInputElement | null>(null)

// ── WHICH ENGINE ────────────────────────────────────────────────────────────
//
// Two ways to draw, and they are not variations on one prompt. diagram-design is
// a plugin that activates on an ordinary request; archify is a skill wrapping a
// CLI that validates a typed specification against a schema and only then
// compiles it. So the choice changes the prompt, the commands in the menu, what
// counts as installed, and how it is installed.
//
// Kept in Settings rather than in this component: it is a preference about how
// the developer likes diagrams made, and it should survive leaving the tab.
const engine = computed(() => settings.settings?.diagramEngine ?? 'diagram-design')
const onArchify = computed(() => engine.value === 'archify')

function setEngine(next: 'diagram-design' | 'archify'): void {
  if (next === engine.value) return
  menuOpen.value = false
  void settings.save({ diagramEngine: next })
}

/**
 * What archify is told before it draws — the interactive part of the archify
 * path.
 *
 * Not persisted, and deliberately so. The type is a fact about the ONE diagram
 * being asked for, not a standing preference: a developer who drew a sequence
 * diagram this morning is no more likely to want another one now, and a sticky
 * type would quietly mis-draw the next request.
 */
const archify = ref<ArchifyOptions>({ ...DEFAULT_ARCHIFY })

const archifyInstalled = computed(() => skills.enabled.some((s) => s.name === ARCHIFY.skill))

/** Its own install path, because it is a skill and not a plugin: the Skills
 *  importer reads it over HTTPS, where `plugins.install` would shell out to
 *  `claude plugin` for a marketplace that does not carry it. */
const importingArchify = computed(() => skills.importing)

async function installArchify(): Promise<void> {
  menuOpen.value = false
  await skills.import(ARCHIFY.source)
}

/**
 * A field holding a slash command is a command, not a description of a drawing.
 *
 * The one field does both because the alternative is a second input that is empty
 * and meaningless most of the time. The leading slash is the whole test, and it is
 * the same test the session's own composer applies.
 *
 * archify adds the second form. Its subcommands are a CLI, not slash commands,
 * so there is no leading slash to test for and `archify ` is the marker instead
 * — which is also exactly what the developer would type by hand.
 */
const isPluginCommand = computed(() => description.value.trimStart().startsWith('/'))
const isArchifyCommand = computed(() =>
  description.value.trimStart().toLowerCase().startsWith(ARCHIFY_PREFIX),
)
const isCommand = computed(() => isPluginCommand.value || isArchifyCommand.value)

/**
 * The command currently in the box, when it is one of the two catalogues.
 *
 * Drives the hint under the bar. Every diagram-design command takes a FILE —
 * none of them draws anything — and the developer who has just picked one from a
 * menu headed "Commands" has no way to know that. The first real use of this
 * menu was `/export-diagram Generate a diagram of all my endpoints`, which is a
 * drawing request handed to the exporter.
 */
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

/** Only the plugin's commands take a file and draw nothing; archify's `deliver`
 *  and `render` very much do produce a diagram, so the warning would be wrong. */
const commandTakesFileOnly = computed(() => pickedCommand.value !== null && !isArchifyCommand.value)

/**
 * An archify command that must not be dispatched, currently in the box.
 *
 * The `sendable` flag used to be consulted in exactly one place — the Commands
 * menu's disabled button — which stopped it being PICKED and did nothing at all
 * about it being TYPED. `archify preview …` typed by hand went straight to a
 * background session, which is precisely the thing the flag exists to prevent:
 * preview watches a file on a loopback port and returns only on Ctrl-C, and
 * there is nobody at that session's keyboard to press it. The guard belongs on
 * the dispatch path, so it is here as well.
 */
const refusedCommand = computed(() => {
  if (!isArchifyCommand.value) return null
  const sub = (description.value.trim().split(/\s+/)[1] ?? '').toLowerCase()
  const entry = ARCHIFY_COMMANDS.find((c) => c.command === sub)
  return entry && !entry.sendable ? entry : null
})

async function generate(): Promise<void> {
  const text = description.value.trim()
  if (!text) return
  // Refused rather than silently dropped: the box keeps what was typed and the
  // hint under it says why. See refusedCommand.
  if (refusedCommand.value) return
  if (isArchifyCommand.value) {
    // Same rule as the plugin path below: what was typed is theirs, and this
    // only appends where the CLI lives and which folder is listed.
    emit('run', archifyCommandText(text))
    description.value = ''
    return
  }
  if (isPluginCommand.value) {
    // What the developer typed, plus one sentence naming this section's own
    // folder. It used to be sent truly verbatim, and the plugin then wrote to
    // its own default of docs/ — one directory above the only folder the list
    // below reads — so a drawing that succeeded showed up nowhere. Picking a
    // command from the menu only writes it here; sending stays the developer's.
    emit('run', diagramCommandText(text))
    description.value = ''
    return
  }
  // The drawing happens in a background session and the finished file turns up
  // in the list below, so there is nothing to switch to and nothing to watch.
  const options = onArchify.value ? { ...archify.value } : undefined
  if (await diagrams.generate(props.projectId, text, options)) description.value = ''
}

/** Shown only while it belongs to the project on screen. */
const pending = computed(() =>
  diagrams.pending?.projectId === props.projectId ? diagrams.pending : null,
)

// Newest first: what was just asked for is what a developer wants to check on.
const list = computed(() =>
  [...diagrams.forProject(props.projectId)].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
)

// Whether to keep quiet about installing anything.
//
// EVIDENCE FIRST. A project with diagrams in its folder, or one on its way,
// plainly can draw them, whatever a command list says — and the drawing runs in
// a container whose ~/.claude is its own and holds no plugins, so the probe is
// answering for an environment that is not the one doing the work. Offering to
// install underneath a list of finished diagrams reads as the app not knowing
// what it is showing.
//
// The probe still decides the empty case, and only once the folder has been
// read: before that the answer is not "missing", it is "not known yet", and a
// download card that appears for one frame and then leaves is worse than one
// that arrives a moment late.
const installed = computed(() => {
  // archify answers this question from a different place entirely. It is an
  // imported SKILL, so the app installed it itself and knows for certain
  // whether it is there — no probe, no "not known yet", and no evidence-first
  // guessing. The list below may well be full of diagrams the OTHER engine drew.
  if (onArchify.value) return archifyInstalled.value || skills.loading
  if (diagrams.byProject[props.projectId] === undefined) return true
  if (list.value.length > 0 || pending.value) return true
  if (props.available.length === 0) return true
  const key = normalizeForMatch(DIAGRAM_PLUGIN.probeCommand)
  // Match the command's OWN name, after the plugin namespace. A session reports
  // this skill as "diagram-design:export-diagram", and normalizeForMatch strips
  // the colon rather than the namespace, so the whole string reduces to
  // "diagramdesignexportdiagram" and never equalled the probe's
  // "exportdiagram". The card therefore claimed the plugin was missing on every
  // project that had it installed, and clicking Download re-installed something
  // already present, which changed nothing and looked broken.
  // CleanupView already does exactly this; the two now agree.
  return props.available.some((c) => normalizeForMatch(c.slice(c.lastIndexOf(':') + 1)) === key)
})

const ago = (iso: string): string => relativeTime(iso, Date.now())

/** The diagram in the preview pane, and its HTML once read. */
const selected = computed(() =>
  diagrams.selected?.projectId === props.projectId ? diagrams.selected.file : null,
)
const selectedHtml = computed(() => (selected.value ? diagrams.html[selected.value] : undefined))
const selectedEntry = computed(() => list.value.find((d) => d.file === selected.value) ?? null)

// THE COMMANDS MENU.
//
// Drawing a diagram is not a command — the skill activates on an ordinary
// request, which is why this section is a text box and not a list of buttons.
// The plugin does ship three commands, though, and until now the only way to
// reach them was to know they existed and type one into the conversation.
//
// Availability is reported per command rather than assumed from the plugin
// being installed, on the same rule the rest of the view follows: an empty
// command list means "not known yet", not "missing".
const menuOpen = ref(false)

interface MenuCommand {
  command: string
  description: string
  argumentHint: string
  available: boolean
  /** False for `preview`, which never returns. See ARCHIFY_COMMANDS. */
  sendable: boolean
}

const commands = computed<MenuCommand[]>(() => {
  // archify's availability is the skill's, once, for the whole catalogue: they
  // are subcommands of one binary, so either all of them can run or none can.
  // There is no per-command probe to do, and pretending otherwise would show
  // fourteen identical "missing" badges.
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

/**
 * Writes the command into the box, in front of whatever is being typed, and sends
 * nothing.
 *
 * It used to dispatch on click, which made picking a command and composing the
 * message it needs two different acts in two different orders: anything typed
 * afterwards was a new, separate request, and anything typed BEFORE was silently
 * swallowed as the command's argument. Now the menu writes and the developer
 * sends, so what runs is what is on screen.
 *
 * The path is filled in for a command that takes the diagram in the pane, because
 * that is the argument the section already knows and typing it back by hand proves
 * nothing. Everything after the command survives, so a half-typed message is not
 * lost by opening the menu.
 */
function pickCommand(entry: MenuCommand): void {
  menuOpen.value = false
  if (onArchify.value) {
    // Its subcommands are argv, not slash commands, so the whole `archify …`
    // line is rewritten rather than a leading token replaced. The selected
    // diagram is offered to the two that take a delivered HTML file, on the
    // same rule as the plugin path: the section already knows that argument.
    const wantsHtml = entry.command === 'check' || entry.command === 'visual-check'
    const argument = wantsHtml && selected.value ? ` ${DIAGRAMS_DIR}/${selected.value}` : ''
    description.value = `${ARCHIFY_PREFIX}${entry.command}${argument} `
  } else {
    const rest = description.value.replace(/^\s*\/\S*\s*/, '').trim()
    const takesDiagram = DIAGRAM_COMMANDS.find((c) => c.command === entry.command)?.takesDiagram
    const argument = takesDiagram && selected.value ? ` ${DIAGRAMS_DIR}/${selected.value}` : ''
    description.value = `/${DIAGRAM_PLUGIN.namespace}:${entry.command}${argument} ${rest}`.trimEnd() + ' '
  }
  // Focus with the caret at the END, after the render that carries the new value.
  // Without this the field keeps the caret at 0 and the next keystroke lands in
  // FRONT of the command, which turns the whole line back into a description and
  // draws a diagram called "--png-only/diagram-design:export-diagram".
  void nextTick(() => {
    const field = input.value
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  })
}

/** Install from the command menu, for the case where the install card is not
 *  shown. Each engine has its own installer: a plugin marketplace for one, the
 *  app's Skills importer for the other. */
function installFromMenu(): void {
  if (onArchify.value) {
    void installArchify()
    return
  }
  menuOpen.value = false
  emit('install')
}

/** True while whichever installer this engine uses is running. */
const installBusy = computed(() =>
  onArchify.value ? importingArchify.value : props.installing === true,
)


// Opening the tab on a project that already has diagrams shows one rather than an
// empty pane. The newest is the one most likely to be the reason you came here.
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
    <!-- Which engine draws. Two genuinely different tools, not two skins on one:
         diagram-design activates on a sentence, archify validates a typed
         specification against a schema and only then compiles it. The choice
         changes the prompt, the commands below, and what "installed" means. -->
    <div class="engine" data-testid="diagram-engine">
      <button
        type="button"
        class="eng"
        :class="{ on: !onArchify }"
        data-testid="diagram-engine-diagram-design"
        :aria-pressed="!onArchify"
        title="The diagram-design plugin: describe a drawing and it draws it."
        @click="setEngine('diagram-design')"
      >
        diagram-design
      </button>
      <button
        type="button"
        class="eng"
        :class="{ on: onArchify }"
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

    <div v-if="!installed" class="install-card">
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
        <!-- Two different installers, so two different error sources. The plugin's
             comes back from the host CLI through the parent; archify's is the
             Skills importer's own, which the store already holds. -->
        <div
          v-if="onArchify ? skills.error : installError"
          class="install-error"
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
      <!-- One button, two jobs, and it says which: a field holding a slash command
           sends that command, and anything else describes a drawing. -->
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
        <button class="cmd-btn" data-testid="diagram-commands" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
          Commands <Icon name="chevron-down" :size="11" />
        </button>
        <div v-if="menuOpen" class="cmd-menu" data-testid="diagram-command-menu">
          <!-- A missing command installs the engine instead of doing nothing. The
               big install card is deliberately suppressed once this project has
               diagrams (see `installed`), which left this menu as a dead end: it
               named three commands, said each was absent, and offered no way to
               fix that. Same action the card's button takes. -->
          <button
            v-for="c in commands"
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
            <!-- `preview` is listed and refused rather than hidden. It watches a
                 file on a loopback port and returns only on Ctrl-C, and these
                 commands run in a background session with nobody at the keyboard:
                 sending it would hold that session open until it was killed. -->
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
    <!-- THE INTERACTIVE BAR. archify commits to one of five types before it
         draws, and the five draw genuinely different pictures, so the type is
         asked for rather than inferred from a sentence. Hidden while a command
         is in the box: a command carries its own arguments and none of this
         applies to it. -->
    <div v-if="onArchify && !isCommand" class="archify-bar" data-testid="archify-options">
      <div class="ab-row">
        <span class="ab-label">type</span>
        <button
          v-for="t in ARCHIFY_TYPES"
          :key="t.type"
          type="button"
          class="ab-chip"
          :class="{ on: archify.type === t.type }"
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
          class="ab-chip"
          :class="{ on: archify.quality === 'showcase' }"
          data-testid="archify-quality-showcase"
          :aria-pressed="archify.quality === 'showcase'"
          title="archify's own authoring default: all nine artifact checks, no warnings."
          @click="archify.quality = 'showcase'"
        >
          showcase
        </button>
        <button
          type="button"
          class="ab-chip"
          :class="{ on: archify.quality === 'standard' }"
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
          class="ab-chip"
          :class="{ on: archify.motion }"
          data-testid="archify-motion"
          role="switch"
          :aria-checked="archify.motion"
          title="Turn on the viewer extras: traced motion and a few guided chapters. Off by default, which is the skill's own rule."
          @click="archify.motion = !archify.motion"
        >
          <Icon name="play" :size="11" /> interactive viewer
        </button>
      </div>
      <div class="ab-hint">
        {{ ARCHIFY_TYPES.find((t) => t.type === archify.type)?.hint }}
      </div>
    </div>

    <!-- What the command in the box actually takes. Sits under the bar rather than
         in the placeholder, because by the time a command is in the field the
         placeholder is gone. -->
    <div v-if="pickedCommand" class="cmd-hint mono" data-testid="diagram-command-hint">
      <span class="ch-args">{{ pickedCommand.argumentHint }}</span>
      <span class="ch-desc">{{ pickedCommand.description }}</span>
      <span v-if="commandTakesFileOnly" class="ch-note">
        Takes a file. To draw something new, clear this and describe it instead.
      </span>
      <!-- Says why the button will not go, rather than leaving a dead control.
           Typed by hand this is the only warning there is: the menu's disabled
           row never appeared. -->
      <span v-if="refusedCommand" class="ch-refuse" data-testid="diagram-command-refused">
        Runs until Ctrl-C, and nothing can press it in a background session. Use
        <span class="mono">archify validate</span> or <span class="mono">archify deliver</span>.
      </span>
    </div>
    <div v-if="menuOpen" class="cmd-scrim" @click="menuOpen = false"></div>
    <div v-if="diagrams.error" class="err" data-testid="diagram-error">{{ diagrams.error }}</div>

    <MiniTerminal v-if="props.sessionId && !pending" :session-id="props.sessionId" label="running" />

    <!-- The gap between pressing Generate and having something to watch.
         `diagrams.generate` cannot return a session id until one exists, and the
         session it uses is containerised, so on the first diagram of a run that
         wait is a container starting: long enough that the section looked
         inert, with nothing on screen claiming the button had done anything. -->
    <div
      v-if="diagrams.generating && !pending"
      class="row pending"
      data-testid="diagram-starting"
      :aria-busy="true"
    >
      <div class="row-head">
        <span class="file mono">{{ description.trim() || 'diagram' }}</span>
        <span class="when mono">starting…</span>
      </div>
      <div class="desc">Starting the container session that will draw this.</div>
    </div>

    <div v-if="pending" class="row pending" data-testid="diagram-pending" :aria-busy="true">
      <div class="row-head">
        <span class="file mono">{{ pending.file }}</span>
        <span class="when mono">drawing…</span>
      </div>
      <div class="desc">{{ pending.description }}</div>
      <MiniTerminal :session-id="pending.sessionId" label="drawing" />
    </div>

    <div v-if="list.length === 0 && !pending" class="empty" data-testid="diagrams-empty">
      No diagrams yet. Generated diagrams are written to <span class="mono">{{ DIAGRAMS_DIR }}</span> in
      this project.
    </div>

    <!-- The explorer stretches; the diagram itself renders in a bounded rectangle
         docked beside it. Chosen in live mode over a rail-and-stage split and a
         tile grid; the tile grid lost because its thumbnails can only render a
         diagram the store has already read, so most tiles would sit empty. -->
    <div v-if="list.length > 0" class="body">
      <div class="table" data-testid="diagram-list">
        <div class="thead">
          <span>{{ DIAGRAMS_DIR }}</span><span class="r">modified</span>
        </div>
        <button
          v-for="d in list"
          :key="d.file"
          type="button"
          class="trow"
          :class="{ on: d.file === selected }"
          :data-testid="`diagram-row-${d.file}`"
          :title="`${d.file} — double-click to open in your browser`"
          @click="diagrams.select(projectId, d.file)"
          @dblclick="diagrams.open(projectId, d.file)"
        >
          <span class="nm">{{ d.file.replace(/\.html$/, '') }}</span>
          <span class="ag">{{ ago(d.modifiedAt) }}</span>
        </button>
      </div>
      <div class="dock">
        <span class="fn mono">{{ selectedEntry?.file ?? '—' }}</span>
        <div class="mini">
          <!-- Scripts refused twice over: no allow-scripts on the frame, and the
               app's own CSP (script-src 'self') reaches srcdoc content. Never add
               allow-scripts here. -->
          <iframe
            v-if="selectedHtml !== undefined"
            data-testid="diagram-frame"
            sandbox=""
            referrerpolicy="no-referrer"
            :title="selectedEntry?.file ?? 'diagram'"
            :srcdoc="selectedHtml"
          ></iframe>
          <div v-else class="frame-wait mono">reading…</div>
        </div>
        <div v-if="selectedEntry?.description" class="desc">{{ selectedEntry.description }}</div>
        <!-- What the session decided before it drew. The diagram-design skill states
             its type, semantic pattern, size preset and the cuts the complexity
             budget forced, then draws; that message used to scroll past in the
             transcript and the section kept only a file name. It is the one thing
             that says what the picture was TRYING to be, which is what you need in
             order to judge whether it succeeded. -->
        <div v-if="selectedEntry?.plan" class="plan" data-testid="diagram-plan">
          <span v-if="selectedEntry.plan.type" class="pl mono" data-testid="diagram-plan-type">
            <span class="pk">type</span>{{ selectedEntry.plan.type }}
          </span>
          <span v-if="selectedEntry.plan.pattern" class="pl mono" data-testid="diagram-plan-pattern">
            <span class="pk">pattern</span>{{ selectedEntry.plan.pattern }}
          </span>
          <span v-if="selectedEntry.plan.size" class="pl mono" data-testid="diagram-plan-size">
            <span class="pk">size</span>{{ selectedEntry.plan.size }}
          </span>
          <!-- Cuts are the honest half: what would not fit. Kept last and marked,
               because "this drawing omits X" is a caveat, not a specification. -->
          <span
            v-for="cut in selectedEntry.plan.cuts"
            :key="cut"
            class="pl cut mono"
            data-testid="diagram-plan-cut"
          >
            <span class="pk">cut</span>{{ cut }}
          </span>
        </div>
        <!-- Which session drew it. Dropped by the accepted live variant and
             restored here: a diagram is an artefact of a particular run, and the
             run is how you find what was asked for. -->
        <span v-if="selectedEntry?.sessionId" class="chip mono" :title="selectedEntry.sessionId">
          session {{ selectedEntry.sessionId.slice(0, 8) }}
        </span>
        <button v-if="selected" class="act" :data-testid="`diagram-open-${selected}`" @click="diagrams.open(projectId, selected)">
          <Icon name="external" :size="12" /> Open in browser
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The section stretches to the pane rather than scrolling as one long column:
   the explorer owns the scroll, so the composer bar and the docked preview stay
   put while a long list moves under them. Chosen in live mode.

   These rules live HERE, in the SFC's own style block, and not in a <style> tag
   inside <template>. That is not a preference: Vue's compiler rejects a template
   containing <style> outright ("Tags with side effect (<script> and <style>) are
   ignored in client component templates"), so a preview stylesheet written into
   the template breaks the component every time. See CLAUDE.md. */
.dgm {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 0;
}

.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar .in {
  flex: 1;
  min-width: 0;
}

/* Explorer left, bounded preview docked right. The dock stays beside rather than
   under: baked from the accepted variant's parameter values. */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding-bottom: 12px;
}

.table {
  /* Narrow on purpose: this is a way back to a diagram, not a report about one,
     so it gives its width to the page being read. Widened 200px -> 240px on the
     owner's direction: at 200 the longer generated filenames were ellipsing, and
     a list you cannot read names in is not a way back to anything. */
  flex: 0 0 240px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  box-shadow: var(--elev);
}

.thead,
.trow {
  display: grid;
  grid-template-columns: 1fr 84px;
  gap: 10px;
  align-items: baseline;
  /* 6px is the accepted "snug" row height, substituted for the parameter. */
  padding: 6px 11px;
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
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border-soft);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.trow:hover {
  background: var(--bg-hover);
}

.trow.on {
  background: var(--bg-active);
}

.trow .nm {
  font-family: var(--mono);
  font-size: var(--fs-meta);
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trow .ag,
.trow .sz {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  /* Figures in a column are compared, so they line up. */
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.dock {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* The filename reads as a caption under the page, not a heading over it. */
.dock .fn {
  order: 2;
  text-align: center;
}

.dock .fn {
  font-size: var(--fs-micro);
  color: var(--text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The bounded rectangle the diagram renders into. Fixed aspect so a wide drawing
   and a tall one are framed the same way.

   LANDSCAPE, at a browser's proportions rather than a sheet of paper's. It was
   A4 portrait on the reasoning that these are pages, which had the ratio right
   for printing and wrong for reading: the file is a standalone HTML page opened
   in a browser, drawn by a skill whose own size presets are `doc-wide`,
   `slide-16x9` and `print-a4-landscape` — every one of them wider than tall. A
   portrait frame squeezed a landscape drawing into the middle third and left
   bands of empty page down both sides.

   16 / 10 rather than 16 / 9: it is the shape of a browser VIEWPORT, which is a
   window minus its chrome, and this frame is showing exactly that.

   Still HEIGHT-BOUND. The frame takes its height from the pane and derives its
   width from the ratio, so it cannot overflow vertically at any window size, and
   max-width guards the other axis. That is what keeps it inside the small area
   rather than growing to fill the pane. */
.mini {
  order: 1;
  flex: 1 1 auto;
  align-self: center;
  width: auto;
  max-width: 100%;
  min-height: 0;
  aspect-ratio: 16 / 10;
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
  max-width: 840px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 16px;
  text-wrap: pretty;
}

/* Two engines, one segmented control. A segmented control rather than a dropdown
   because there are exactly two and both names matter: which one drew a diagram
   is the first thing you want to know when it comes out wrong. */
.engine {
  flex: none;
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 2px;
  background: var(--bg-seg);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
}

.eng {
  padding: 3px 11px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-tab);
  background: none;
  border: none;
  border-radius: var(--rp);
  cursor: pointer;
}

.eng:hover {
  color: var(--text-strong);
}

.eng.on {
  color: var(--text-strong);
  background: var(--bg-card);
  box-shadow: var(--elev);
}

/* The interactive bar. Chips rather than a <select>, because the hint under them
   changes with the choice and a native select cannot show that while it is open —
   and the whole reason the type is asked for is that the developer may not know
   which of the five they want. */
.archify-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 840px;
  padding: 9px 11px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.ab-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.ab-label {
  min-width: 46px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.ab-gap {
  flex: 1;
}

.ab-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  font-size: var(--fs-micro);
  color: var(--text-meta);
  background: transparent;
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  cursor: pointer;
}

.ab-chip:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

/* --green, not --green-ink. The ink token is the colour that sits ON a solid
   green fill (#FFFFFF light, #0E1013 dark); over --bg-chip, which is a 5% wash
   and therefore essentially the page, it is white-on-white in the light theme.
   A wash background takes the foreground colour, not its ink. */
.ab-chip.on {
  color: var(--green);
  background: var(--bg-chip);
  border-color: var(--green);
}

/* archify's own words for the chosen type, from its type router. It is the one
   line that stops the choice being six names with no meaning.

   No hanging indent to line it up under the chips: .ab-row wraps, and the moment
   it does there is no single column to align to — the indent was only ever right
   for the unwrapped case. Flush left is right in both. */
.ab-hint {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.install-card {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 840px;
  padding: 13px 15px;
  margin-bottom: 16px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
}

.install-text {
  flex: 1;
  min-width: 0;
}

.install-title {
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.install-cmds {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  margin-top: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.install-btn {
  flex-shrink: 0;
  white-space: nowrap;
  background: var(--green);
  color: var(--green-ink);
  font-weight: var(--w-em);
  font-size: var(--fs-meta);
  padding: 8px 15px;
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
}

.install-btn:hover {
  background: var(--green-hover);
}

.add {
  display: flex;
  gap: 8px;
  max-width: 840px;
  margin-bottom: 8px;
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
  flex-shrink: 0;
}

.cmd-btn {
  padding: 8px 13px;
  font-size: var(--fs-meta);
  color: var(--text-body);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
  white-space: nowrap;
}

.cmd-btn:hover {
  border-color: var(--border-strong);
}

/* Brings its own ground, like every other menu in the app (.ctx-menu): it
   floats over the list rather than sitting in it. */
.cmd-menu {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 30;
  min-width: 360px;
  /* archify lists fourteen commands, each three lines tall. Unbounded, the menu
     ran past the bottom of the window and the tail was unreachable — the bar
     sits near the top of the view, so opening upwards would be worse. Cap and
     scroll. */
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  box-shadow: var(--elev);
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

/* A refusal, not a caution: the button is disabled and this says why. Amber is
   earned here — the reading is "this command cannot run from here". */
.ch-refuse {
  color: var(--amber);
}

/* The plan strip: facts about the drawing, set as data rather than prose. */
.plan {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  font-size: var(--fs-micro);
  color: var(--text-body);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rp);
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

/* An absent command is still a live row: it installs. Dimming it the way a
   disabled control is dimmed would say the opposite. */
.cmd-item.missing .cmd-name,
.cmd-item.missing .cmd-desc {
  color: var(--text-meta);
}

/* `preview` IS installed and does work — just not from a background session with
   nobody to press Ctrl-C. Dimmed rather than hidden, so the menu still says what
   the tool can do, and its note says why this is the one row that will not go. */
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
  font-size: var(--fs-meta);
  color: var(--red);
}

/* Sits inside the install card rather than beside it: the reason an install
   failed belongs with the thing that failed, not in the page's error slot. */
.install-error {
  margin-top: 6px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.empty {
  max-width: 840px;
  font-size: var(--fs-ui);
  color: var(--text-faint);
  text-wrap: pretty;
}

.row {
  max-width: 840px;
  padding: 11px 13px;
  margin-bottom: 9px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

/* On its way: the same row, quieter, so its arrival is a change of state
   rather than a new thing appearing. */
.row.pending {
  border-style: dashed;
  opacity: 0.8;
}

/* Same rationale as the split comment above: a narrow way back, not a report. */
.split {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  min-height: 0;
}

.past {
  flex-shrink: 0;
  width: 210px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 70vh;
  overflow-y: auto;
}

.past-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--rc);
  cursor: pointer;
}

.past-row:hover {
  background: var(--bg-hover);
}

.past-row.sel {
  background: var(--bg-active);
}

.past-name {
  font-size: var(--fs-meta);
  color: var(--text-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.past-row.sel .past-name {
  color: var(--green);
}

.past-when {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.view {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.view-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

/* White ground under the frame whatever the theme: the diagram is a document
   with its own page colour, and letting the carbon sheet show through its
   margins would read as part of the drawing. The token is theme-invariant by
   design — see --diagram-page in styles.css. */
.frame {
  width: 100%;
  height: 62vh;
  background: var(--diagram-page);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
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

.desc {
  margin-top: 5px;
  font-size: var(--fs-meta);
  color: var(--text-mid);
  line-height: 1.5;
  text-wrap: pretty;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 8px;
}

.chip {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  border-radius: var(--rp);
  padding: 1px 9px;
  white-space: nowrap;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
}

.spacer {
  flex: 1;
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
</style>
