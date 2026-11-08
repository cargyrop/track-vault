import { useEscape } from '../hooks/useEscape'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEffect, useRef, useState } from 'react'
import type { SourceRole, TrackWithSources } from '../lib/types'
import {
  checkLinksOnce,
  ISSUES_PLAYLIST,
  planLinkHealth,
  type LinkRemoval,
} from '../lib/linkHealth'
import { probeLink } from '../lib/linkProbe'

interface Props {
  open: boolean
  onClose: () => void
  /** The whole library, unfiltered — rot hides behind filters otherwise. */
  onListTracks: () => Promise<TrackWithSources[]>
  /** Cuts one dead source slot from a track, the Main included. */
  onRemoveSource: (trackId: number, role: SourceRole) => Promise<void>
  /** Files tracks under the top-level Issues playlist, creating it if needed. */
  onFileIssues: (
    trackIds: number[],
  ) => Promise<{ playlistId: number; created: boolean; added: number }>
  /** One refresh when the run finishes, so every view catches up. */
  onRefresh: () => void
  /** Opens the repair path: the track card, where links are pasted by hand. */
  onOpenCard: (track: TrackWithSources) => void
}

type Phase =
  | { name: 'checking'; done: number; total: number }
  | { name: 'applying' }
  | { name: 'stopped'; done: number; total: number }

interface Done {
  checked: number
  plays: number
  unknown: number
  removed: LinkRemoval[]
  /** Tracks left unplayable, now filed under Issues. */
  filed: Array<{ trackId: number; label: string }>
  issuesCreated: boolean
  /** Cuts the store refused: those links are still there. */
  failed: number
  /** The Issues playlist could not be written. */
  issuesError: boolean
}

const NOTHING: Done = {
  checked: 0,
  plays: 0,
  unknown: 0,
  removed: [],
  filed: [],
  issuesCreated: false,
  failed: 0,
  issuesError: false,
}

/**
 * The link-health run: does every stored link actually play here, and what is
 * left when the ones that do not are cut?
 *
 * YouTube links rot — uploads go private, owners turn embedding off, labels
 * block a country — and nothing in the app notices until playback fails on
 * stage. So every link is asked about twice, in the order that costs least: an
 * oEmbed request for existence and embeddability, then a cue in a hidden copy
 * of the player this app already streams through, which is the only thing that
 * can answer "does it play here" for this machine's country.
 *
 * A link YouTube says will not play is removed from its track. A track left
 * with no Main and no clip is filed under Issues, which is created at the top
 * of the tree the first time it is needed. Links nobody could be asked about
 * are left exactly as they were: only a definite no removes anything.
 */
