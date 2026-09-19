<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionEngine, Settings } from '@shared/domain'
import { useTerminalStore } from '@renderer/stores/terminal'
import { useSettingsStore } from '@renderer/stores/settings'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useClipboardStore } from '@renderer/stores/clipboard'
import { errorMessage } from '@renderer/ipc'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  id: string
  cwd: string
  engine: SessionEngine
  resumeSessionId: string | null
  live: boolean
  visible: boolean
}>()
const emit = defineEmits<{ (e: 'takeover'): void }>()

const terminals = useTerminalStore()
const launchEngine = computed((): SessionEngine | 'shell' =>
  props.resumeSessionId ? props.engine : 'shell',
)
const launched = ref<SessionEngine | 'shell'>('shell')
const takingOver = ref(false)
const settingsStore = useSettingsStore()
const host = ref<HTMLDivElement | null>(null)
const term = shallowRef<Terminal | null>(null)
const fit = shallowRef<FitAddon | null>(null)
const exited = ref<number | null>(null)
const connecting = ref(false)
const failure = ref<string | null>(null)
const ready = computed(() => !connecting.value && !failure.value && exited.value === null)
const unsubscribes: (() => void)[] = []
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let attachToken = 0

function themeColors(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: token('--bg-code'),
    foreground: token('--text-body'),
    cursor: token('--green'),
    cursorAccent: token('--bg-code'),
    selectionBackground: token('--bg-hover'),
    black: token('--term-black'),
    red: token('--term-red'),
    green: token('--term-green'),
    yellow: token('--term-yellow'),
    blue: token('--term-blue'),
    magenta: token('--term-magenta'),
    cyan: token('--term-cyan'),
    white: token('--term-white'),
    brightBlack: token('--term-bright-black'),
    brightRed: token('--term-bright-red'),
    brightGreen: token('--term-bright-green'),
    brightYellow: token('--term-bright-yellow'),
    brightBlue: token('--term-bright-blue'),
    brightMagenta: token('--term-bright-magenta'),
    brightCyan: token('--term-bright-cyan'),
    brightWhite: token('--term-bright-white'),
  }
}

const FONT_SCALE: Record<Settings['fontSize'], number> = { sm: 11, md: 12, lg: 13.5 }

function fontSize(): number {
  return FONT_SCALE[settingsStore.settings?.fontSize ?? 'md']
}

const activeSession = useActiveSessionStore()
const clipboard = useClipboardStore()
const FULL_SCREEN_KEY = 'terminal'
const isFullScreen = computed(() => activeSession.fullScreenSection === FULL_SCREEN_KEY)

function toggleFullScreen(): void {
  activeSession.setFullScreen(isFullScreen.value ? null : FULL_SCREEN_KEY)
  term.value?.focus()
}

async function copySelection(): Promise<boolean> {
  const selection = term.value?.getSelection() ?? ''
  if (!selection) return false
  return clipboard.write(selection)
}

async function pasteIntoTerminal(): Promise<void> {
  if (!ready.value) return
  const token = attachToken
  const text = await clipboard.read()
  if (token !== attachToken || !ready.value || !props.visible) return
  if (text) term.value?.paste(text)
  term.value?.focus()
}

async function writeInput(data: string): Promise<void> {
  if (!ready.value) return
  try {
    await terminals.write(props.id, data)
  } catch (error) {
    failure.value = errorMessage(error)
  }
}

async function pushSize(): Promise<void> {
  const instance = term.value
  if (!instance || !fit.value || !props.visible) return
  if (!host.value?.clientWidth || !host.value.clientHeight) return
  try {
    fit.value.fit()
    if (ready.value) await terminals.resize(props.id, instance.cols, instance.rows)
  } catch (error) {
    failure.value = errorMessage(error)
  }
}

async function attach(): Promise<void> {
  const instance = term.value
  if (!instance) return
  const token = ++attachToken
  const id = props.id
  for (const stop of unsubscribes.splice(0)) stop()
  connecting.value = true
  failure.value = null
  exited.value = null
  let pending: string[] | null = []
  unsubscribes.push(
    terminals.onData(id, (data) => {
      if (token !== attachToken) return
      if (pending) pending.push(data)
      else instance.write(data)
    }),
  )
  unsubscribes.push(
    terminals.onExit(id, (exitCode) => {
      if (token !== attachToken) return
      exited.value = exitCode
    }),
  )
  try {
    const engine = launchEngine.value
    const { scrollback } = await terminals.open({
      id,
      cwd: props.cwd,
      cols: instance.cols,
      rows: instance.rows,
      engine,
      resumeSessionId: props.resumeSessionId ?? undefined,
    })
    if (token !== attachToken || term.value !== instance) return
    launched.value = engine
    if (scrollback) instance.write(scrollback)
    for (const data of pending) instance.write(data)
    pending = null
  } catch (error) {
    if (token === attachToken) failure.value = errorMessage(error)
  } finally {
    if (token === attachToken) connecting.value = false
  }
  if (token === attachToken) await pushSize()
}

