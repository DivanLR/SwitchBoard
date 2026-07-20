// Desktop notifications (FR-013a, R9): raised when a session starts needing
// the developer while the window is unfocused, minimised, or hidden to tray.
// On Windows, permission/plan notifications carry an Approve button (custom
// toast XML with protocol activation — Electron's `actions` are macOS-only);
// clicking any part routes back through the switchboard:// deep link handler.
import { Notification } from 'electron'
import type { FocusRequestPush } from '@shared/ipc-types'
import { buildApprovalToastXml } from './deep-link'

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

    const projectName = deps.projectName(context.projectId)
    // Windows: approvable requests get action buttons via custom toast XML.
    const approvable =
      process.platform === 'win32' && context.requestId && context.kind !== 'question'
    const notification = new Notification({
      title: `${projectName} needs you`,
      body: `${KIND_LABEL[context.kind]}: ${context.title}`,
      silent: true,
      toastXml: approvable
        ? buildApprovalToastXml({
            requestId: context.requestId as string,
            projectName,
            kindLabel: KIND_LABEL[context.kind],
            title: context.title,
          })
        : undefined,
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
