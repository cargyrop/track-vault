import { describe, expect, it } from 'vitest'
import { dedupeGenres, mergeGenres, parseGenres } from './genres'

/**
 * The genre rules, which used to be written out once per caller.
 *
 * These assert the two things every caller depends on and none of them owned:
 * that a genre is stored lower-cased, and that the same genre is never listed
 * twice however it was spelled on the way in.
 */

describe('dedupeGenres', () => {
  it('removes repeats regardless of case, keeping the first spelling seen', () => {
    expect(dedupeGenres(['Metal', 'metal', 'METAL'])).toEqual(['Metal'])
    expect(dedupeGenres(['Rock', 'Metal', 'rock'])).toEqual(['Rock', 'Metal'])
  })

  it('drops blanks rather than storing empty chips', () => {
    expect(dedupeGenres(['', '  ', 'Rock'])).toEqual(['Rock'])
    expect(dedupeGenres([null as unknown as string, 'Rock'])).toEqual(['Rock'])
  })

  it('trims the values it keeps', () => {
    expect(dedupeGenres(['  Rock  '])).toEqual(['Rock'])
  })
})

describe('parseGenres', () => {
  it('splits on commas and lower-cases, which is the stored form', () => {
    expect(parseGenres('Prog Rock, PSYCHEDELIC')).toEqual([
      'prog rock',
      'psychedelic',
    ])
  })

  it('copes with the spacing people actually type', () => {
    expect(parseGenres('  rock ,, metal , ')).toEqual(['rock', 'metal'])
    expect(parseGenres('')).toEqual([])
  })

  it('folds a repeat into the first spelling', () => {
    expect(parseGenres('Rock, rock, ROCK')).toEqual(['rock'])
  })
})

describe('mergeGenres', () => {
  it('adds incoming genres to the field, still one spelling each', () => {
    expect(mergeGenres('rock', ['Metal', 'ROCK'])).toBe('rock, metal')
    expect(mergeGenres('', ['Metal'])).toBe('metal')
    expect(mergeGenres('rock', [])).toBe('rock')
  })

  it('returns what the edit field holds, so it can go straight back in', () => {
    // A comma-separated string, not an array — the dialogs put it in a text input.
    expect(typeof mergeGenres('rock', ['metal'])).toBe('string')
  })
})
