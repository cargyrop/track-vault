import { useEscape } from '../hooks/useEscape'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useMemo, useRef } from 'react'
import { normalise } from '../lib/jsonLibrary'
import { plural } from '../lib/format'

interface Props {
  fileName: string
  fileText: string
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The last stop before a replace import deletes anything.
 *
 * The merge import needs no dialog — it can only add — but replacing empties
 * the library first, so this names the file, counts what it holds, and says
 * what will be lost. A file that is not a library export cannot be confirmed
 * at all; the stores refuse it again on the way in, so this is the friendly
 * refusal and theirs is the final one.
 */
export function ReplaceLibraryDialog({
  fileName,
  fileText,
  pending,
  onCancel,
  onConfirm,
}: Props) {
  useEscape(onCancel)
  const dialog = useRef<HTMLDivElement | null>(null)
  useFocusTrap(dialog)
  const preview = useMemo(() => {
    let parsed: unknown
    try {
      parsed = JSON.parse(fileText)
    } catch {
      return null
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { tracks?: unknown }).tracks)
    ) {
      return null
    }
    const doc = normalise(fileText)
    return {
      tracks: doc.tracks.length,
      playlists: doc.playlists.length,
      folders: doc.folders.length,
    }
  }, [fileText])


  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={dialog}
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Replace library with ${fileName}`}
      >
        <header className="modal-header">
          <h2>Replace library</h2>
          <button
            type="button"
            className="ghost"
            onClick={onCancel}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        {preview ? (
          <>
            <p className="hint agent-verdict">
              <strong>{fileName}</strong> holds{' '}
              {plural(preview.tracks, 'track', 'tracks')},{' '}
              {plural(preview.playlists, 'playlist', 'playlists')} and{' '}
              {plural(preview.folders, 'folder', 'folders')}. Afterwards this
              library holds exactly that — no more, no less.
            </p>
            <p className="hint warn">
              This deletes everything currently here first — tracks, playlists,
              folders and listen history — including anything the file does not
              contain. The current library is downloaded as a backup file first,
              and importing that file brings it back.
            </p>
          </>
        ) : (
          <p className="error">
            {fileName} is not a TrackVault library export, so there is nothing
            to replace with. Nothing was deleted — pick a file from Export.
          </p>
        )}
        <footer className="modal-footer">
          <button
            type="button"
            className="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            Keep my library
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={onConfirm}
            disabled={!preview || pending}
          >
            {pending ? 'Replacing…' : 'Replace my library'}
          </button>
        </footer>
      </div>
    </div>
  )
}
