/**
 * Shuffle, as a bag of ids rather than a re-ordering of the list.
 *
 * The two ways to shuffle look identical in the player and are not: permuting
 * the tracklist moves the rows, so the list you were reading rearranges itself
 * under the pointer when you press the button and again every time a track
 * ends — you can no longer find the song you were about to click, and the list
 * stops being a table of your library. Drawing from a bag leaves the list
 * exactly where it was and only decides what plays next.
 *
 * The bag is a cycle: every track is drawn once before any is drawn twice, and
 * a fresh cycle is dealt when the last one runs out. Ids are carried rather
 * than tracks or positions, because the visible list changes underneath a
 * shuffle — a filter narrows it, a track is deleted, an edit re-sorts it — and
 * an index into the old list means nothing in the new one.
 */

/** One pass through the list: what is left to draw, and what has been heard. */
export interface ShuffleCycle {
  /** Ids not drawn yet this cycle, in the order they will play. */
  bag: number[]
  /**
   * Ids heard this cycle, oldest first. It ends with whatever is playing now,
   * which is what makes Previous a walk back through what actually happened
   * rather than a guess.
   */
  played: number[]
  /**
   * Whether a pass has been dealt yet.
   *
   * Needed because "nothing in the bag" means two different things: a shuffle
   * that has not started (switch it on mid-track and there is nothing to draw
   * *yet*) and one that has been heard in full. Without this the first Next
   * after switching shuffle on would look like the end of a pass and do nothing.
   */
  dealt: boolean
}

export function emptyCycle(): ShuffleCycle {
  return { bag: [], played: [], dealt: false }
}

