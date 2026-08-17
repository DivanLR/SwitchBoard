// Diagrams section state per project: the folder listing (docs/diagrams) and the
// request to generate a new one. The store owns diagrams.* transport (view/
// transport separation), mirroring stores/specs.ts and stores/diff.ts.
import { reactive } from 'vue'
import type { DiagramEntry } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'

// Guards a keyed write in byProject against a stale response landing after a
// newer load superseded it. Not scoped to the project id, the same way
// specs.ts's token isn't: a fast project switch races a load(A) against a
// load(B), and the point is to drop whichever answer lost the race outright
// rather than let it land in byProject under its own (still-correct) key.
let loadToken = 0

const store = reactive({
  byProject: {} as Record<string, DiagramEntry[]>,
  loading: false,
  generating: false,
  /** The diagram asked for and not yet on disk, shown as a row on its way. The
   *  session is carried so the row can show that session's output while it
   *  draws, rather than a static "drawing…" for a minute. */
  pending: null as
    | { projectId: string; file: string; description: string; sessionId: string }
    | null,
  /** The diagram open in the preview pane. */
  selected: null as { projectId: string; file: string } | null,
  /** Read HTML, by file name. See select() for why it is kept rather than swapped. */
  html: {} as Record<string, string>,
  /** Set by a failed load or generate; cleared at the start of the next one. */
  error: null as string | null,

  forProject(projectId: string): DiagramEntry[] {
    return this.byProject[projectId] ?? []
  },

  async load(projectId: string): Promise<void> {
    const token = ++loadToken
    this.loading = true
    try {
      const list = await invoke('diagrams.list', { projectId })
      if (token !== loadToken) return // a newer load superseded this
      this.byProject[projectId] = list
      this.error = null
    } catch (e) {
      if (token !== loadToken) return
      this.error = errorMessage(e)
    } finally {
      if (token === loadToken) this.loading = false
    }
  },

  /**
   * Asks a BACKGROUND session for the diagram and waits for the file to appear.
   *
   * Nothing here switches to the conversation. The session that draws it is not
   * the chat one (see SessionManager.backgroundSessionFor), so there would be
   * nothing to watch even if it did: the developer asked for a diagram, and the
   * diagram turning up in the list is the whole answer.
   *
   * The file is polled for rather than pushed, because the app is not what
   * writes it — the session is, whenever it gets there. `pending` names the file
   * the app already chose, so the list can show the row as on its way instead of
   * showing nothing at all for a minute.
   */
  async generate(projectId: string, description: string): Promise<boolean> {
    this.generating = true
    this.error = null
    try {
      const { file, sessionId } = await invoke('diagrams.generate', { projectId, description })
      this.pending = { projectId, file, description, sessionId }
      void this.awaitFile(projectId, file)
      return true
    } catch (e) {
      this.error = errorMessage(e)
      return false
    } finally {
      this.generating = false
    }
  },

  /**
   * Polls the folder until the named file lands, then stops.
   *
   * Bounded on purpose: a session can fail, be interrupted, or decide to write
   * something else entirely, and a poll with no end would keep asking for ever.
   * When the budget runs out the row simply stops claiming to be on its way; the
   * file may still arrive, and the next ordinary load will show it.
   */
  async awaitFile(projectId: string, file: string): Promise<void> {
    const deadline = Date.now() + 20 * 60_000
    // This is the FALLBACK now, not the mechanism. push.diagramsChanged fires the
    // moment the drawing session's turn ends and applyChanged() below shows the
    // file then, so in the ordinary case this loop never gets to report anything.
    //
    // It stays because it answers two questions the push cannot: a session that
    // DIED (no turn end, so no push — see the fate check below) and a drawing that
    // never arrives at all, which is what the twenty-minute message is for.
    //
    // The cadence went back to a flat 2.5s. It had been backed off to 10s when
    // every round was a synchronous directory scan in the main process; that
    // handler is asynchronous now, so the traffic the back-off was buying against
    // is largely gone — and the back-off was paid for in the one place it is felt,
    // as up to ten seconds between a diagram landing and appearing. The deadline
    // stays WALL CLOCK (Date.now() vs deadline, never a loop count).
    const POLL_MS = 2500
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      // The developer switched project, or asked for something else: this poll
      // is no longer about anything on screen.
      if (this.pending?.projectId !== projectId || this.pending.file !== file) return

      // Did the session drawing this DIE? Polling for a file cannot tell the
      // difference between slow and dead, and this waited twenty minutes either
      // way. A real one crashed four minutes in — the container was killed with
      // exit 137, out of memory, having read a few dozen source files — and the
      // section went on claiming the drawing was on its way for the rest of the
      // wait, then blamed the twenty-minute budget. The session already knew, and
      // says why in its own words.
      // Asked of the session itself rather than looked up in the project list:
      // that list reports live rows and falls back to the newest ended one only
      // when there are none, so a background session that dies while the chat
      // session keeps running disappears from it and takes its cause of death
      // with it.
      const drawing = await invoke('sessions.fate', { sessionId: this.pending.sessionId }).catch(
        () => null,
      )
      if (drawing?.endedAt) {
        // One more read first: the file may have landed in the same beat the
        // session finished, and reporting a crash over a delivered diagram would
        // be the worse mistake.
        await this.load(projectId)
        if (this.forProject(projectId).some((d) => d.file === file)) {
          this.pending = null
          await this.select(projectId, file)
          return
        }
        this.error =
          drawing.statusDetail ??
          `The session drawing ${file} ended before it wrote anything. Open that session to see why, or ask again.`
        this.pending = null
        return
      }

      await this.load(projectId)
      if (this.forProject(projectId).some((d) => d.file === file)) {
        // It landed. Clearing `pending` here is what ends the wait: the file is
        // a real row in the list now, so the on-its-way row has nothing left to
        // say. Breaking without clearing it fell into the timeout branch below
        // and reported a five-minute failure the moment the diagram succeeded.
        this.pending = null
        // And SHOW it. The wait was for this one file, for however many minutes
        // it took; arriving into the list while the pane keeps showing whatever
        // was selected before — or nothing at all, on a project whose first
        // diagram this is — reads as the drawing having failed.
        await this.select(projectId, file)
        return
      }
    }
    // Say so. The row used to just disappear after five silent minutes, which
    // reads as the app having lost the request rather than having stopped
    // waiting for it. The file may still land; the next load will show it.
    if (this.pending?.file === file) {
      this.error = `${file} has not appeared after twenty minutes. The background session may still be drawing it, or it may have failed — open that session to see, or ask again.`
      this.pending = null
    }
  },

  /**
   * The folder as the main process just found it, pushed the instant the drawing
   * session's turn ended.
   *
   * This is what makes a finished diagram appear immediately instead of on the
   * next poll. It carries the whole listing, so nothing is fetched in response.
   *
   * It also resolves the pending row, and has to: the poll in awaitFile is what
   * used to notice the file and select it, and if the push gets there first that
   * loop would otherwise keep claiming the drawing is on its way until its own
   * next round. Selecting it is deliberate for the same reason the poll does it —
   * waiting minutes for one drawing and then having to hunt for it in the list
   * reads as the drawing having failed.
   */
  applyChanged(projectId: string, entries: DiagramEntry[]): void {
    this.byProject[projectId] = entries
    const waiting = this.pending
    if (!waiting || waiting.projectId !== projectId) return
    if (!entries.some((d) => d.file === waiting.file)) return
    this.pending = null
    void this.select(projectId, waiting.file)
  },

  async open(projectId: string, file: string): Promise<void> {
    try {
      await invoke('diagrams.open', { projectId, file })
    } catch (e) {
      this.error = errorMessage(e)
    }
  },

  /**
   * Selects a diagram and fetches its HTML for the preview pane.
   *
   * The html is held per file rather than as one "current" string so that
   * clicking back to a diagram already read shows it at once instead of
   * blanking the pane while the same bytes are fetched again.
   */
  async select(projectId: string, file: string): Promise<void> {
    this.selected = { projectId, file }
    if (this.html[file] !== undefined) return
    try {
      const { html } = await invoke('diagrams.read', { projectId, file })
      // The developer clicked something else while this was in flight.
      if (this.selected?.file !== file) return
      this.html[file] = html
    } catch (e) {
      this.error = errorMessage(e)
      this.selected = null
    }
  },
})

export const useDiagramsStore = (): typeof store => store
