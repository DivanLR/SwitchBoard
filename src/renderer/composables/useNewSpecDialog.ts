// The "New spec" popup: type a short description and /speckit-specify runs it
// in the background session (output streams into the Session tab). Extracted
// from SpecsView so the view stays focused on rendering the spec itself, not
// on running a modal.
//
// Written directly against document/keydown rather than through useModal:
// useModal's onMounted moves focus into the dialog the moment it fires, which
// assumes the dialog element already exists by then. That holds for a modal
// that is its own component, but not here — this dialog is a v-if block inside
// a view that mounts once, well before the dialog exists. The textarea's own
// `autofocus` covers the on-open focus step instead; what is left, keeping Tab
// inside the dialog and letting Escape close it from anywhere, reuses
// useModal's trapTabWithin directly, the same reason Sidebar's overlays call
// it directly rather than through useModal.
import { onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import { trapTabWithin } from '@renderer/composables/useModal'
import { useSpecsStore } from '@renderer/stores/specs'

export function useNewSpecDialog(opts: {
  projectId: MaybeRefOrGetter<string>
  /** The dialog element. The caller owns it via useTemplateRef, so the template
   *  binding and the type checker agree — same convention as useModal's own
   *  `dialog` parameter. */
  dialog: Readonly<Ref<HTMLElement | null>>
  /** Fired once the /speckit-specify run is kicked off, so the caller can jump
   *  to the Session tab where its output streams. */
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
    if (!desc) return // empty Enter is a no-op, matching the disabled Create button
    showNewSpec.value = false
    await specs.runInSession(projectId(), `/speckit-specify ${desc}`, true)
    opts.onRan()
  }

  function cancelNewSpec(): void {
    showNewSpec.value = false
    newSpecDesc.value = ''
  }

  // Keeps Tab inside the new-spec dialog and lets Escape close it from anywhere,
  // not just from the textarea.
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
    // Capture phase: the textarea must not swallow Escape before we see it.
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
