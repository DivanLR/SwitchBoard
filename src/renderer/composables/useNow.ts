import { onMounted, onUnmounted, readonly, ref, type Ref } from 'vue'

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
