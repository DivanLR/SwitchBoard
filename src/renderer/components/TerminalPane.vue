<script setup lang="ts">
// A real terminal: xterm.js over a pseudo-terminal running the developer's own
// shell in the project folder (see main/terminal/pty-host.ts).
//
// This is the one pane in the app that does NOT render Switchboard's event
// model. Nothing here parses, classifies or stores what appears — the bytes go
// from the shell to the emulator untouched, which is the whole point: it is what
// a terminal shows, not a reconstruction of it.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionEngine } from '@shared/domain'
import { useTerminalStore } from '@renderer/stores/terminal'

const props = defineProps<{
  /** Stable per project, so switching tabs re-attaches rather than restarting. */
  id: string
  cwd: string
  engine: SessionEngine | 'shell'
}>()

const terminals = useTerminalStore()
const host = ref<HTMLDivElement | null>(null)
// shallowRef: xterm owns a large mutable object graph, and making it reactive
// would have Vue walk a render buffer on every keystroke.
const term = shallowRef<Terminal | null>(null)
const fit = shallowRef<FitAddon | null>(null)
const exited = ref<number | null>(null)
const unsubscribes: (() => void)[] = []
let resizeObserver: ResizeObserver | null = null
/**
 * Which attach is the current one.
 *
 * `terminals.open()` is an await, and a project switch or an unmount can happen
 * while it is in flight. Without this the older call resumed afterwards, wrote
 * the PREVIOUS project's scrollback into the pane now showing another project,
 * and registered a listener that nothing would ever remove.
 */
let attachToken = 0

/**
 * The emulator's palette, taken from the app's own tokens rather than xterm's
 * defaults, so the terminal belongs to whichever theme is on. Read at mount and
 * on theme change: these are CSS variables, and xterm holds its own colours.
 */
function themeColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    background: value('--bg-code', '#0b0d0c'),
    foreground: value('--text-body', '#d5d8d4'),
    cursor: value('--green', '#7ee081'),
    selectionBackground: value('--bg-hover', '#1d201e'),
  }
}

async function pushSize(): Promise<void> {
  const instance = term.value
  if (!instance || !fit.value) return
  // A pane mid-transition reports a zero box; fitting to it throws inside xterm's
  // own renderer, so skip rather than clamp to something the shell would then
  // wrap against.
  if (!host.value?.clientWidth || !host.value.clientHeight) return
  fit.value.fit()
  await terminals.resize(props.id, instance.cols, instance.rows)
}

async function attach(): Promise<void> {
  const instance = term.value
  if (!instance) return
  const token = ++attachToken
  const id = props.id
  exited.value = null
  const { scrollback } = await terminals.open({
    id,
    cwd: props.cwd,
    cols: instance.cols,
    rows: instance.rows,
    engine: props.engine,
  })
  // Superseded while the open was in flight, or the pane is gone. Writing or
  // subscribing now would put one terminal's output into another's pane.
  if (token !== attachToken || term.value !== instance) return
  // What was already on screen before this pane existed. Written before the live
  // subscription so the order on screen matches the order it was produced in.
  if (scrollback) instance.write(scrollback)
  unsubscribes.push(terminals.onData(id, (data) => instance.write(data)))
  unsubscribes.push(
    terminals.onExit(id, (exitCode) => {
      exited.value = exitCode
    }),
  )
}

onMounted(async () => {
  const instance = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
    fontSize: 12,
    // The pty is the source of truth for what a key does. Echoing locally would
    // double every character the shell echoes back.
    convertEol: false,
    cursorBlink: true,
    scrollback: 10_000,
    theme: themeColors(),
  })
  const fitAddon = new FitAddon()
  instance.loadAddon(fitAddon)
  term.value = instance
  fit.value = fitAddon
  if (host.value) instance.open(host.value)
  fitAddon.fit()
  instance.onData((data) => void terminals.write(props.id, data))
  // Fit to the pane, not to the window: the sidebar collapses and the inbox
  // opens without the window ever changing size.
  resizeObserver = new ResizeObserver(() => void pushSize())
  if (host.value) resizeObserver.observe(host.value)
  await attach()
  instance.focus()
})

// A project switch is a different terminal, so the old subscription has to go
// before the new one is made — otherwise the previous project's output would
// keep arriving into this pane.
watch(
  () => props.id,
  async () => {
    for (const stop of unsubscribes.splice(0)) stop()
    term.value?.reset()
    await attach()
  },
)

onBeforeUnmount(() => {
  // Invalidates any attach still awaiting, so it cannot subscribe after this.
  attachToken += 1
  for (const stop of unsubscribes.splice(0)) stop()
  resizeObserver?.disconnect()
  resizeObserver = null
  // The pty is NOT killed here. Leaving the tab must not kill a build halfway
  // through; the terminal keeps running and the next visit re-attaches to it.
  term.value?.dispose()
  term.value = null
})

/** Start a fresh shell after the last one exited. */
async function restart(): Promise<void> {
  await terminals.close(props.id)
  term.value?.reset()
  await attach()
  term.value?.focus()
}
</script>

<template>
  <div class="terminal-pane" data-testid="terminal-pane">
    <div ref="host" class="terminal-host"></div>
    <div v-if="exited !== null" class="terminal-exit mono" data-testid="terminal-exited">
      Shell exited ({{ exited }}).
      <button type="button" class="btn-quiet" data-testid="terminal-restart" @click="restart()">
        Start a new one
      </button>
    </div>
  </div>
</template>

<style scoped>
.terminal-pane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-code);
  padding: 8px 10px;
}

.terminal-host {
  flex: 1;
  min-height: 0;
}

.terminal-exit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 2px 0;
  font-size: var(--fs-meta);
  color: var(--text-ghost);
}
</style>
