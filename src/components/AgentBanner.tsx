import { summarise, type MergeReport } from '../lib/agentInbox'

/**
 * Reports what the AI drop box just did.
 *
 * This exists because the merge is not self-evidently correct. Asking a model
 * for a hundred songs and getting back ninety is a normal outcome, not an
 * error, so it does not belong in the red error banner — but the ten that did
 * not make it are exactly the part worth reading, and quietly dropping them
 * would leave the person thinking they all arrived. So the counts go in one
 * line and everything that went wrong sits behind a disclosure, where it is
 * available without taking over the window.
 */
export function AgentBanner({
  report,
  inboxPending,
  onDismiss,
}: {
  report: MergeReport | null
  inboxPending: boolean
  onDismiss: () => void
}) {
  // A third kind of outcome, and a separate list for that reason: a rejection
  // means the track did not arrive, a note means it did but one detail of it
  // was overruled. Mixing them would bury the rejections.
  const notes = report?.notes ?? []

  // Rejections and unmatched playlist references are different failures: a
  // rejection means the track reached neither the library nor the playlist,
  // while an unmatched reference means the track is in the library but was
  // not filed into that playlist. They get separate lists so the summary can
  // say which one happened.
  const rejected = report
    ? report.lines
        .filter((l) => l.outcome === 'rejected')
        .map((l) => ({
          key: `t:${l.label}`,
          what: l.title || l.artist ? `${l.artist} — ${l.title}` : l.label,
          why: l.reason ?? 'rejected',
        }))
    : []
  const notFiled = report
    ? report.playlists.flatMap((p) =>
        p.unmatched.map((ref) => ({
          key: `p:${p.name}:${ref}`,
          what: `${p.name}: “${ref}”`,
          why: 'no track in the library matches that name',
        })),
      )
    : []

  if (!report && !inboxPending) return null

  return (
    <div className="banner agent" role="status">
      <div className="agent-body">
        {report && <span className="agent-summary">{summarise(report)}</span>}
        {inboxPending && (
          <span className="agent-pending">
            A batch is waiting in <code>data/inbox.json</code>
          </span>
        )}
        {rejected.length > 0 && (
          <details className="agent-details">
            <summary>
              {rejected.length === 1
                ? '1 could not be added to the library — show why'
                : `${rejected.length} could not be added to the library — show why`}
            </summary>
            <ul>
              {rejected.map((p) => (
                <li key={p.key}>
                  <span className="agent-what">{p.what}</span>
                  <span className="agent-why">{p.why}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {notFiled.length > 0 && (
          <details className="agent-details">
            <summary>
              {notFiled.length === 1
                ? '1 could not be added to the playlist — show why'
                : `${notFiled.length} could not be added to the playlist — show why`}
            </summary>
            <ul>
              {notFiled.map((p) => (
                <li key={p.key}>
                  <span className="agent-what">{p.what}</span>
                  <span className="agent-why">{p.why}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {notes.length > 0 && (
          <details className="agent-details">
            <summary>
              {notes.length === 1 ? '1 note' : `${notes.length} notes`} — show{' '}
              {notes.length === 1 ? 'it' : 'them'}
            </summary>
            <ul>
              {notes.map((note, index) => (
                <li key={`n:${index}`}>
                  <span className="agent-why">{note}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button
        type="button"
        className="ghost icon-btn"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}