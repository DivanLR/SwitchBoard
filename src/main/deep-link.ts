// switchboard:// deep links and the Windows approval toast XML. Kept free of
// Electron imports so the parsing/escaping logic is unit-testable — the URL
// arrives from outside the app (protocol activation), so it is untrusted.

export const PROTOCOL_SCHEME = 'switchboard'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Windows toast XML for a permission/plan request: body click opens the inbox,
 * the Approve button approves in place. Both are protocol activations, so they
 * work whether or not the app window is around when clicked.
 */
export function buildApprovalToastXml(options: {
  requestId: string
  projectName: string
  kindLabel: string
  title: string
}): string {
  const approveUrl = `${PROTOCOL_SCHEME}://approve/${options.requestId}`
  const inboxUrl = `${PROTOCOL_SCHEME}://inbox/${options.requestId}`
  return (
    `<toast activationType="protocol" launch="${inboxUrl}">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(options.projectName)} needs you</text>` +
    `<text>${escapeXml(`${options.kindLabel}: ${options.title}`)}</text>` +
    `</binding></visual>` +
    `<actions>` +
    `<action content="Approve" activationType="protocol" arguments="${approveUrl}"/>` +
    `<action content="Open inbox" activationType="protocol" arguments="${inboxUrl}"/>` +
    `</actions>` +
    `</toast>`
  )
}

/**
 * Strictly parse a switchboard:// deep link. Anything but the two known verbs
 * with a UUID request id is rejected.
 */
export function parseDeepLink(url: string): { verb: 'approve' | 'inbox'; requestId: string } | null {
  const match = /^switchboard:\/\/(approve|inbox)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
    url.trim(),
  )
  if (!match) return null
  return { verb: match[1].toLowerCase() as 'approve' | 'inbox', requestId: match[2].toLowerCase() }
}
