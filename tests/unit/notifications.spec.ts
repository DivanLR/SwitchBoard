import { describe, expect, it, vi } from 'vitest'
import type { FocusRequestPush } from '@shared/ipc-types'

const shown: { options: { body: string; toastXml?: string }; click: () => void }[] = []

vi.mock('electron', () => ({
  Notification: class {
    static isSupported = (): boolean => true
    private click: () => void = () => {}
    constructor(private options: { body: string; toastXml?: string }) {}
    on(_event: string, listener: () => void): void {
      this.click = listener
    }
    show(): void {
      shown.push({ options: this.options, click: this.click })
    }
  },
}))

const { createNotifier } = await import('@main/notifications')

function notifier() {
  const focus: FocusRequestPush[] = []
  const notify = createNotifier({
    isWindowActive: () => false,
    showWindow: () => {},
    pushFocusRequest: (push) => focus.push(push),
    notificationsEnabled: () => true,
    projectName: () => 'alpha',
  })
  return { notify, focus }
}

describe('a sign-in or input notification', () => {
  it.each(['sign_in', 'input'] as const)('takes a %s click to its card in the Inbox, with no approve buttons', (kind) => {
    shown.length = 0
    const { notify, focus } = notifier()
    notify({ projectId: 'p1', sessionId: 's1', kind, requestId: 'eli-1', title: 'ado wants you to sign in' })
    expect(shown[0].options.toastXml).toBeUndefined()
    shown[0].click()
    expect(focus).toEqual([{ target: 'inbox', requestId: 'eli-1' }])
  })
})
