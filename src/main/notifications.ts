// Desktop notifications (FR-013a, R9): raised when a session starts needing
// the developer while the window is unfocused, minimised, or hidden to tray.
// Clicking shows the window and focuses the relevant inbox item or question.
import { Notification } from 'electron'
import type { FocusRequestPush } from '@shared/ipc-types'

export interface NotifierDeps {
  /** True when the window is visible and focused (no notification needed). */
  isWindowActive: () => boolean
  showWindow: () => void
  pushFocusRequest: (push: FocusRequestPush) => void
  notificationsEnabled: () => boolean
  projectName: (projectId: string) => string
}

export interface NeedsYouContext {
  projectId: string
  sessionId: string
  kind: 'permission' | 'plan' | 'question'
  requestId?: string
  eventId?: string
  title: string
}

const KIND_LABEL: Record<NeedsYouContext['kind'], string> = {
  permission: 'Permission request',
  plan: 'Plan approval',
  question: 'Question',
}

export function createNotifier(deps: NotifierDeps): (context: NeedsYouContext) => void {
  return (context) => {
    if (!deps.notificationsEnabled()) return
    if (deps.isWindowActive()) return
    if (!Notification.isSupported()) return

    const notification = new Notification({
      title: `${deps.projectName(context.projectId)} needs you`,
      body: `${KIND_LABEL[context.kind]}: ${context.title}`,
      silent: true,
    })
    notification.on('click', () => {
      deps.showWindow()
      if (context.kind === 'question') {
        deps.pushFocusRequest({
          target: 'session',
          sessionId: context.sessionId,
          eventId: context.eventId,
        })
      } else if (context.requestId) {
        deps.pushFocusRequest({ target: 'inbox', requestId: context.requestId })
      }
    })
    notification.show()
  }
}
