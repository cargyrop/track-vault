import { plural } from '../lib/format'
import { useEscape } from '../hooks/useEscape'

interface Props {
  /** Where the library actually is, said in words rather than implied. */
  storageLabel: string
  counts: { tracks: number; playlists: number; folders: number }
  onClose: () => void
  onExport: () => void
  onImport: (file: File) => void
  onReplace: (file: { name: string; text: string }) => void
  onHealthCheck: () => void
  onShowShortcuts: () => void
}

/**
 * The account, the files, and the maintenance — one dialog, honestly labelled.
 *
 * It is called *You* rather than *Account* because there is nothing to sign in
 * to yet: pretending otherwise with an empty profile would be a promise the app
 * cannot keep. What it does say, in plain words, is where the library actually
 * lives, because "your music is in browser storage" is the difference between a
 * user who trusts the app and one who loses 1,700 tracks.
 *
 * Four monthly verbs used to sit in the top bar at the same weight as playing a
 * song. They live here now, next to what they act on: the collection.
 */

export function YouScreen({
  storageLabel,
  counts,
  onClose,
  onExport,
  onImport,
  onReplace,
  onHealthCheck,
  onShowShortcuts,
}: Props) {
  useEscape(onClose)

  return (
    <div className="you">
      <header className="modal-header">
        <h2>You</h2>
        <button
          type="button"
          className="ghost"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>

      <section className="you-card">
        <h3>Library</h3>
        <p className="you-line">
          <strong>{plural(counts.tracks, 'track', 'tracks')}</strong> in{' '}
          {plural(counts.playlists, 'playlist', 'playlists')} across{' '}
          {plural(counts.folders, 'folder', 'folders')}.
        </p>
        <p className="you-line hint">Stored in {storageLabel}.</p>
        <p className="you-line hint">
          Signing in is not part of this build. The library is a file on this
          machine, and every browser window that opens it reads the same one.
        </p>
      </section>

      <section className="you-card">
        <h3>Files</h3>
        <p className="you-line hint">
          Export writes the whole library as one JSON file. Import merges a file
          in without overwriting anything. Replace makes the library mirror the
          file — the current one is downloaded as a backup first.
        </p>
        <div className="you-actions">
          <button type="button" className="ghost-btn" onClick={onExport}>
            Export…
          </button>
          <label className="ghost-btn file-button">
            Import…
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Import library from JSON"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onImport(file)
                e.target.value = ''
              }}
            />
          </label>
          <label className="ghost-btn file-button">
            Replace…
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Replace library from JSON"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) {
                  void file
                    .text()
                    .then((text) => onReplace({ name: file.name, text }))
                }
                e.target.value = ''
              }}
            />
          </label>
        </div>
      </section>

      <section className="you-card">
        <h3>Maintenance</h3>
        <p className="you-line hint">
          A health check plays each stored link in a hidden player and removes the
          ones YouTube refuses here. Tracks left with no playable link are filed
          under the <strong>Issues</strong> playlist.
        </p>
        <div className="you-actions">
          <button type="button" className="ghost-btn" onClick={onHealthCheck}>
            Check library links…
          </button>
        </div>
      </section>

      <section className="you-card">
        <h3>About</h3>
        <p className="you-line hint">
          TrackVault keeps which YouTube video each track lives on, and plays it
          from YouTube. Nothing is downloaded.
        </p>
        <div className="you-actions">
          <button type="button" className="ghost-btn" onClick={onShowShortcuts}>
            Keyboard shortcuts
          </button>
        </div>
      </section>
    </div>
  )
}
