import { describe, expect, test } from 'bun:test'
import { encodeQr, type QrMatrix } from './encode'
import { qrPath } from './svg'

type Rectangle = { x: number; y: number; width: number }

/** The path's rectangles; throws if anything else is in it. */
function rectangles(path: string): Rectangle[] {
  const found = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)]
  expect(found.map((match) => match[0]).join('')).toBe(path)
  return found.map((match) => {
    expect(match[3]).toBe(match[4] ?? '')
    return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]) }
  })
}

/** Fill the rectangles into a grid, counting how often each module is painted. */
function paint(path: string, size: number): number[][] {
  const grid = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  for (const { x, y, width } of rectangles(path)) {
    const row = grid[y] ?? []
    for (let i = x; i < x + width; i++) {
      row[i] = (row[i] ?? 0) + 1
    }
  }
  return grid
}

function matrixOf(rows: string[]): QrMatrix {
  return { size: rows.length, modules: rows.map((row) => [...row].map((cell) => cell === '#')) }
}

describe('qrPath', () => {
  test.each([
    ['a version 1 symbol', 'a'],
    ['an otpauth URI', 'otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP&issuer=Acme'],
    ['a version 10 symbol', 'x'.repeat(200)],
  ] as [string, string][])('%s: painting the path gives the matrix back', (_name, text) => {
    const matrix = encodeQr(text)
    const path = qrPath(matrix)
    const painted = paint(path, matrix.size)
    // Every dark module exactly once, no light module, nothing outside the symbol.
    expect(painted).toEqual(matrix.modules.map((row) => row.map(Number)))
    const dark = matrix.modules.flat().filter(Boolean).length
    const area = rectangles(path).reduce((sum, { width }) => sum + width, 0)
    expect(area).toBe(dark)
    for (const { x, y, width } of rectangles(path)) {
      expect(x + width <= matrix.size && y < matrix.size).toBe(true)
    }
  })

  test('neighbours in a row are one rectangle, so the path is far shorter than one per module', () => {
    const matrix = encodeQr('otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP&issuer=Acme')
    const dark = matrix.modules.flat().filter(Boolean).length
    expect(rectangles(qrPath(matrix)).length).toBeLessThan(dark * 0.6)
    // The top edge of the first finder pattern is seven modules drawn at once.
    expect(qrPath(matrix).startsWith('M0 0h7v1h-7z')).toBe(true)
  })

  test('runs at either edge, single modules and empty rows', () => {
    expect(qrPath(matrixOf(['##.#', '....', '.#..', '..##']))).toBe(
      'M0 0h2v1h-2zM3 0h1v1h-1zM1 2h1v1h-1zM2 3h2v1h-2z'
    )
  })

  test('nothing dark is an empty path', () => {
    expect(qrPath(matrixOf(['..', '..']))).toBe('')
    expect(qrPath({ size: 0, modules: [] })).toBe('')
  })
})
