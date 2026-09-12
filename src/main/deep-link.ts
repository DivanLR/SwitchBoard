export const PROTOCOL_SCHEME = 'switchboard'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

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

export function parseDeepLink(url: string): { verb: 'approve' | 'inbox'; requestId: string } | null {
  const match = /^switchboard:\/\/(approve|inbox)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
    url.trim(),
  )
  if (!match) return null
  return { verb: match[1].toLowerCase() as 'approve' | 'inbox', requestId: match[2].toLowerCase() }
}
