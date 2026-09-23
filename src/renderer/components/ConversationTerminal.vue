<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { LineTone, RawLine } from '@shared/stream-lines'
import { useSettingsStore } from '@renderer/stores/settings'
import { useClipboardStore } from '@renderer/stores/clipboard'
import { xtermFontFamily, xtermFontSize, xtermTheme } from '@renderer/composables/xtermTheme'

const props = defineProps<{
  lines: readonly RawLine[]
  sessionKey: string
  live: boolean
  visible: boolean
  sending: boolean
}>()
const emit = defineEmits<{
  (e: 'send', text: string): void
  (e: 'interrupt'): void
  (e: 'shell'): void
}>()

const settingsStore = useSettingsStore()
const clipboard = useClipboardStore()
const host = ref<HTMLDivElement | null>(null)
const term = shallowRef<Terminal | null>(null)
const fit = shallowRef<FitAddon | null>(null)
const buffer = ref('')
let written = 0
let firstKey: string | null = null
let lastTailText: string | null = null
let inputRows = 1
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

const PROMPT = '❯ '

const TONE_ANSI: Record<LineTone, string> = {
  prompt: '\x1b[1;32m',
  text: '',
  tool: '\x1b[36m',
  result: '\x1b[2m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  err: '\x1b[31m',
  inject: '\x1b[2m',
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

const canType = computed(() => props.live && !props.sending)

function paint(line: RawLine): string {
  const stamp = line.stamp ? `${DIM}${line.stamp}${RESET} ` : ''
  const tone = TONE_ANSI[line.tone]
  return `${stamp}${tone}${line.text}${tone ? RESET : ''}`
}

function rowsFor(instance: Terminal, text: string): number {
  const cols = Math.max(1, instance.cols)
  return text
    .split('\n')
    .reduce((rows, part) => rows + Math.max(1, Math.ceil(part.length / cols)), 0)
}

function clearInputLine(instance: Terminal): void {
  if (inputRows > 1) instance.write(`\x1b[${inputRows - 1}A`)
  instance.write('\r\x1b[0J')
  inputRows = 1
}

function drawInputLine(instance: Terminal): void {
  if (!canType.value) {
    const note = props.live
      ? 'waiting for the session…'
      : 'this session has ended; nothing typed here is sent'
    inputRows = rowsFor(instance, note)
    instance.write(`${DIM}${note}${RESET}`)
    return
  }
  inputRows = rowsFor(instance, `${PROMPT}${buffer.value}`)
  instance.write(`\x1b[1;32m${PROMPT}${RESET}${buffer.value.replace(/\n/g, '\r\n')}`)
}

function writeAll(instance: Terminal): void {
  instance.reset()
  for (const line of props.lines) instance.write(`${paint(line)}\r\n`)
  written = props.lines.length
  firstKey = props.lines[0]?.key ?? null
  lastTailText = props.lines.at(-1)?.text ?? null
  inputRows = 1
  drawInputLine(instance)
}

function append(instance: Terminal): void {
  clearInputLine(instance)
  for (let i = written; i < props.lines.length; i += 1) instance.write(`${paint(props.lines[i])}\r\n`)
  written = props.lines.length
  lastTailText = props.lines.at(-1)?.text ?? null
  drawInputLine(instance)
}

function tailChanged(): boolean {
  return props.lines.length === written && (props.lines.at(-1)?.text ?? null) !== lastTailText
}

function sync(): void {
  const instance = term.value
  if (!instance) return
  const sameHead = props.lines.length > 0 && props.lines[0].key === firstKey
  if (props.lines.length < written || (written > 0 && !sameHead) || tailChanged()) {
    writeAll(instance)
  }
  else if (props.lines.length > written) append(instance)
  else {
    clearInputLine(instance)
    drawInputLine(instance)
  }
  instance.scrollToBottom()
}

function redrawInput(): void {
  const instance = term.value
  if (!instance) return
  clearInputLine(instance)
  drawInputLine(instance)
}

function submit(): void {
  const text = buffer.value.trim()
  if (!text || !canType.value) return
  buffer.value = ''
  emit('send', text)
}

function onData(data: string): void {
  if (data === '\r') {
    submit()
    return
  }
  if (data === '\x03') {
    if (buffer.value.length > 0) buffer.value = ''
    else emit('interrupt')
    redrawInput()
    return
  }
  if (data === '\x7f') {
    buffer.value = Array.from(buffer.value).slice(0, -1).join('')
    redrawInput()
    return
  }
  if (data.startsWith('\x1b')) return
  if (!canType.value) return
  buffer.value += data.replace(/\r\n?/g, '\n')
  redrawInput()
}

async function copySelection(): Promise<boolean> {
  const selection = term.value?.getSelection() ?? ''
  if (!selection) return false
  return clipboard.write(selection)
}

async function pasteIntoBuffer(): Promise<void> {
  const text = await clipboard.read()
  if (text && canType.value) {
    buffer.value += text.replace(/\r\n?/g, '\n')
    redrawInput()
  }
  term.value?.focus()
}

async function pushSize(): Promise<void> {
  if (!term.value || !fit.value || !props.visible) return
  if (!host.value?.clientWidth || !host.value.clientHeight) return
  fit.value.fit()
}

onMounted(() => {
  const instance = new Terminal({
    fontFamily: xtermFontFamily(),
    fontSize: xtermFontSize(settingsStore.settings?.fontSize),
    convertEol: false,
    cursorBlink: true,
    scrollback: 20_000,
    theme: xtermTheme(),
  })
  const fitAddon = new FitAddon()
  instance.loadAddon(fitAddon)
  term.value = instance
  fit.value = fitAddon
  if (host.value) instance.open(host.value)
  fitAddon.fit()
  instance.onData(onData)
  instance.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const key = event.key.toLowerCase()
    const paste =
      !event.altKey &&
      (((event.ctrlKey || event.metaKey) && key === 'v') ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && key === 'insert'))
    if (paste) {
      event.preventDefault()
      event.stopPropagation()
      void pasteIntoBuffer()
      return false
    }
    const copy =
      !event.altKey &&
      (((event.ctrlKey || event.metaKey) &&
        key === 'c' &&
        (event.shiftKey || event.metaKey || instance.hasSelection())) ||
        (event.ctrlKey && !event.shiftKey && key === 'insert'))
    if (copy) {
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
    instance.options.theme = xtermTheme()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  writeAll(instance)
  if (props.visible) instance.focus()
})

watch(() => props.lines, sync, { deep: false })
watch(() => props.sessionKey, () => {
  buffer.value = ''
  written = 0
  firstKey = null
  lastTailText = null
  if (term.value) writeAll(term.value)
})
watch([() => props.live, () => props.sending], redrawInput)
watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return
    await nextTick()
    await pushSize()
    term.value?.scrollToBottom()
    term.value?.focus()
  },
)
watch(
  () => settingsStore.settings?.fontSize,
  (size) => {
    if (!term.value) return
    term.value.options.fontSize = xtermFontSize(size)
    void pushSize()
  },
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  term.value?.dispose()
  term.value = null
})

