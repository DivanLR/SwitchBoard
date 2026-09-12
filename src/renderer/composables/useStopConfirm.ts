import { onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter } from 'vue'
import type { Session } from '@shared/domain'

export function useStopConfirm(opts: {
  composerEl: MaybeRefOrGetter<HTMLTextAreaElement | null>
  liveSession: MaybeRefOrGetter<Session | null>
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

  function onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && stopConfirm.value) {
      cancelStop()
      return
    }
    if (!event.ctrlKey || (event.key !== 'c' && event.key !== 'C') || event.altKey || event.metaKey) {
      return
    }
    if (document.activeElement !== toValue(opts.composerEl)) return 
    const selection = window.getSelection()?.toString() ?? ''
    if (selection.length > 0) return 
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
