import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { isSddSlug, sddSlug } from '@shared/sdd'
import { trapTabWithin } from '@renderer/composables/useModal'
import { errorMessage } from '@renderer/ipc'
import { useToastsStore } from '@renderer/stores/toasts'

export interface SddPrompt {
  command: string
  title: string
  hint: string
  placeholder: string
  slug: boolean
}

export function useNewSpecDialog(opts: {
  dialog: Readonly<Ref<HTMLElement | null>>
  onSubmit: (prompt: SddPrompt, text: string, slug: string | null) => Promise<void>
}) {
  const prompt = ref<SddPrompt | null>(null)
  const text = ref('')
  const slug = ref('')
  const slugEdited = ref(false)

  watch(text, (value) => {
    if (!slugEdited.value) slug.value = sddSlug(value)
  })

  const slugValid = computed(() => !prompt.value?.slug || isSddSlug(slug.value))
  const ready = computed(() => text.value.trim().length > 0 && slugValid.value)

  function open(next: SddPrompt): void {
    text.value = ''
    slug.value = ''
    slugEdited.value = false
    prompt.value = next
  }

  function editSlug(value: string): void {
    slugEdited.value = true
    slug.value = value
  }

  function cancel(): void {
    prompt.value = null
  }

  async function submit(): Promise<void> {
    const current = prompt.value
    const body = text.value.trim()
    if (!current || !ready.value) return
    prompt.value = null
    try {
      await opts.onSubmit(current, body, current.slug ? slug.value : null)
    } catch (error) {
      useToastsStore().show('error', 'Could not start that command', errorMessage(error))
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!prompt.value) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancel()
      return
    }
    if (event.key === 'Tab' && opts.dialog.value) trapTabWithin(opts.dialog.value, event)
  }

  onMounted(() => document.addEventListener('keydown', onKeydown, true))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown, true))

  return { prompt, text, slug, slugValid, ready, open, editSlug, cancel, submit }
}
