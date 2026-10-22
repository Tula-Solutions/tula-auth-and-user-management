/** What the info string of a fenced code block says after its language. */
export interface CodeMeta {
  /** The title or file name shown above the block (`title="app/layout.tsx"`). */
  title?: string
  /** The lines to highlight (`{1,3-5}`), 1-based, in order and without repeats. */
  highlight: number[]
}

const TITLE = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)')/
const RANGES = /(?:^|\s)\{([^{}]*)\}/

/**
 * Read the words after a code fence's language: `title="app/layout.tsx"` and `{1,3-5}`.
 *
 * GitHub ignores everything after the language, so a page that uses these still renders there.
 * Anything else in the info string is refused: a misspelt `titel="…"` would otherwise be
 * dropped without a word.
 *
 * @param meta - The info string without the language, or `null`.
 * @returns The title and the highlighted lines.
 * @throws Error naming the problem, for an empty title, a malformed range or a word it does not know.
 */
export function parseCodeMeta(meta: string | null | undefined): CodeMeta {
  let rest = (meta ?? '').trim()
  const result: CodeMeta = { highlight: [] }
  const title = TITLE.exec(rest)
  if (title !== null) {
    const value = (title[1] ?? title[2] ?? '').trim()
    if (value === '') {
      throw new Error('the code block has an empty title=""')
    }
    result.title = value
    rest = rest.replace(TITLE, ' ')
  }
  const ranges = RANGES.exec(rest)
  if (ranges !== null) {
    const lines = new Set<number>()
    for (const part of (ranges[1] as string).split(',')) {
      const range = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part)
      const from = range === null ? 0 : Number(range[1])
      const to = range?.[2] === undefined ? from : Number(range[2])
      if (range === null || from < 1 || to < from) {
        throw new Error(`the line range "${part.trim()}" in {${ranges[1]}} is not N or N-M`)
      }
      for (let line = from; line <= to; line += 1) {
        lines.add(line)
      }
    }
    result.highlight = [...lines].sort((a, b) => a - b)
    rest = rest.replace(RANGES, ' ')
  }
  const unknown = rest.trim()
  if (unknown !== '') {
    throw new Error(`the code block's "${unknown}" is not a title="…" or a {1,3-5} line range`)
  }
  return result
}

/**
 * The info string of a fence with its title removed, for a block that is a tab of a code
 * group: the tab is already named by the title.
 *
 * @param meta - The info string without the language, or `null`.
 * @returns What is left, or `null` when nothing is.
 */
export function withoutTitle(meta: string | null | undefined): string | null {
  const rest = (meta ?? '').replace(TITLE, ' ').trim()
  return rest === '' ? null : rest
}
