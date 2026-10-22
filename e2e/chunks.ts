// How the docs browser tests cut a large page into pieces for axe (`tests/docs/site.spec.ts`).
// The build writes the size of each content section of a page (`page-stats.json`); a page above
// `CHUNK_THRESHOLD` has its sections grouped into runs of about `CHUNK_BUDGET`, each checked on
// its own, and the page minus those runs is checked as the frame. Pure, and tested by the
// harness (`chunks.test.ts`): the point is that no section escapes the checker.

/** A page whose document is bigger than this is checked in pieces (characters of HTML). */
export const CHUNK_THRESHOLD = 200_000

/**
 * The size a piece aims at. Axe's time grows with the nodes it visits (a 1.5 MB page took over
 * two minutes on a laptop and over five on CI), so a piece of this size stays well under a minute
 * on CI.
 */
export const CHUNK_BUDGET = 150_000

/** A run of consecutive sections, both ends included. */
export interface Chunk {
  from: number
  to: number
}

/**
 * Group the sections of a page into runs.
 *
 * Section 0 (the title and the introduction) is not in a run: it stays in the frame, so that the
 * page-level rules that need the `h1` find it. Every other section is in exactly one run, runs
 * are in order, and a run holds more than one section only while it stays within the budget (a
 * section bigger than the budget is a run of its own).
 *
 * @param sizes - The size of each section, in order (index 0 is the introduction).
 * @param budget - The size a run aims at.
 * @returns The runs, covering sections 1 to `sizes.length - 1`.
 */
export function chunksOf(sizes: number[], budget: number = CHUNK_BUDGET): Chunk[] {
  const chunks: Chunk[] = []
  let current: Chunk | null = null
  let size = 0
  for (let index = 1; index < sizes.length; index += 1) {
    const next = sizes[index] as number
    if (current !== null && size + next <= budget) {
      current.to = index
      size += next
    } else {
      current = { from: index, to: index }
      chunks.push(current)
      size = next
    }
  }
  return chunks
}

/**
 * The CSS selectors of the sections of a run.
 *
 * @param chunk - The run.
 * @returns One selector for each section's wrapper.
 */
export function selectorsOf(chunk: Chunk): string[] {
  return Array.from(
    { length: chunk.to - chunk.from + 1 },
    (_, offset) => `[data-docs-section="${chunk.from + offset}"]`
  )
}

/** Everything in the content but the introduction: what the frame test leaves out. */
export const BEYOND_INTRODUCTION = '[data-docs-section]:not([data-docs-section="0"])'
