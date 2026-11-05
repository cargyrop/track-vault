import { describe, expect, it } from 'vitest'
import { folderAcceptsDrop, isSelfOrBelow, type Dragged } from './treeDrag'
import type { Playlist, PlaylistFolder } from './types'

function folder(id: number, parentId: number | null = null): PlaylistFolder {
  return { id, name: `Folder ${id}`, parentId, createdAt: '2026-01-01T00:00:00.000Z' }
}

function playlist(id: number, folderId: number | null = null): Playlist {
  return {
    id,
    name: `Playlist ${id}`,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    trackCount: 0,
    folderId,
  }
}

const dragPlaylist = (id: number): Dragged => ({ kind: 'playlist', id, name: 'p' })
const dragFolder = (id: number): Dragged => ({ kind: 'folder', id, name: 'f' })

describe('playlist tree drag-and-drop', () => {
  it('lets a playlist whose id matches a folder id drop into that folder', () => {
    // The regression: folder ids and playlist ids are separate sequences, so
    // "playlist 1 into folder 1" is a normal move and must not be refused.
    const folders = [folder(1)]
    const playlists = [playlist(1), playlist(2)]

    expect(folderAcceptsDrop(dragPlaylist(1), 1, folders, playlists)).toBe(true)
    expect(folderAcceptsDrop(dragPlaylist(2), 1, folders, playlists)).toBe(true)
  })

  it('lets a playlist whose id matches a folder id drop into a different folder', () => {
    const folders = [folder(1), folder(2)]
    const playlists = [playlist(2)]

    expect(folderAcceptsDrop(dragPlaylist(2), 1, folders, playlists)).toBe(true)
  })

  it('refuses to drop a playlist into the folder it is already in', () => {
    const folders = [folder(1)]
    const playlists = [playlist(3, 1)]

    expect(folderAcceptsDrop(dragPlaylist(3), 1, folders, playlists)).toBe(false)
    // ...but another folder is a real move.
    expect(folderAcceptsDrop(dragPlaylist(3), 2, folders, playlists)).toBe(true)
  })

  it('ignores a stale drag whose playlist no longer exists', () => {
    expect(folderAcceptsDrop(dragPlaylist(99), 1, [folder(1)], [])).toBe(false)
  })

  it('still refuses the moves that would corrupt the tree', () => {
    // 2 lives in 1, 3 lives in 2, and 4 is an unrelated root folder.
    const folders = [folder(1), folder(2, 1), folder(3, 2), folder(4)]

    // A folder cannot contain itself, nor move inside its own descendant.
    expect(folderAcceptsDrop(dragFolder(1), 1, folders, [])).toBe(false)
    expect(folderAcceptsDrop(dragFolder(1), 2, folders, [])).toBe(false)
    expect(folderAcceptsDrop(dragFolder(1), 3, folders, [])).toBe(false)

    // Lifting a nested folder out, and skipping a level, are real moves...
    expect(folderAcceptsDrop(dragFolder(3), 1, folders, [])).toBe(true)
    expect(folderAcceptsDrop(dragFolder(3), 4, folders, [])).toBe(true)
    // ...but dropping a folder where it already is changes nothing.
    expect(folderAcceptsDrop(dragFolder(2), 1, folders, [])).toBe(false)
    expect(folderAcceptsDrop(dragFolder(2), 2, folders, [])).toBe(false)
  })

  it('treats a missing drag as no drop at all', () => {
    expect(folderAcceptsDrop(null, 1, [folder(1)], [playlist(1)])).toBe(false)
  })

  it('walks the parent chain without looping on a cycle', () => {
    const folders = [folder(1, 2), folder(2, 1)]
    expect(isSelfOrBelow(1, 2, folders)).toBe(true)
    expect(isSelfOrBelow(9, 1, folders)).toBe(false)
  })
})
