import { describe, expect, it } from 'vitest'
import {
  drawNext,
  emptyCycle,
  nextTrackId,
  notePlayed,
  openingTrack,
  refillCycle,
  type ShuffleCycle,
} from './shuffle'

/**
 * Coverage for the shuffle bag.
 *
 * The promise being tested is the one a listener can hear: within one pass, no
 * track is played twice, and every track is played. So most of these walk a
 * whole pass and assert on the sequence rather than on a single draw — a single
 * draw cannot be wrong on its own.
 */

/** A seeded generator, so a failure can be re-run and produce the same order. */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

/**
 * Walks `count` draws the way the player does, carrying the cycle and the
 * current track from each draw into the next.
 *
 * `segments` splits the run at every refill, which is what lets a test talk
 * about one pass rather than about the whole sequence.
 */
function walk(
  ids: number[],
  count: number,
  options: { repeat?: boolean; current?: number | null; random?: () => number } = {},
): { played: number[]; cycle: ShuffleCycle; segments: number[][] } {
  const random = options.random ?? seeded(7)
  const repeat = options.repeat ?? false
  let cycle: ShuffleCycle = emptyCycle()
  let current = options.current ?? null
  const played: number[] = []
  const segments: number[][] = [[]]
  for (let i = 0; i < count; i++) {
    const result = drawNext({ cycle, ids, current, direction: 1, repeat, random })
    cycle = result.cycle
    if (result.next === null) break
    played.push(result.next)
    segments[segments.length - 1].push(result.next)
    // An empty bag after a draw is the end of a pass; the next draw deals one.
    if (!cycle.bag.length) segments.push([])
    current = result.next
  }
  return { played, cycle, segments: segments.filter((s) => s.length) }
}

const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8]

describe('shuffle passes', () => {
  it('plays every track once before playing any of them twice', () => {
    const { played } = walk(EIGHT, 8, { current: null })
    expect([...played].sort((a, b) => a - b)).toEqual(EIGHT)
  })

  it('does not play a track again until the rest of the list has been played', () => {
    // The property a listener can hear, asserted pass by pass: everything in
    // the list is heard once before anything is heard twice. Each pass but the
    // first begins with the track carried over from the end of the last one,
    // so that track belongs to the pass it is still playing in.
    const { segments } = walk(EIGHT, 40, { repeat: true })
    expect(segments.length).toBeGreaterThan(4)
    // The last segment is whatever was left of a pass when the walk stopped,
    // so only the passes that finished can be judged as a pass.
    segments.slice(0, -1).forEach((segment, index) => {
      const before = segments[index - 1]
      const heard =
        index === 0 ? segment : [before[before.length - 1], ...segment]
      expect([...heard].sort((a, b) => a - b)).toEqual(EIGHT)
    })
  })

  it('does not play the same track twice in a row at a pass boundary', () => {
    const { played } = walk(EIGHT, 40, { repeat: true })
    played.forEach((id, index) => {
      if (index === 0) return
      expect(id).not.toBe(played[index - 1])
    })
  })

  it('is in a different order from one pass to the next', () => {
    const { segments } = walk(EIGHT, 40, { repeat: true, random: seeded(11) })
    // Passes are fresh shuffles, not a rotation of one order: a rotation would
    // make the whole library sound like a loop after a minute of listening.
    const orders = new Set(segments.map((s) => s.join(',')))
    expect(orders.size).toBeGreaterThan(1)
  })

  it('stops at the end of the pass with repeat off, and stays stopped', () => {
    const first = walk(EIGHT, 8, { repeat: false })
    expect(first.played).toHaveLength(8)
    // The player polls the end of a track every 250ms, so "nothing left" has to
    // be a stable answer rather than one that deals itself a fresh pass.
    const second = drawNext({
      cycle: first.cycle,
      ids: EIGHT,
      current: first.played[7],
      direction: 1,
      repeat: false,
      random: seeded(7),
    })
    expect(second.next).toBeNull()
    expect(second.cycle.bag).toEqual([])
  })

  it('has nothing to give from an empty list', () => {
    const result = drawNext({
      cycle: emptyCycle(),
      ids: [],
      current: null,
      direction: 1,
      repeat: true,
    })
    expect(result.next).toBeNull()
  })

  it('plays the only track there is once, and again only with repeat on', () => {
    const first = drawNext({
      cycle: emptyCycle(),
      ids: [7],
      current: null,
      direction: 1,
      repeat: true,
      random: seeded(3),
    })
    expect(first.next).toBe(7)

    // The pass was that one track, so with repeat off there is nothing next.
    const once = drawNext({
      cycle: first.cycle,
      ids: [7],
      current: 7,
      direction: 1,
      repeat: false,
      random: seeded(3),
    })
    expect(once.next).toBeNull()

    const again = drawNext({
      cycle: first.cycle,
      ids: [7],
      current: 7,
      direction: 1,
      repeat: true,
      random: seeded(3),
    })
    expect(again.next).toBe(7)
  })
})

