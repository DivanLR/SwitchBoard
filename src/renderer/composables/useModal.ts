import { onMounted, onUnmounted, type Ref } from 'vue'

/**
 * Makes a modal operable without a mouse: Escape closes it, Tab cycles inside it
 * rather than escaping to the window behind, focus lands in it on open, and the
 * element that opened it gets focus back on close.
 *
 * PRODUCT.md records keyboard operation as a product requirement. Before this,
 * none of the three modals could be closed or navigated from the keyboard at
 * all, which made them the hardest accessibility failure in the app: a trapped
 * user could not even back out.
 *
 * Pass the DIALOG element's ref (not the scrim's), so a click on the scrim still
 * closes through the caller's own `@click.self`. The caller owns the ref via
 * useTemplateRef so the template binding and the type checker agree.
 */
export function useModal(
  dialog: Readonly<Ref<HTMLElement | null>>,
  close: () => void,
): void {
  let previouslyFocused: HTMLElement | null = null

  /** Tabbable descendants, in document order, skipping anything hidden. */
  function tabbable(): HTMLElement[] {
    if (!dialog.value) return []
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    return [...dialog.value.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const items = tabbable()
    if (items.length === 0) {
      // Nothing to move to, so keep focus on the dialog rather than losing it
      // to the window behind.
      event.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    // Wrap at both ends. Without this, Tab walks out of the dialog and the user
    // is editing the window they cannot see.
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && (active === first || active === dialog.value)) {
      event.preventDefault()
      last.focus()
    }
  }

  onMounted(() => {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Focus the first real control, else the dialog itself so Escape still lands.
    const items = tabbable()
    if (items.length > 0) items[0].focus()
    else dialog.value?.focus()
    // Capture phase: a nested input that stops propagation must not swallow Escape.
    document.addEventListener('keydown', onKeydown, true)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown, true)
    previouslyFocused?.focus()
  })
}
