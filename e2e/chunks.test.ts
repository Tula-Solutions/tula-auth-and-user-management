import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CHUNK_BUDGET, chunksOf, lineRangesOf, lineSelector, selectorsOf } from './chunks'

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

describe('lineRangesOf', () => {
  test('a block that fits the budget is one range', () => {
    expect(lineRangesOf(100, 40, 150)).toEqual([{ from: 1, to: 40 }])
  })

  test.each([
    [552_000, 8_800, 150_000],
    [301, 7, 100],
    [1_000_000, 3, 10],
  ])(
    'the ranges cover every line once, in order (%d characters, %d lines)',
    (size, lines, budget) => {
      const ranges = lineRangesOf(size, lines, budget)
      const covered = ranges.flatMap((range) =>
        Array.from({ length: range.to - range.from + 1 }, (_, offset) => range.from + offset)
      )
      expect(covered).toEqual(Array.from({ length: lines }, (_, index) => index + 1))
    }
  )

  test('a big block is cut into pieces of about the budget', () => {
    expect(lineRangesOf(552_000, 8_800, 150_000)).toHaveLength(4)
  })

  test('no lines, no ranges', () => {
    expect(lineRangesOf(500_000, 0)).toEqual([])
  })

  test('selects a range of the lines of one section', () => {
    expect(lineSelector(15, { from: 2201, to: 4400 })).toBe(
      '[data-docs-section="15"] .line:nth-child(n+2201):nth-child(-n+4400)'
    )
  })
})

describe('the size of a section and the size of a piece', () => {
  test("the renderer's section cap is below the browser tests' piece", () => {
    const source = readFileSync(`${import.meta.dir}/../apps/docs/src/lib/markdown.ts`, 'utf8')
    const cap = Number(/SECTION_CAP = ([\d_]+)/.exec(source)?.[1]?.replaceAll('_', ''))
    expect(cap).toBeGreaterThan(0)
    expect(cap).toBeLessThan(CHUNK_BUDGET)
  })
})