onMounted(async () => {
  const instance = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
    fontSize: fontSize(),
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
  instance.onData((data) => void writeInput(data))
  instance.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const key = event.key.toLowerCase()
    const pasteShortcut =
      !event.altKey &&
      (((event.ctrlKey || event.metaKey) && key === 'v') ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && key === 'insert'))
    if (pasteShortcut) {
      event.preventDefault()
      event.stopPropagation()
      void pasteIntoTerminal()
      return false
    }
    const copyShortcut =
      !event.altKey &&
      (((event.ctrlKey || event.metaKey) &&
        key === 'c' &&
        (event.shiftKey || event.metaKey || instance.hasSelection())) ||
        (event.ctrlKey && !event.shiftKey && key === 'insert'))
    if (copyShortcut) {
      event.preventDefault()
      event.stopPropagation()
      void copySelection().then((ok) => {
        if (ok && term.value === instance) instance.clearSelection()
      })
      return false
    }
    return true
  })
  resizeObserver = new ResizeObserver(() => void pushSize())
  if (host.value) resizeObserver.observe(host.value)
  themeObserver = new MutationObserver(() => {
    instance.options.theme = themeColors()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  window.addEventListener('keydown', onFullScreenKey, true)
  await attach()
  if (props.visible) instance.focus()
})

function onFullScreenKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isFullScreen.value) {
    event.preventDefault()
    event.stopPropagation()
    activeSession.setFullScreen(null)
  }
}

async function onContextMenu(): Promise<void> {
  const instance = term.value
  if (instance?.hasSelection()) {
    await copySelection()
    if (term.value === instance) instance.clearSelection()
    return
  }
  await pasteIntoTerminal()
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      if (isFullScreen.value) activeSession.setFullScreen(null)
      return
    }
    await nextTick()
    await pushSize()
    term.value?.focus()
  },
)

watch(
  () => settingsStore.settings?.fontSize,
  () => {
    const instance = term.value
    if (!instance) return
    instance.options.fontSize = fontSize()
    void pushSize()
  },
)

watch(
  () => props.id,
  async () => {
    takingOver.value = false
    for (const stop of unsubscribes.splice(0)) stop()
    term.value?.reset()
    await attach()
  },
)

function takeover(): void {
  takingOver.value = true
  emit('takeover')
}

watch(
  () => props.resumeSessionId,
  (id) => {
    if (!id || !takingOver.value) return
    takingOver.value = false
    void restart()
  },
)

watch(
  () => props.live,
  (live) => {
    if (live) takingOver.value = false
  },
)

const canContinue = computed(
  () => !props.live && !!props.resumeSessionId && launched.value === 'shell' && ready.value,
)

onBeforeUnmount(() => {
  attachToken += 1
  for (const stop of unsubscribes.splice(0)) stop()
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
  window.removeEventListener('keydown', onFullScreenKey, true)
  if (isFullScreen.value) activeSession.setFullScreen(null)
  term.value?.dispose()
  term.value = null
})

async function restart(): Promise<void> {
  if (connecting.value) return
  const id = props.id
  const token = ++attachToken
  connecting.value = true
  for (const stop of unsubscribes.splice(0)) stop()
  try {
    await terminals.close(id)
    if (token !== attachToken || !term.value) return
    term.value.reset()
    await attach()
    if (props.visible) term.value?.focus()
  } catch (error) {
    if (token === attachToken) {
      failure.value = errorMessage(error)
      connecting.value = false
    }
  }
}
</script>