function shuffled(ids: number[], random: () => number): number[] {
  const out = [...ids]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Deals a new cycle.
 *
 * `avoid` is the track that just finished. It goes into the drawn half of the
 * new cycle rather than the bag: it has already been heard, so counting it as
 * heard is what keeps a pass to one play per track, while leaving it out of the
 * bag is what stops the new pass opening on the song you have just heard — the
 * one repeat a listener notices immediately. A list of one has nothing else to
 * offer, so it is dealt as normal and the pass is that single track.
 */
export function refillCycle(
  ids: number[],
  avoid: number | null,
  random: () => number = Math.random,
): ShuffleCycle {
  if (ids.length <= 1) return { bag: shuffled(ids, random), played: [], dealt: true }
  const pool = avoid === null ? ids : ids.filter((id) => id !== avoid)
  return {
    bag: shuffled(pool, random),
    played: avoid !== null && ids.includes(avoid) ? [avoid] : [],
    dealt: true,
  }
}

/**
 * Records a track the listener chose by hand.
 *
 * Picking a row mid-shuffle is not the shuffle drawing it, but it *is* hearing
 * it: leaving it in the bag would play it a second time in the same pass, which
 * is the one thing a no-repeat shuffle promises not to do. A track already
 * heard is returned untouched, so the trail keeps ending at the current track.
 */
export function notePlayed(cycle: ShuffleCycle, id: number): ShuffleCycle {
  if (cycle.played.includes(id)) return cycle
  return {
    bag: cycle.bag.filter((other) => other !== id),
    played: [...cycle.played, id],
    dealt: cycle.dealt,
  }
}

export interface OpeningTrackInput {
  /** The list as it stands now, in the order it is displayed. */
  ids: number[]
  /**
   * The track playing now, if any.
   *
   * A fresh pass is kept off it: pressing Play on the track you are already
   * hearing would look as though the button did nothing at all.
   */
  current?: number | null
  /** Whether the shuffle is on. With it off, a list opens on its first row. */
  shuffle: boolean
  cycle: ShuffleCycle
  random?: () => number
}

export interface OpeningTrackResult {
  /** The id to open on, or null for an empty list. */
  next: number | null
  cycle: ShuffleCycle
}

/**
 * The track a list opens on.
 *
 * Pressing Play on a playlist is a decision about order, not only about
 * starting, so it goes through the same bag as everything else: with the
 * shuffle on, opening on the first row would quietly undo the button the reader
 * just pressed — the one thing they asked not to happen.
 *
 * The pass it opens is always a *fresh* one, because a Play is the beginning of
 * a listen. Drawing from whatever bag was left over would open on the remains
 * of an earlier run, and when that run was spent there would be nothing to draw
 * at all: with repeat off, a playlist you had already heard through would open
 * on silence. With the shuffle off nothing is dealt and the cycle is handed back
 * untouched, so pressing Play cannot disturb a pass in progress.
 */
export function openingTrack({
  ids,
  current = null,
  shuffle,
  cycle,
  random,
}: OpeningTrackInput): OpeningTrackResult {
  if (!ids.length) return { next: null, cycle }
  if (!shuffle) return { next: ids[0], cycle }
  const avoid = current !== null && ids.includes(current) ? current : null
  return drawNext({
    cycle: refillCycle(ids, avoid, random),
    ids,
    current: null,
    direction: 1,
    // The bag always has something in it here, so what happens at the end of a
    // pass is not this function's business.
    repeat: true,
    random,
  })
}

/**
 * The next id in an unshuffled list: the neighbouring row.
 *
 * Walked off either end the list either wraps or stops, which is the one thing
 * the repeat button means. This is the walk the app has always done, kept here
 * unchanged so that adding a shuffle could not quietly alter it.
 */
function linearNext(
  ids: number[],
  current: number | null,
  direction: 1 | -1,
  repeat: boolean,
): number | null {
  const index = current === null ? -1 : ids.indexOf(current)
  if (index === -1) return direction === 1 ? ids[0] : ids[ids.length - 1]
  const next = index + direction
  if (next < 0 || next >= ids.length) {
    if (!repeat) return null
    return ids[(next + ids.length) % ids.length]
  }
  return ids[next]
}

export interface NextTrackInput {
  /** The list as it stands now, in the order it is displayed. */
  ids: number[]
  current: number | null
  direction: 1 | -1
  repeat: boolean
  /** Whether the shuffle is on. When it is off the list order *is* the order. */
  shuffle: boolean
  cycle: ShuffleCycle
  random?: () => number
}

export interface NextTrackResult {
  /** The id to play next, or null when nothing should change. */
  next: number | null
  cycle: ShuffleCycle
}

/**
 * What plays next, wherever the request came from.
 *
 * One function for both modes so the two cannot drift: the bottom of the list,
 * the end of a shuffled pass and a Next with nothing playing are all the same
 * decision made on different state. It returns an id and never a track, and
 * never touches the list — a caller cannot accidentally reorder anything by
 * asking what is next.
 */
export function nextTrackId({
  ids,
  current,
  direction,
  repeat,
  shuffle,
  cycle,
  random,
}: NextTrackInput): NextTrackResult {
  if (!ids.length) return { next: null, cycle }
  if (!shuffle) return { next: linearNext(ids, current, direction, repeat), cycle }
  return drawNext({ cycle, ids, current, direction, repeat, random })
}

export interface DrawInput {
  cycle: ShuffleCycle
  /** The list as it stands now. Ids that are no longer in it leave the cycle. */
  ids: number[]
  /** The track playing now, if any. */
  current: number | null
  direction: 1 | -1
  /**
   * What to do once every track has been heard. With repeat off the shuffle has
   * finished and there is no next track; with it on, a new cycle is dealt. That
   * is the same promise the repeat button makes over an unshuffled list.
   */
  repeat: boolean
  random?: () => number
}

export interface DrawResult {
  /** The id to play, or null when the shuffle has nothing left to give. */
  next: number | null
  cycle: ShuffleCycle
}

/**
 * The next (or previous) track of a shuffle.
 *
 * Previous walks back through what has been played — and puts the track it
 * leaves on the front of the bag, so pressing Next again returns you to where
 * you were instead of skipping it for the rest of the pass.
 */
export function drawNext({
  cycle,
  ids,
  current,
  direction,
  repeat,
  random = Math.random,
}: DrawInput): DrawResult {
  const present = new Set(ids)
  const heard = new Set(cycle.played)
  const bag = cycle.bag.filter((id) => present.has(id) && !heard.has(id))
  // What is playing now counts as heard even when the cycle did not put it
  // there — a track carried over from before the shuffle was switched on, or
  // started from the transport. It is the same promise either way: the pass
  // being drawn does not include the track you are listening to.
  const played = cycle.played.filter((id) => present.has(id))
  if (current !== null && present.has(current) && !played.includes(current)) {
    played.push(current)
  }

  if (direction === -1) {
    // The trail ends at what is playing, so step off it before looking back.
    const trail =
      current !== null && played.length > 0 && played[played.length - 1] === current
        ? played.slice(0, -1)
        : played
    if (!trail.length) return { next: null, cycle: { bag, played, dealt: cycle.dealt } }
    return {
      next: trail[trail.length - 1],
      cycle: {
        bag: current === null || !present.has(current) ? bag : [current, ...bag],
        played: trail,
        dealt: cycle.dealt,
      },
    }
  }

  // The track playing now is not redrawn this pass, however it was started: a
  // row clicked by hand is still part of the pass it interrupted.
  const ready = current === null ? bag : bag.filter((id) => id !== current)

  if (!ready.length) {
    // Nothing left to draw. With repeat off the pass has been heard in full,
    // and returning null is what makes the player stop rather than start over.
    // A pass that has already been heard in full ends here with repeat off.
    // A pass that was never dealt is dealt now: the bag is empty because the
    // shuffle has only just been switched on, not because it is finished.
    if (cycle.dealt && !repeat) return { next: null, cycle: { bag, played, dealt: true } }
    const fresh = refillCycle(ids, current, random)
    if (!fresh.bag.length) return { next: null, cycle: fresh }
    const [next, ...rest] = fresh.bag
    return { next, cycle: { bag: rest, played: [...fresh.played, next], dealt: true } }
  }

  const [next, ...rest] = ready
  return { next, cycle: { bag: rest, played: [...played, next], dealt: true } }
}
