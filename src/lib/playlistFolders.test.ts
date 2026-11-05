import { beforeEach, describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { createMemoryTransport, JsonLibrary } from './jsonLibrary'
import { EMPTY_FILTER, type NewTrack } from './types'

/**
 * The folder tree, membership and unfiled-tracks behaviour is implemented twice
 * — once over SQLite, once over the JSON file — and the UI cannot tell them
 * apart. Every rule is therefore asserted against both stores from one list, so
 * a change that only fixes one of them fails here.
 */

type Store = Library | JsonLibrary

async function sqlStore(): Promise<Store> {
  const lib = new Library(await createMemoryDriver())
  await lib.migrate()
  return lib
}

async function jsonStore(): Promise<Store> {
  const lib = new JsonLibrary(createMemoryTransport(''))
  await lib.migrate()
  return lib
}

function track(overrides: Partial<NewTrack> = {}): NewTrack {
  return {
    title: 'Paranoid Android',
    artist: 'Radiohead',
    genres: ['prog rock'],
    sources: [
      {
        youtubeId: 'f7nonexistent1',
        url: 'https://www.youtube.com/watch?v=f7nonexistent1',
        kind: 'official',
      },
    ],
    ...overrides,
  }
}

const stores: Array<[string, () => Promise<Store>]> = [
  ['SQL', sqlStore],
  ['JSON', jsonStore],
]

for (const [label, make] of stores) {
  describe(`playlist folders (${label})`, () => {
    let lib: Store

    beforeEach(async () => {
      lib = await make()
    })

    it('nests folders and lifts playlists when a folder is deleted', async () => {
      const root = await lib.createFolder('Root')
      const child = await lib.createFolder('Child', root)
      const a = await lib.createPlaylist('A', undefined, root)
      const b = await lib.createPlaylist('B', undefined, child)

      const folders = await lib.listFolders()
      expect(folders.find((f) => f.id === root)?.parentId).toBeNull()
      expect(folders.find((f) => f.id === child)?.parentId).toBe(root)

      const playlists = await lib.listPlaylists()
      expect(playlists.find((p) => p.id === a)?.folderId).toBe(root)
      expect(playlists.find((p) => p.id === b)?.folderId).toBe(child)

      // Deleting a folder keeps the playlists inside it.
      await lib.deleteFolder(root)
      expect(await lib.listFolders()).toEqual([])
      const after = await lib.listPlaylists()
      expect(after.find((p) => p.id === a)?.folderId).toBeNull()
      expect(after.find((p) => p.id === b)?.folderId).toBeNull()
    })

    it('renames a playlist, and refuses to give it a blank name', async () => {
      const id = await lib.createPlaylist('Old name')
      await lib.renamePlaylist(id, '  New name  ')
      const renamed = (await lib.listPlaylists()).find((p) => p.id === id)
      expect(renamed?.name).toBe('New name')

      await expect(lib.renamePlaylist(id, '   ')).rejects.toThrow(
        'Playlist name is required.',
      )
      // The refused rename left the name it already had.
      const after = (await lib.listPlaylists()).find((p) => p.id === id)
      expect(after?.name).toBe('New name')
    })

    it('moves a playlist into a folder and back to the top level', async () => {
      const folder = await lib.createFolder('Setlist')
      const id = await lib.createPlaylist('Loose')

      await lib.setPlaylistFolder(id, folder)
      expect((await lib.listPlaylists()).find((p) => p.id === id)?.folderId).toBe(
        folder,
      )

      await lib.setPlaylistFolder(id, null)
      expect(
        (await lib.listPlaylists()).find((p) => p.id === id)?.folderId,
      ).toBeNull()
    })

    it('re-parents a folder and lifts it back to the top level', async () => {
      const outer = await lib.createFolder('Outer')
      const inner = await lib.createFolder('Inner')
      const leaf = await lib.createFolder('Leaf', inner)

      await lib.setFolderParent(inner, outer)
      await lib.setFolderParent(leaf, outer)
      const moved = await lib.listFolders()
      expect(moved.find((f) => f.id === inner)?.parentId).toBe(outer)
      expect(moved.find((f) => f.id === leaf)?.parentId).toBe(outer)

      await lib.setFolderParent(leaf, null)
      const lifted = await lib.listFolders()
      expect(lifted.find((f) => f.id === leaf)?.parentId).toBeNull()
    })

    it('refuses to move a folder into itself or its own descendant', async () => {
      const outer = await lib.createFolder('Outer')
      const inner = await lib.createFolder('Inner', outer)
      const leaf = await lib.createFolder('Leaf', inner)

      await expect(lib.setFolderParent(outer, outer)).rejects.toThrow(
        'A folder cannot contain itself.',
      )
      await expect(lib.setFolderParent(outer, leaf)).rejects.toThrow(
        'A folder cannot be moved inside itself.',
      )
      await expect(lib.setFolderParent(outer, 9999)).rejects.toThrow(
        'Folder not found.',
      )

      // A refused move must leave the tree exactly as it was.
      const folders = await lib.listFolders()
      expect(folders.find((f) => f.id === outer)?.parentId).toBeNull()
      expect(folders.find((f) => f.id === inner)?.parentId).toBe(outer)
      expect(folders.find((f) => f.id === leaf)?.parentId).toBe(inner)
    })

    it('reports which playlists a track belongs to', async () => {
      const id = await lib.addTrack(
        track({ title: 'Locust', artist: 'Machine Head' }),
      )
      const one = await lib.createPlaylist('One')
      const two = await lib.createPlaylist('Two')
      await lib.addToPlaylist(one, id)
      await lib.addToPlaylist(two, id)

      const members = await lib.listPlaylistsForTrack(id)
      expect(members.map((m) => m.name).sort()).toEqual(['One', 'Two'])
      expect(await lib.listPlaylistsForTrack(999)).toEqual([])
    })

    it('matches the one search box against title, artist or album', async () => {
      await lib.addTrack(
        track({ title: 'Paranoid Android', artist: 'Radiohead', album: 'OK Computer' }),
      )
      await lib.addTrack(track({ title: 'Karma Police', artist: 'Nobody' }))

      const byTitle = await lib.listTracks({ ...EMPTY_FILTER, search: 'paranoid' })
      expect(byTitle.map((t) => t.title)).toEqual(['Paranoid Android'])
      const byArtist = await lib.listTracks({ ...EMPTY_FILTER, search: 'radiohead' })
      expect(byArtist.map((t) => t.title)).toEqual(['Paranoid Android'])
      const byAlbum = await lib.listTracks({ ...EMPTY_FILTER, search: 'ok computer' })
      expect(byAlbum.map((t) => t.title)).toEqual(['Paranoid Android'])
    })

    it('treats selected genres as additive, not exclusive', async () => {
      await lib.addTrack(
        track({ title: 'Only Thrash', artist: 'A', genres: ['thrash metal'] }),
      )
      await lib.addTrack(
        track({ title: 'Only Doom', artist: 'B', genres: ['doom metal'] }),
      )
      await lib.addTrack(
        track({
          title: 'Both',
          artist: 'C',
          genres: ['thrash metal', 'doom metal'],
        }),
      )

      const hits = await lib.listTracks({
        ...EMPTY_FILTER,
        genres: ['thrash metal', 'doom metal'],
      })
      // Union of the two genres: every track tagged with either one.
      expect(hits.map((t) => t.title).sort()).toEqual([
        'Both',
        'Only Doom',
        'Only Thrash',
      ])
    })

    it('re-orders a playlist by moving one track, clamping either end', async () => {
      const id = await lib.createPlaylist('Order')
      const ids: number[] = []
      for (const title of ['One', 'Two', 'Three', 'Four']) {
        const trackId = await lib.addTrack(track({ title }))
        await lib.addToPlaylist(id, trackId)
        ids.push(trackId)
      }
      const order = async () =>
        (await lib.listPlaylistTracks(id)).map((e) => e.track.title)

      expect(await order()).toEqual(['One', 'Two', 'Three', 'Four'])

      // To the front, then into the middle, then past the end — which the
      // stores read as "the last slot" rather than as an error.
      await lib.movePlaylistTrack(id, ids[3], 0)
      expect(await order()).toEqual(['Four', 'One', 'Two', 'Three'])

      await lib.movePlaylistTrack(id, ids[0], 2)
      expect(await order()).toEqual(['Four', 'Two', 'One', 'Three'])

      await lib.movePlaylistTrack(id, ids[0], 99)
      expect(await order()).toEqual(['Four', 'Two', 'Three', 'One'])

      // Order is held as a sequence, so the positions stay 0..n-1.
      const entries = await lib.listPlaylistTracks(id)
      expect(entries.map((e) => e.position)).toEqual([0, 1, 2, 3])
    })

    it('ignores a move for a missing playlist or a track outside it', async () => {
      const id = await lib.createPlaylist('Order')
      const inside = await lib.addTrack(track({ title: 'Inside' }))
      const outside = await lib.addTrack(track({ title: 'Outside' }))
      await lib.addToPlaylist(id, inside)
      const other = await lib.createPlaylist('Other')
      await lib.addToPlaylist(other, outside)
      const second = await lib.addTrack(track({ title: 'Second' }))
      await lib.addToPlaylist(id, second)

      await lib.movePlaylistTrack(9999, inside, 0)
      await lib.movePlaylistTrack(id, outside, 0)

      // The playlist that was actually dragged keeps its order, and neither the
      // other playlist nor the track list is touched.
      expect((await lib.listPlaylistTracks(id)).map((e) => e.track.title)).toEqual([
        'Inside',
        'Second',
      ])
      expect(
        (await lib.listPlaylistTracks(other)).map((e) => e.track.title),
      ).toEqual(['Outside'])

      // A negative index means the first slot, not a position before it.
      await lib.movePlaylistTrack(id, second, -5)
      expect((await lib.listPlaylistTracks(id)).map((e) => e.track.title)).toEqual([
        'Second',
        'Inside',
      ])
    })
  })
}