<template>
  <div class="terminal-pane" :class="{ full: isFullScreen }" data-testid="terminal-pane">
    <div class="terminal-bar mono">
      <Icon name="terminal" :size="15" />
      <span class="tb-title" data-testid="terminal-title">{{
        launched === 'shell' ? 'Shell' : launched === 'codex' ? 'Codex CLI' : 'Claude Code'
      }}</span>
      <span class="tb-path" :title="cwd">{{ cwd }}</span>
      <span class="tb-spacer"></span>
      <template v-if="live">
        <span class="tb-note" data-testid="terminal-live-note">Session running in Clean and Raw</span>
        <button
          type="button"
          class="terminal-action"
          data-testid="terminal-takeover"
          :disabled="takingOver"
          title="End the session in Clean and Raw and carry the same conversation on here, in the real CLI. Clean and Raw keep the history up to this point and offer Resume to take it back."
          @click="takeover()"
        >
          {{ takingOver ? 'Handing over…' : 'Continue it here' }}
        </button>
      </template>
      <button
        v-else-if="canContinue"
        type="button"
        class="terminal-action"
        data-testid="terminal-continue"
        title="Open the ended session's conversation in this terminal with --resume."
        @click="restart()"
      >
        Continue the ended session here
      </button>
      <button
        type="button"
        class="terminal-action"
        title="Copy selected terminal text"
        @click="copySelection()"
      >
        Copy
      </button>
      <button
        type="button"
        class="terminal-action"
        :disabled="!ready"
        title="Paste clipboard text (Ctrl+V or Ctrl+Shift+V)"
        @click="pasteIntoTerminal()"
      >
        Paste
      </button>
      <button
        type="button"
        class="terminal-action"
        title="Clear the visible terminal scrollback"
        @click="term?.clear()"
      >
        Clear
      </button>
      <button
        type="button"
        class="terminal-action"
        data-testid="terminal-full-screen"
        :aria-pressed="isFullScreen ? 'true' : 'false'"
        :title="
          isFullScreen
            ? 'Give the sidebar and inbox back (or press Escape)'
            : 'Hide the sidebar, inbox and header, and give the terminal the whole window'
        "
        @click="toggleFullScreen"
      >
        {{ isFullScreen ? 'Exit full screen' : 'Full screen' }}
      </button>
    </div>
    <div
      ref="host"
      class="terminal-host"
      aria-label="Interactive terminal"
      @contextmenu.prevent="onContextMenu()"
    ></div>
    <div v-if="connecting" class="terminal-exit mono" role="status">Connecting to terminal…</div>
    <div
      v-if="failure"
      class="terminal-exit terminal-error"
      role="alert"
      data-testid="terminal-error"
    >
      <span>{{ failure }}</span>
      <button type="button" class="btn-quiet" :disabled="connecting" @click="restart()">
        Retry
      </button>
    </div>
    <div v-if="exited !== null" class="terminal-exit mono" data-testid="terminal-exited">
      Shell exited ({{ exited }}).
      <button
        type="button"
        class="btn-quiet"
        :disabled="connecting"
        data-testid="terminal-restart"
        @click="restart()"
      >
        Start a new one
      </button>
    </div>
    <div class="terminal-footer mono">
      <span class="terminal-state" :class="{ connected: ready }">{{
        connecting
          ? 'Connecting'
          : failure
            ? 'Connection error'
            : exited !== null
              ? 'Exited'
              : 'Connected'
      }}</span>
      <span
        class="tb-hint"
        title="Paste: Ctrl+V, Ctrl+Shift+V or Shift+Insert. Copy: select text and press Ctrl+C. Ctrl+C without a selection interrupts the command."
        >Ctrl+Shift+C copy · Ctrl+V paste · Ctrl+C interrupt</span
      >
    </div>
  </div>
</template>

<style scoped>
.terminal-pane {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-code);
  margin: 12px 16px 16px;
  border: 1px solid var(--border-code);
  border-radius: var(--rc);
  overflow: hidden;
}

.terminal-pane.full {
  margin: 0;
  border: none;
  border-radius: 0;
}

.terminal-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  flex-shrink: 0;
  flex-wrap: wrap;
  background: var(--bg-card-alt);
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.tb-title {
  color: var(--text-strong);
  white-space: nowrap;
}

.tb-path {
  min-width: 40px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tb-note {
  color: var(--text-faint);
  white-space: nowrap;
}

.terminal-action {
  padding: 4px 6px;
  border-radius: var(--rp);
  white-space: nowrap;
}

.terminal-action:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-hover);
}

.terminal-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.terminal-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-soft);
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.terminal-state {
  flex-shrink: 0;
}

.terminal-state.connected {
  color: var(--green);
}

.tb-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tb-spacer {
  flex: 1;
}

.terminal-host {
  flex: 1;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
}

.terminal-exit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: var(--fs-meta);
  color: var(--text-ghost);
}

.terminal-error {
  color: var(--red);
  overflow-wrap: anywhere;
}
</style>
