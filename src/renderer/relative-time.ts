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
/**
 * Elapsed time since `iso` as a zero-padded HH:MM:SS clock, for a running timer.
 *
 * Sits beside relativeTime because it answers the same question in the other
 * register: this one is for a session that is still going and wants a stopwatch,
 * relativeTime is for something finished and wants the coarsest honest unit.
 * Shared rather than per-component because the sidebar lane and the session
 * header render the SAME session's timer, and two copies could disagree about
 * the same instant.
 *
 * `nowMs` is a plain argument for the reason given above: pass a ticking ref's
 * value to animate, or Date.now() for a one-shot read.
 *
 * (stream-lines.ts keeps its own HH:MM gutter formatter on purpose — it is
 * Vue-free and must not import renderer code.)
 */
export function elapsedClock(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
}

export function relativeTime(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
