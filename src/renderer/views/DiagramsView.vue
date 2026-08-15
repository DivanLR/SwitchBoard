<script setup lang="ts">
// Diagrams section: type what you want, the project's session hands it to the
// diagram-design plugin, and the plugin writes a standalone HTML file into the
// project's own docs/diagrams. Drawing one has no slash command — the skill
// activates on an ordinary request — but the plugin does ship commands for
// exporting and importing, and those are offered in the Commands menu.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
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
/** The command/description field, so picking a command can put the caret after it. */
const input = ref<HTMLInputElement | null>(null)

/**
 * A field holding a slash command is a command, not a description of a drawing.
 *
 * The one field does both because the alternative is a second input that is empty
 * and meaningless most of the time. The leading slash is the whole test, and it is
 * the same test the session's own composer applies.
 */
const isCommand = computed(() => description.value.trimStart().startsWith('/'))

async function generate(): Promise<void> {
  const text = description.value.trim()
  if (!text) return
  if (isCommand.value) {
    // Sent verbatim, including whatever was typed after the command. Picking a
    // command from the menu only writes it here; sending stays the developer's.
    emit('run', text)
    description.value = ''
    return
  }
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
function pickCommand(entry: (typeof commands.value)[number]): void {
  menuOpen.value = false
  const rest = description.value.replace(/^\s*\/\S*\s*/, '').trim()
  const argument = entry.takesDiagram && selected.value ? ` ${DIAGRAMS_DIR}/${selected.value}` : ''
  description.value = `/${DIAGRAM_PLUGIN.namespace}:${entry.command}${argument} ${rest}`.trimEnd() + ' '
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

/** Install from the command menu, for the case where the install card is not shown. */
function installFromMenu(): void {
  menuOpen.value = false
  emit('install')
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
  <div class="dgm" data-testid="diagrams-view">
    <div class="intro">
      Describe a diagram and the project's session will draw it with the diagram-design plugin, as a
      standalone HTML file in <span class="mono">{{ DIAGRAMS_DIR }}</span>.
    </div>

    <div v-if="!installed" class="install-card">
      <div class="install-text">
        <div class="install-title">
          diagram-design is not installed in this project — add it to generate diagrams
        </div>
        <div class="install-cmds mono">{{ DIAGRAM_PLUGIN.marketplace }} · {{ DIAGRAM_PLUGIN.pkg }}</div>
        <div v-if="installError" class="install-error" data-testid="diagrams-install-error">
          {{ props.installError }}
        </div>
      </div>
      <button class="install-btn" data-testid="diagrams-install" :disabled="props.installing" @click="emit('install')">
        <template v-if="props.installing">Installing…</template>
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
      <button class="add-btn" data-testid="diagram-generate" :disabled="diagrams.generating || !description.trim()" @click="generate()">
        <template v-if="diagrams.generating">Asking…</template>
        <template v-else-if="isCommand"><Icon name="chevron-right" :size="12" /> Send</template>
        <template v-else><Icon name="pencil" :size="12" /> Generate</template>
      </button>
      <div class="cmds">
        <button class="cmd-btn" data-testid="diagram-commands" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
          Commands <Icon name="chevron-down" :size="11" />
        </button>
        <div v-if="menuOpen" class="cmd-menu" data-testid="diagram-command-menu">
          <!-- A missing command installs the plugin instead of doing nothing. The
               big install card is deliberately suppressed once this project has
               diagrams (see `installed`), which left this menu as a dead end: it
               named three commands, said each was absent, and offered no way to
               fix that. Same action the card's button emits. -->
          <button
            v-for="c in commands"
            :key="c.command"
            class="cmd-item"
            :class="{ missing: !c.available }"
            :data-testid="`diagram-command-${c.command}`"
            :disabled="props.installing"
            @click="c.available ? pickCommand(c) : installFromMenu()"
          >
            <span class="cmd-name mono">/{{ c.command }}</span>
            <span class="cmd-desc">{{ c.description }}</span>
            <span class="cmd-args mono">{{ c.argumentHint }}</span>
            <span
              v-if="!c.available"
              class="cmd-missing"
              :data-testid="`diagram-install-hint-${c.command}`"
            >
              <Icon name="download" :size="11" />
              {{ props.installing ? 'installing…' : 'install diagram-design' }}
            </span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="menuOpen" class="cmd-scrim" @click="menuOpen = false"></div>
    <div v-if="diagrams.error" class="err" data-testid="diagram-error">{{ diagrams.error }}</div>

    <MiniTerminal v-if="props.sessionId && !pending" :session-id="props.sessionId" label="running" />

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
   and a tall one are framed the same way. */
/* Portrait, because these are HTML pages and a page is taller than it is wide.
   HEIGHT-BOUND: the frame takes its height from the pane and derives its width
   from the ratio, so it cannot overflow vertically at any window size;
   max-width guards the other axis. */
.mini {
  order: 1;
  flex: 1 1 auto;
  align-self: center;
  width: auto;
  max-width: 100%;
  min-height: 0;
  aspect-ratio: 1 / 1.414;
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
