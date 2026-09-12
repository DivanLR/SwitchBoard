import { onMounted, onUnmounted, type Ref } from 'vue'

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function tabbableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

export function trapTabWithin(root: HTMLElement, event: KeyboardEvent): void {
  const items = tabbableIn(root)
  if (items.length === 0) {
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
    event.preventDefault()
    first.focus()
  }
}

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
    const items = dialog.value ? tabbableIn(dialog.value) : []
    if (items.length > 0) items[0].focus()
    else dialog.value?.focus()
    document.addEventListener('keydown', onKeydown, true)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown, true)
    previouslyFocused?.focus()
  })
}
