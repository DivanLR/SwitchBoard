import { onMounted, onUnmounted, readonly, ref, type Ref } from 'vue'

/**
 * A `Date.now()` ref that re-reads on an interval, so anything derived from it
 * (session timers, "3m ago" stamps) re-renders on its own without a push.
 *
 * Shared because three views had hand-rolled the identical ref/setInterval/
 * clearInterval quartet, differing only in the interval, and each one is a
 * leaked timer if its cleanup is ever dropped. The interval stays a parameter
 * rather than a constant: the session timer counts seconds and must tick at 1s,
 * while the inbox only shows minute-grained ages and would waste four re-renders
 * out of five at that rate.
 *
 * Returned readonly: callers derive from it, and a caller that writes to it
 * would silently fight the interval.
 */
export function useNow(intervalMs: number): Readonly<Ref<number>> {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined

  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now()
    }, intervalMs)
  })

  onUnmounted(() => clearInterval(timer))

  return readonly(now)
}
