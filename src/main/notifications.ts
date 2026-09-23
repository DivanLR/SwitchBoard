import { Notification } from 'electron'
import type { FocusRequestPush } from '@shared/ipc-types'
import { buildApprovalToastXml } from './deep-link'

interface NotifierDeps {
  isWindowActive: () => boolean
  showWindow: () => void
  pushFocusRequest: (push: FocusRequestPush) => void
  notificationsEnabled: () => boolean
  projectName: (projectId: string) => string
}

interface NeedsYouContext {
  projectId: string
  sessionId: string
  kind: 'permission' | 'plan' | 'question' | 'sign_in' | 'input'
  requestId?: string
  eventId?: string
  title: string
}

const KIND_LABEL: Record<NeedsYouContext['kind'], string> = {
  permission: 'Permission request',
  plan: 'Plan approval',
  question: 'Question',
  sign_in: 'Sign in',
  input: 'Input request',
}

export function createNotifier(deps: NotifierDeps): (context: NeedsYouContext) => void {
  return (context) => {
    if (!deps.notificationsEnabled()) return
    if (deps.isWindowActive()) return
    if (!Notification.isSupported()) return

    const projectName = deps.projectName(context.projectId)
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
