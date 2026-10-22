import { describe, expect, test } from 'bun:test'
import { chunksOf, selectorsOf } from './chunks'

// Run with the harness tests (`bun run test:harness`).

describe('chunksOf', () => {
  test('a page with only an introduction has nothing to chunk', () => {
    expect(chunksOf([500])).toEqual([])
    expect(chunksOf([])).toEqual([])
  })

  test('small sections are grouped up to the budget, in order', () => {
    expect(chunksOf([10, 40, 40, 40, 40, 40], 100)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 5 },
    ])
  })

  test('a section bigger than the budget is a run of its own', () => {
    expect(chunksOf([10, 20, 500, 20], 100)).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 2 },
      { from: 3, to: 3 },
    ])
  })

  test.each([
    [[1, 5, 9, 150_000, 1, 1, 300_000, 7, 7, 7]],
    [Array.from({ length: 800 }, (_, index) => (index * 37) % 5000)],
    [[0, 0, 0, 0]],
  ])('every section but the introduction is in exactly one run, in order', (sizes) => {
    const covered = chunksOf(sizes).flatMap((chunk) =>
      Array.from({ length: chunk.to - chunk.from + 1 }, (_, offset) => chunk.from + offset)
    )
    expect(covered).toEqual(Array.from({ length: sizes.length - 1 }, (_, index) => index + 1))
  })

  test('no run goes over the budget unless it is one section', () => {
    const sizes = Array.from({ length: 300 }, (_, index) => ((index * 7919) % 9000) + 1)
    for (const chunk of chunksOf(sizes, 10_000)) {
      const total = sizes.slice(chunk.from, chunk.to + 1).reduce((sum, size) => sum + size, 0)
      expect(chunk.from === chunk.to || total <= 10_000).toBe(true)
    }
  })
})

describe('selectorsOf', () => {
  test('names each section of a run', () => {
    expect(selectorsOf({ from: 3, to: 5 })).toEqual([
      '[data-docs-section="3"]',
      '[data-docs-section="4"]',
      '[data-docs-section="5"]',
    ])
  })
})