describe('shuffle order', () => {
  it('leaves a list it has already heard behind', () => {
    // Two drawn, then the current track is the second of them: the pass must not
    // hand out either again.
    const first = drawNext({
      cycle: emptyCycle(),
      ids: [1, 2, 3, 4],
      current: null,
      direction: 1,
      repeat: true,
      random: seeded(5),
    })
    const second = drawNext({
      cycle: first.cycle,
      ids: [1, 2, 3, 4],
      current: first.next,
      direction: 1,
      repeat: true,
      random: seeded(5),
    })
    const third = drawNext({
      cycle: second.cycle,
      ids: [1, 2, 3, 4],
      current: second.next,
      direction: 1,
      repeat: true,
      random: seeded(5),
    })
    expect(new Set([first.next, second.next, third.next]).size).toBe(3)
  })

  it('drops a track that is deleted or filtered out before it is drawn', () => {
    const ids = [1, 2, 3, 4, 5, 6]
    const { played } = walk(ids, 2, { current: null, random: seeded(9) })
    // Re-run the pass without one of the tracks still waiting in the bag.
    const narrowed = ids.filter((id) => id !== 4 && id !== 5 && id !== 6)
    const rest = drawNext({
      cycle: { bag: [4, 5, 6], played, dealt: true },
      ids: narrowed,
      current: played[played.length - 1],
      direction: 1,
      repeat: true,
      random: seeded(9),
    })
    expect(narrowed).toContain(rest.next)
  })

  it('does not draw again a track the listener picked by hand', () => {
    const drawn = drawNext({
      cycle: emptyCycle(),
      ids: [1, 2, 3, 4],
      current: null,
      direction: 1,
      repeat: true,
      random: seeded(2),
    })
    // The listener clicks the fourth row while the shuffle is running.
    const cycle = notePlayed(drawn.cycle, 4)
    expect(cycle.played).toContain(4)
    expect(cycle.bag).not.toContain(4)

    const after = drawNext({
      cycle,
      ids: [1, 2, 3, 4],
      current: 4,
      direction: 1,
      repeat: false,
      random: seeded(2),
    })
    expect(after.next).not.toBe(4)
  })

  it('leaves a track already heard alone when it is picked again', () => {
    const cycle = refillCycle([1, 2, 3], null, seeded(4))
    const heard = notePlayed(cycle, 2)
    expect(notePlayed(heard, 2)).toBe(heard)
  })
})

describe('shuffle history', () => {
  it('steps back through what was played, and forward to where you were', () => {
    const ids = [1, 2, 3, 4, 5]
    const random = seeded(13)
    const a = drawNext({ cycle: emptyCycle(), ids, current: null, direction: 1, repeat: false, random })
    const b = drawNext({ cycle: a.cycle, ids, current: a.next, direction: 1, repeat: false, random })
    // Back to the first, and the one we left goes back on the front of the bag.
    const back = drawNext({ cycle: b.cycle, ids, current: b.next, direction: -1, repeat: false, random })
    expect(back.next).toBe(a.next)
    // Forward again lands on the track we stepped back from, not a new draw.
    const forward = drawNext({ cycle: back.cycle, ids, current: back.next, direction: 1, repeat: false, random })
    expect(forward.next).toBe(b.next)
  })

  it('has nowhere to go back to at the start of a pass', () => {
    const ids = [1, 2, 3]
    const first = drawNext({ cycle: emptyCycle(), ids, current: null, direction: 1, repeat: true, random: seeded(6) })
    const back = drawNext({ cycle: first.cycle, ids, current: first.next, direction: -1, repeat: true, random: seeded(6) })
    expect(back.next).toBeNull()
    // And the pass is not thrown away by asking.
    expect(back.cycle.bag).toEqual(first.cycle.bag)
  })

  it('walks back past a track that was picked by hand', () => {
    const ids = [1, 2, 3, 4]
    const random = seeded(8)
    const a = drawNext({ cycle: emptyCycle(), ids, current: null, direction: 1, repeat: true, random })
    const picked = notePlayed(a.cycle, 3)
    const back = drawNext({ cycle: picked, ids, current: 3, direction: -1, repeat: true, random })
    expect(back.next).toBe(a.next)
  })
})

