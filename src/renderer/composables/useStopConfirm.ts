// Ctrl+C stop-confirm: the first Ctrl+C (composer focused, session working)
// shows a confirmation above the input; a second Ctrl+C (or the Stop button)
// actually interrupts. Auto-dismisses so a stray press never lingers.
// Extracted from SessionView so the view stays focused on rendering the stream.
import { onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter } from 'vue'
import type { Session } from '@shared/domain'

export function useStopConfirm(opts: {
  composerEl: MaybeRefOrGetter<HTMLTextAreaElement | null>
  liveSession: MaybeRefOrGetter<Session | null>
  /** Ctrl+C's second press (or the Stop button) — actually interrupt the turn. */
  interrupt: () => Promise<void>
}) {
  const stopConfirm = ref(false)
  let stopConfirmTimer: ReturnType<typeof setTimeout> | undefined

  function askStop(): void {
    stopConfirm.value = true
    clearTimeout(stopConfirmTimer)
    stopConfirmTimer = setTimeout(() => (stopConfirm.value = false), 4000)
  }
  function cancelStop(): void {
    stopConfirm.value = false
    clearTimeout(stopConfirmTimer)
  }
  async function confirmStop(): Promise<void> {
    cancelStop()
    await opts.interrupt()
  }

  // Ctrl+C only acts when the COMPOSER is focused (elsewhere it's a normal copy).
  // If text is selected it copies as usual; otherwise it opens the stop-confirm.
  function onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && stopConfirm.value) {
      cancelStop()
      return
    }
    if (!event.ctrlKey || (event.key !== 'c' && event.key !== 'C') || event.altKey || event.metaKey) {
      return
    }
    if (document.activeElement !== toValue(opts.composerEl)) return // must be in the text box
    const selection = window.getSelection()?.toString() ?? ''
    if (selection.length > 0) return // preserve copy of a selection
    const liveSession = toValue(opts.liveSession)
    if (!liveSession || liveSession.status !== 'working') return
    event.preventDefault()
    if (stopConfirm.value) void confirmStop()
    else askStop()
  }

  onMounted(() => {
    window.addEventListener('keydown', onGlobalKeydown)
  })
  onUnmounted(() => {
    clearTimeout(stopConfirmTimer)
    window.removeEventListener('keydown', onGlobalKeydown)
  })

  return {
    stopConfirm,
    askStop,
    cancelStop,
    confirmStop,
  }
}
