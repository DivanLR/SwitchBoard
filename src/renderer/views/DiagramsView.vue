<script setup lang="ts">
// Diagrams section: type what you want, the project's session hands it to the
// diagram-design plugin, and the plugin writes a standalone HTML file into the
// project's own docs/diagrams. Drawing one has no slash command — the skill
// activates on an ordinary request — but the plugin does ship commands for
// exporting and importing, and those are offered in the Commands menu.
import { computed, onMounted, ref, watch } from 'vue'
import { DIAGRAM_COMMANDS, DIAGRAM_PLUGIN, DIAGRAMS_DIR } from '@shared/diagram'
import { relativeTime } from '@renderer/relative-time'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'
import { useDiagramsStore } from '@renderer/stores/diagrams'
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

onMounted(() => void diagrams.load(props.projectId))
watch(() => props.projectId, (id) => void diagrams.load(id))

const description = ref('')

async function generate(): Promise<void> {
  const text = description.value.trim()
  if (!text) return
  // The drawing happens in a background session and the finished file turns up
  // in the list below, so there is nothing to switch to and nothing to watch.
  if (await diagrams.generate(props.projectId, text)) description.value = ''
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

const commands = computed(() =>
  DIAGRAM_COMMANDS.map((c) => ({
    ...c,
    available:
      props.available.length === 0 ||
      props.available.some(
        (name) => normalizeForMatch(name.slice(name.lastIndexOf(':') + 1)) === normalizeForMatch(c.command),
      ),
  })),
)

/**
 * Dispatches a command with the argument this section already knows.
 *
 * Every one of these takes a file. For the export that file is the diagram in
 * the pane, so it runs on what is on screen without anyone typing a path; for
 * the two importers the source is a file this app has never heard of, so
 * whatever is in the box is passed through and an empty box leaves the session
 * to ask — which is visible now, in the terminal below.
 */
function runCommand(entry: (typeof commands.value)[number]): void {
  menuOpen.value = false
  const typed = description.value.trim()
  const argument = typed || (entry.takesDiagram && selected.value ? `${DIAGRAMS_DIR}/${selected.value}` : '')
  emit('run', `/${DIAGRAM_PLUGIN.namespace}:${entry.command}${argument ? ` ${argument}` : ''}`)
  description.value = ''
}


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
  <div class="diagrams" data-testid="diagrams-view">
    <div class="intro">
      Describe a diagram and the project's session will draw it with the diagram-design plugin, as a
      standalone HTML file in <span class="mono">{{ DIAGRAMS_DIR }}</span
      >.
    </div>

    <div v-if="!installed" class="install-card">
      <div class="install-text">
        <div class="install-title">
          diagram-design is not installed in this project — add it to generate diagrams
        </div>
        <div class="install-cmds mono">{{ DIAGRAM_PLUGIN.marketplace }} · {{ DIAGRAM_PLUGIN.pkg }}</div>
        <!-- Named, not swallowed: this install used to fail silently, so the one
             thing it must never do again is look identical to doing nothing. -->
        <div v-if="installError" class="install-error" data-testid="diagrams-install-error">
          {{ props.installError }}
        </div>
      </div>
      <button
        class="install-btn"
        data-testid="diagrams-install"
        :disabled="props.installing"
        @click="emit('install')"
      >
        <template v-if="props.installing">Installing…</template>
        <template v-else><Icon name="download" :size="12" /> Download to project</template>
      </button>
    </div>

    <div class="add">
      <input
        v-model="description"
        class="in"
        data-testid="diagram-input"
        placeholder="What should the diagram show — e.g. the auth flow from login to session refresh"
        :disabled="diagrams.generating"
        @keydown.enter="generate()"
      />
      <button
        class="add-btn"
        data-testid="diagram-generate"
        :disabled="diagrams.generating || !description.trim()"
        @click="generate()"
      >
        <template v-if="diagrams.generating">Asking…</template>
        <template v-else><Icon name="pencil" :size="12" /> Generate</template>
      </button>

      <!-- What else this plugin can do. Drawing is the box to the left; these
           are its other three commands, which were previously reachable only by
           knowing they existed and typing one into the conversation. -->
      <div class="cmds">
        <button
          class="cmd-btn"
          data-testid="diagram-commands"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          Commands <Icon name="chevron-down" :size="11" />
        </button>
        <div v-if="menuOpen" class="cmd-menu" data-testid="diagram-command-menu">
          <button
            v-for="c in commands"
            :key="c.command"
            class="cmd-item"
            :data-testid="`diagram-command-${c.command}`"
            :disabled="!c.available"
            @click="runCommand(c)"
          >
            <span class="cmd-name mono">/{{ c.command }}</span>
            <span class="cmd-desc">{{ c.description }}</span>
            <span class="cmd-args mono">{{ c.argumentHint }}</span>
            <span v-if="!c.available" class="cmd-missing">not in this project</span>
          </button>
        </div>
      </div>
    </div>
    <!-- Click anywhere else to dismiss, without a document listener: the menu is
         the only thing that opens one, and it closes itself when it acts. -->
    <div v-if="menuOpen" class="cmd-scrim" @click="menuOpen = false"></div>
    <div v-if="diagrams.error" class="err" data-testid="diagram-error">{{ diagrams.error }}</div>

    <!-- A command runs in the section's own background session, which nobody
         opens, so its output belongs here. -->
    <MiniTerminal v-if="props.sessionId && !pending" :session-id="props.sessionId" label="running" />

    <!-- The row for a diagram that has been asked for and is not on disk yet. It
         names the file the app already chose, so the wait has something to point
         at rather than an empty list for a minute. -->
    <div
      v-if="pending"
      class="row pending"
      data-testid="diagram-pending"
      :aria-busy="true"
    >
      <div class="row-head">
        <span class="file mono">{{ pending.file }}</span>
        <span class="when mono">drawing…</span>
      </div>
      <div class="desc">{{ pending.description }}</div>
      <div class="row-meta">
        <span class="chip mono">running in the background</span>
      </div>
      <!-- The session drawing it is one the developer never opens, so without
           this the wait is a minute of a static word. -->
      <MiniTerminal :session-id="pending.sessionId" label="drawing" />
    </div>

    <div v-if="list.length === 0 && !pending" class="empty" data-testid="diagrams-empty">
      No diagrams yet. Generated diagrams are written to <span class="mono">{{ DIAGRAMS_DIR }}</span> in
      this project.
    </div>

    <!-- Two panes: what you have drawn, and the one you are looking at. The list
         is narrow on purpose — it is a way back to a diagram, not a report about
         one, so the detail sits under the picture instead of in every row. -->
    <div v-if="list.length > 0" class="split">
      <div class="past" data-testid="diagram-list">
        <button
          v-for="d in list"
          :key="d.file"
          type="button"
          class="past-row"
          :class="{ sel: d.file === selected }"
          :data-testid="`diagram-row-${d.file}`"
          :title="`${d.file} — double-click to open in your browser`"
          @click="diagrams.select(projectId, d.file)"
          @dblclick="diagrams.open(projectId, d.file)"
        >
          <span class="past-name mono">{{ d.file.replace(/\.html$/, '') }}</span>
          <span class="past-when mono">{{ ago(d.modifiedAt) }}</span>
        </button>
      </div>

      <div class="view">
        <div class="view-head">
          <span class="file mono">{{ selectedEntry?.file ?? '—' }}</span>
          <span class="spacer"></span>
          <span v-if="selectedEntry?.sessionId" class="chip mono" :title="selectedEntry.sessionId">
            session {{ selectedEntry.sessionId.slice(0, 8) }}
          </span>
          <button
            v-if="selected"
            class="act"
            :data-testid="`diagram-open-${selected}`"
            @click="diagrams.open(projectId, selected)"
          >
            <Icon name="external" :size="12" /> Open in browser
          </button>
        </div>
        <div v-if="selectedEntry?.description" class="desc">{{ selectedEntry.description }}</div>
        <!-- The diagram is HTML this app asked a model to write into the repo. It
             renders with scripts refused twice over: the frame carries no
             allow-scripts, and the app's own CSP (script-src 'self') applies to
             srcdoc content. A diagram that wanted to run code renders as the
             picture it is. Never add allow-scripts here. -->
        <iframe
          v-if="selectedHtml !== undefined"
          class="frame"
          data-testid="diagram-frame"
          sandbox=""
          referrerpolicy="no-referrer"
          :title="selectedEntry?.file ?? 'diagram'"
          :srcdoc="selectedHtml"
        ></iframe>
        <div v-else class="frame-wait mono">reading…</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagrams {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  max-width: 840px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 16px;
  text-wrap: pretty;
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
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
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
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
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

.cmd-missing {
  font-size: var(--fs-micro);
  color: var(--amber);
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
