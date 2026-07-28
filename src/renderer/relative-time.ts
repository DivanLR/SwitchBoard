/**
 * How long ago an ISO timestamp was, in the shortest honest unit.
 *
 * Replaces two divergent copies: the inbox had seconds/minutes/hours with
 * Math.floor against a live-ticking ref, and the MCP view had
 * minutes/hours/days with Math.round against Date.now(). Same job, two answers
 * for the same instant.
 *
 * `nowMs` is a plain argument rather than an options object precisely so this
 * stays one function with no configuration: a caller with a ticking `now` ref
 * passes `now.value` and re-renders on its own schedule, and a caller that only
 * needs the value once passes `Date.now()`.
 *
 * Floor throughout, so nothing ever reads as older than it is.
 */
export function relativeTime(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