describe('what plays next', () => {
  const ids = [1, 2, 3, 4]
  const call = (over: Partial<Parameters<typeof nextTrackId>[0]> = {}) =>
    nextTrackId({
      ids,
      current: null,
      direction: 1,
      repeat: false,
      shuffle: false,
      cycle: emptyCycle(),
      ...over,
    })

  it('walks the list in order while the shuffle is off', () => {
    expect(call({ current: 2 }).next).toBe(3)
    expect(call({ current: 2, direction: -1 }).next).toBe(1)
  })

  it('stops at the end of the list unless repeat is on', () => {
    expect(call({ current: 4 }).next).toBeNull()
    expect(call({ current: 4, repeat: true }).next).toBe(1)
    // Repeat loops the list in both directions, which is the walk this had
    // before the shuffle existed and is deliberately unchanged by it.
    expect(call({ current: 1, direction: -1, repeat: true }).next).toBe(4)
    expect(call({ current: 1, direction: -1 }).next).toBeNull()
  })

  it('starts a list nothing is playing from its first track', () => {
    expect(call({ current: null }).next).toBe(1)
    expect(call({ current: null, direction: -1 }).next).toBe(4)
  })

  it('starts over when the track that was playing is no longer listed', () => {
    // A filter narrowed the list, or the track was deleted: there is no
    // neighbour to move to, so the list begins again.
    expect(call({ ids: [7, 8], current: 2 }).next).toBe(7)
    expect(call({ ids: [7, 8], current: 2, direction: -1 }).next).toBe(8)
  })

  it('has nothing to give from an empty list, in either mode', () => {
    expect(call({ ids: [] }).next).toBeNull()
    expect(call({ ids: [], shuffle: true }).next).toBeNull()
  })

  it('draws from the bag when the shuffle is on, never the current track', () => {
    const first = call({ shuffle: true, current: 2, random: seeded(21) })
    expect(first.next).not.toBe(2)
    const second = call({
      shuffle: true,
      current: first.next,
      cycle: first.cycle,
      random: seeded(21),
    })
    expect(second.next).not.toBe(first.next)
  })

  it('plays a shuffled pass in full before repeating anything', () => {
    const heard: number[] = []
    let cycle = emptyCycle()
    let current: number | null = null
    for (let i = 0; i < ids.length; i++) {
      const result = call({ shuffle: true, current, cycle, random: seeded(22) })
      expect(result.next).not.toBeNull()
      heard.push(result.next as number)
      current = result.next
      cycle = result.cycle
    }
    expect([...heard].sort((a, b) => a - b)).toEqual(ids)
    // And the pass is over, with repeat off.
    expect(call({ shuffle: true, current, cycle }).next).toBeNull()
  })

  it('keeps the pass when the shuffle is switched off and on again', () => {
    const drawn = call({ shuffle: true, random: seeded(23) })
    const linear = call({ current: drawn.next, cycle: drawn.cycle })
    // Turning the shuffle off must not quietly throw the pass away.
    expect(linear.cycle).toBe(drawn.cycle)
  })
})

describe('refillCycle', () => {
  it('deals a full set, once each', () => {
    const cycle = refillCycle([1, 2, 3, 4], null, seeded(1))
    expect([...cycle.bag].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(cycle.played).toEqual([])
  })

  it('leaves the track that just played out of the new set, but counts it as heard', () => {
    const cycle = refillCycle([1, 2, 3, 4], 3, seeded(1))
    expect(cycle.bag).not.toContain(3)
    // Counted as heard, so the pass still adds up to one play of every track.
    expect(cycle.played).toEqual([3])
    // But a list of one still has to be playable.
    expect(refillCycle([9], 9, seeded(1)).bag).toEqual([9])
  })
})

describe('openingTrack', () => {
  it('opens on the first row when the shuffle is off, leaving the pass alone', () => {
    const cycle = emptyCycle()
    const result = openingTrack({ ids: [1, 2, 3], shuffle: false, cycle })
    expect(result.next).toBe(1)
    // Nothing was dealt: pressing Play must not disturb a pass in progress.
    expect(result.cycle).toBe(cycle)
  })

  it('opens on a drawn row rather than the first when the shuffle is on', () => {
    // `random: () => 0` fixes the deal, so "not the first row" is a fact here
    // rather than a coin toss that fails one run in three.
    const result = openingTrack({
      ids: [1, 2, 3],
      shuffle: true,
      cycle: emptyCycle(),
      random: () => 0,
    })
    const expected = refillCycle([1, 2, 3], null, () => 0)
    expect(result.next).toBe(expected.bag[0])
    expect(result.next).not.toBe(1)
    // The opened track counts as heard and is out of the bag of its own pass,
    // so Play followed by Next cannot play it twice.
    expect(result.cycle.played[0]).toBe(result.next)
    expect(result.cycle.bag).not.toContain(result.next)
  })

  it('does not open on the track already playing', () => {
    const result = openingTrack({
      ids: [1, 2, 3],
      current: 2,
      shuffle: true,
      cycle: emptyCycle(),
      random: () => 0,
    })
    expect(result.next).not.toBe(2)
    expect(result.cycle.bag).not.toContain(2)
  })

  it('deals a fresh pass even when a spent one is handed to it', () => {
    // A pass heard through, with repeat off: nothing left to draw. Pressing Play
    // is the start of a new listen, so it must open something rather than stop.
    const spent: ShuffleCycle = { bag: [], played: [1, 2, 3], dealt: true }
    const result = openingTrack({
      ids: [1, 2, 3],
      shuffle: true,
      cycle: spent,
      random: () => 0,
    })
    expect(result.next).not.toBeNull()
    const fresh = refillCycle([1, 2, 3], null, () => 0)
    expect(result.next).toBe(fresh.bag[0])
  })

  it('has nothing to open on an empty list', () => {
    const cycle = emptyCycle()
    const result = openingTrack({ ids: [], shuffle: true, cycle })
    expect(result.next).toBeNull()
    expect(result.cycle).toBe(cycle)
  })
})