function restore(text: string): void {
  buffer.value = text
  redrawInput()
}

defineExpose({ restore })

async function onContextMenu(): Promise<void> {
  const instance = term.value
  if (instance?.hasSelection()) {
    await copySelection()
    if (term.value === instance) instance.clearSelection()
    return
  }
  await pasteIntoBuffer()
}
</script>

<template>
  <div class="conv-term" data-testid="conversation-terminal">
    <div class="conv-bar ui-head">
      <div class="cb-meaning ui-meaning">
        <span class="cb-title" data-testid="conversation-terminal-title">
          {{ live ? 'Claude Code' : 'Claude Code (ended)' }}
        </span>
        <span class="cb-note">the same conversation as Clean and Raw · Enter sends · Ctrl+C interrupts</span>
      </div>
      <div class="ui-controls">
        <button
          type="button"
          class="btn-quiet"
          data-testid="conversation-terminal-shell"
          title="Open a real shell in this project instead"
          @click="emit('shell')"
        >
          Shell
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="conversation-terminal-copy"
          title="Copy selected text"
          @click="copySelection()"
        >
          Copy
        </button>
      </div>
    </div>
    <div
      ref="host"
      class="conv-host"
      data-testid="conversation-terminal-host"
      aria-label="Conversation, as a terminal"
      @contextmenu.prevent="onContextMenu()"
    ></div>
  </div>
</template>

<style scoped>
.conv-term {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  margin: var(--sp-5);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  overflow: hidden;
}

.conv-bar {
  flex-shrink: 0;
  padding: 10px 24px;
  margin-bottom: 0;
  background: var(--bg);
  border-bottom: 1px solid var(--border-soft);
}

.cb-meaning {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-title {
  color: var(--text-strong);
  white-space: nowrap;
}

.cb-note {
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-host {
  flex: 1;
  min-height: 0;
  padding: var(--pad-card);
  overflow: hidden;
}
</style>
