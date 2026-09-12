import { ref, toValue, type MaybeRefOrGetter } from 'vue'
import { errorMessage } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

export function useProjectRefs(opts: {
  projectId: MaybeRefOrGetter<string>
  onInsertPath: (path: string) => void
}) {
  const projects = useProjectsStore()
  const projectId = (): string => toValue(opts.projectId)

  const addingRef = ref(false)
  const refInput = ref('')
  const refError = ref<string | null>(null)

  async function commitRef(): Promise<void> {
    const target = refInput.value.trim()
    addingRef.value = false
    refInput.value = ''
    if (!target) return
    try {
      refError.value = null
      await projects.addRef(projectId(), target)
    } catch (e) {
      refError.value = errorMessage(e)
    }
  }

  function cancelRef(): void {
    addingRef.value = false
    refInput.value = ''
  }

  async function removeRef(path: string): Promise<void> {
    await projects.removeRef(projectId(), path)
  }

  const dragKind = ref<null | 'project' | 'file'>(null)

  function onPaneDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? []
    const kind = types.includes('text/x-sb-project')
      ? 'project'
      : types.includes('Files')
        ? 'file'
        : null
    if (!kind) return
    event.preventDefault()
    dragKind.value = kind
  }

  function onPaneDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null
    if (!related || !(event.currentTarget as Node).contains(related)) dragKind.value = null
  }

  async function onPaneDrop(event: DragEvent): Promise<void> {
    event.preventDefault()
    const kind = dragKind.value
    dragKind.value = null
    if (kind === 'project') {
      const path = event.dataTransfer?.getData('text/x-sb-project-path') ?? ''
      if (path) await projects.addRef(projectId(), path).catch(() => {})
    } else if (kind === 'file') {
      for (const item of [...(event.dataTransfer?.items ?? [])]) {
        if (item.kind !== 'file') continue
        const isDir = item.webkitGetAsEntry?.()?.isDirectory ?? false
        const file = item.getAsFile()
        const path = file ? window.switchboard.pathForFile?.(file) : undefined
        if (!path) continue
        if (isDir) {
          await projects.addRef(projectId(), path).catch(() => {})
        } else {
          opts.onInsertPath(path)
        }
      }
    }
  }

  return {
    addingRef,
    refInput,
    refError,
    commitRef,
    cancelRef,
    removeRef,
    dragKind,
    onPaneDragOver,
    onPaneDragLeave,
    onPaneDrop,
  }
}
