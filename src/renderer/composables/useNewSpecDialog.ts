import { onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import { trapTabWithin } from '@renderer/composables/useModal'
import { errorMessage } from '@renderer/ipc'
import { useSpecsStore } from '@renderer/stores/specs'
import { useToastsStore } from '@renderer/stores/toasts'

export function useNewSpecDialog(opts: {
  projectId: MaybeRefOrGetter<string>
  dialog: Readonly<Ref<HTMLElement | null>>
  onRan: () => void
}) {
  const specs = useSpecsStore()
  const projectId = (): string => toValue(opts.projectId)

  const showNewSpec = ref(false)
  const newSpecDesc = ref('')

  function newSpec(): void {
    newSpecDesc.value = ''
    showNewSpec.value = true
  }

  async function submitNewSpec(): Promise<void> {
    const desc = newSpecDesc.value.trim()
    if (!desc) return 
    showNewSpec.value = false
    try {
      await specs.createSpec(projectId(), desc)
    } catch (e) {
      useToastsStore().show('error', 'Could not start the spec', errorMessage(e))
      return
    }
    opts.onRan()
  }

  function cancelNewSpec(): void {
    showNewSpec.value = false
    newSpecDesc.value = ''
  }

  function onNewSpecKeydown(event: KeyboardEvent): void {
    if (!showNewSpec.value) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancelNewSpec()
      return
    }
    if (event.key !== 'Tab' || !opts.dialog.value) return
    trapTabWithin(opts.dialog.value, event)
  }

  onMounted(() => {
    document.addEventListener('keydown', onNewSpecKeydown, true)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onNewSpecKeydown, true)
  })

  return {
    showNewSpec,
    newSpecDesc,
    newSpec,
    submitNewSpec,
    cancelNewSpec,
  }
}
