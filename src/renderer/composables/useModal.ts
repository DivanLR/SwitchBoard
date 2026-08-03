import { onMounted, onUnmounted, type Ref } from 'vue'

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Tabbable descendants of `root`, in document order, skipping anything hidden. */
function tabbableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

/**
 * Keeps Tab inside `root`, wrapping at both ends.
 *
 * Shared rather than written per overlay: without a trap, Tab walks out and the
 * user is operating a window they cannot see, which matters most when what is
 * on top is a destructive confirmation. Exported because Sidebar's overlays are
 * `v-if` blocks in a component that mounts once, so they cannot use the
 * mount-time hook below and would otherwise keep a second copy of this.
 */
export function trapTabWithin(root: HTMLElement, event: KeyboardEvent): void {
  const items = tabbableIn(root)
  if (items.length === 0) {
    // Nothing to move to, so keep focus here rather than losing it to the
    // window behind.
    event.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  } else if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault()
    last.focus()
  } else if (!items.includes(active as HTMLElement) && active !== root) {
    // Focus was outside entirely (a click on the scrim, say): pull it back in
    // rather than letting Tab continue through the window behind.
    event.preventDefault()
    first.focus()
  }
}

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

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab' || !dialog.value) return
    trapTabWithin(dialog.value, event)
  }

  onMounted(() => {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Focus the first real control, else the dialog itself so Escape still lands.
    const items = dialog.value ? tabbableIn(dialog.value) : []
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