export function LinkHealthDialog({
  open,
  onClose,
  onListTracks,
  onRemoveSource,
  onFileIssues,
  onRefresh,
  onOpenCard,
}: Props) {
  useEscape(onClose, open)
  const dialog = useRef<HTMLDivElement | null>(null)
  useFocusTrap(dialog, open)
  const [phase, setPhase] = useState<Phase | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A re-run without closing the dialog: Stop leaves a half-finished run
  // behind, and the useful next move is to go again.
  const [runNonce, setRunNonce] = useState(0)
  // The run's own copy of the library, so an Open-card row finds its track
  // even when filters have hidden it from every visible list.
  const [byId, setById] = useState<Map<number, TrackWithSources>>(new Map())
  const abortRef = useRef<AbortController | null>(null)
  // Read through refs so the run effect fires once per open without
  // depending on callback identities the parent may recreate.
  const callbacks = useRef({
    onListTracks,
    onRemoveSource,
    onFileIssues,
    onRefresh,
    onOpenCard,
  })
  callbacks.current = {
    onListTracks,
    onRemoveSource,
    onFileIssues,
    onRefresh,
    onOpenCard,
  }

  const openCard = (track: TrackWithSources) => callbacks.current.onOpenCard(track)

  // Starting the run is the reason the dialog was opened — the topbar press
  // already was the intent — so it begins on open rather than asking again.
  useEffect(() => {
    if (!open) return
    setPhase(null)
    setDone(null)
    setError(null)
    setById(new Map())
    let cancelled = false
    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal

    void (async () => {
      try {
        const tracks = await callbacks.current.onListTracks()
        if (cancelled || signal.aborted) return
        setById(new Map(tracks.map((t) => [t.id, t])))
        const ids = tracks.flatMap((t) => t.sources.map((s) => s.youtubeId))
        const total = new Set(ids).size
        if (!total) {
          setPhase(null)
          setDone(NOTHING)
          return
        }
        setPhase({ name: 'checking', done: 0, total })
        const verdicts = await checkLinksOnce(
          ids,
          (id, sig) => probeLink(id, { signal: sig }),
          {
            signal,
            // Two embeds at a time: enough to halve the wait on a big library,
            // few enough that the run stays invisible to the machine.
            concurrency: 2,
            onProgress: (doneCount, totalCount) => {
              if (!cancelled) {
                setPhase({ name: 'checking', done: doneCount, total: totalCount })
              }
            },
          },
        )
        if (cancelled) return
        if (signal.aborted) {
          setPhase({ name: 'stopped', done: verdicts.size, total })
          return
        }

        const plan = planLinkHealth(tracks, verdicts)
        let failed = 0
        let filed: Done['filed'] = []
        let issuesCreated = false
        let issuesError = false

        if (plan.removals.length || plan.issuesTrackIds.length) {
          setPhase({ name: 'applying' })
        }
        for (const removal of plan.removals) {
          if (cancelled) return
          try {
            await callbacks.current.onRemoveSource(removal.trackId, removal.role)
          } catch {
            failed++
          }
        }

        if (plan.issuesTrackIds.length) {
          const labelFor = new Map(
            tracks.map((t) => [t.id, `${t.artist} — ${t.title}`]),
          )
          filed = plan.issuesTrackIds.map((id) => ({
            trackId: id,
            label: labelFor.get(id) ?? `Track ${id}`,
          }))
          try {
            const result = await callbacks.current.onFileIssues(plan.issuesTrackIds)
            issuesCreated = result.created
          } catch {
            issuesError = true
          }
        }

        if (cancelled) return
        callbacks.current.onRefresh()
        setPhase(null)
        setDone({
          checked: verdicts.size,
          plays: plan.plays,
          unknown: plan.unknown,
          removed: plan.removals,
          filed,
          issuesCreated,
          failed,
          issuesError,
        })
      } catch {
        if (!cancelled) {
          setPhase(null)
          setError('The check could not finish. Try again.')
        }
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [open, runNonce])

  if (!open) return null

  const running = phase !== null


  return (
    <div className="modal-backdrop health" onClick={onClose} role="presentation">
      <div
        ref={dialog}
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Check library links"
      >
        <header className="modal-header">
          <h2>Check library links</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error && <p className="error">{error}</p>}

        {running && phase && (
          <>
            <p className="backfill-status" role="status">
              <span>
                {phase.name === 'applying'
                  ? 'Removing the dead links…'
                  : phase.name === 'stopped'
                    ? `Stopped after ${phase.done} of ${phase.total} links`
                    : `Checking link ${Math.min(phase.done + 1, phase.total)} of ${phase.total}`}
              </span>
              {phase.name !== 'applying' && (
                <span className="backfill-bar">
                  <span
                    style={{
                      width: `${Math.round(
                        (phase.done / Math.max(1, phase.total)) * 100,
                      )}%`,
                    }}
                  />
                </span>
              )}
              {phase.name === 'checking' ? (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => abortRef.current?.abort()}
                >
                  Stop
                </button>
              ) : phase.name === 'stopped' ? (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setRunNonce((n) => n + 1)}
                >
                  Check again
                </button>
              ) : null}
            </p>
            <p className="hint">
              {phase.name === 'stopped'
                ? 'Nothing was removed: a stopped run writes nothing.'
                : 'Each link is cued in a hidden player, so the answers come from this machine — including whether YouTube blocks it in this country.'}
            </p>
          </>
        )}

        {!running && !done && !error && (
          <p className="hint">Starting the check…</p>
        )}

        {!running && done && <HealthResults done={done} byId={byId} onOpenCard={openCard} />}
      </div>
    </div>
  )
}

/**
 * What the run did, in two lists: the links it cut and the tracks it had to
 * file. Nothing here is a suggestion — by the time this renders, the writes
 * have happened — so the wording says what is now true rather than what to go
 * and fix.
 */
function HealthResults({
  done,
  byId,
  onOpenCard,
}: {
  done: Done
  byId: Map<number, TrackWithSources>
  onOpenCard: (track: TrackWithSources) => void
}) {
  const clean = done.removed.length === 0 && done.filed.length === 0
  return (
    <>
      <p className="hint" role="status">
        Checked {done.checked} {done.checked === 1 ? 'link' : 'links'}
        {done.removed.length > 0 &&
          ` · ${done.removed.length} removed`}
        {done.plays > 0 && ` · ${done.plays} play`}
        {done.filed.length > 0 &&
          ` · ${done.filed.length} filed under ${ISSUES_PLAYLIST}`}
        {done.unknown > 0 &&
          ` · ${done.unknown} could not be asked and ${done.unknown === 1 ? 'was' : 'were'} left alone`}
        {done.failed > 0 &&
          ` · ${done.failed} ${done.failed === 1 ? 'cut' : 'cuts'} failed and ${done.failed === 1 ? 'was' : 'were'} left in place`}
        {done.issuesError && ` · ${ISSUES_PLAYLIST} could not be written`}
        {clean && done.unknown === 0 && done.failed === 0 && ' · everything plays'}
      </p>
      {done.removed.length > 0 && (
        <section className="field">
          <label>Links removed — YouTube said these will not play here</label>
          <ul className="health-list">
            {done.removed.map((removal) => (
              <li
                key={`${removal.trackId}:${removal.role}:${removal.youtubeId}`}
                className="health-row"
              >
                <span className="agent-what">{removal.label}</span>
                <span className="agent-why">
                  {removal.role === 'audio'
                    ? 'Main'
                    : removal.role === 'video'
                      ? 'Official video clip'
                      : 'Live take'}
                  {' — '}
                  {removal.detail}
                </span>
                {byId.has(removal.trackId) && (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => onOpenCard(byId.get(removal.trackId)!)}
                  >
                    Open card
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {done.filed.length > 0 && (
        <section className="field">
          <label>
            Nothing left to play — filed under {ISSUES_PLAYLIST}
            {done.issuesCreated ? ' (created at the top of the tree)' : ''}
          </label>
          <ul className="health-list">
            {done.filed.map((track) => (
              <li key={track.trackId} className="health-row">
                <span className="agent-what">{track.label}</span>
                <span className="agent-why">
                  No Main and no clip left. Paste a new link in the card to make it
                  playable again.
                </span>
                {byId.has(track.trackId) && (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => onOpenCard(byId.get(track.trackId)!)}
                  >
                    Open card
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

