import { expect, test } from 'bun:test'

// H-244: a predicate on a row's own id must also name its environment. Row-level security
// already bounds a query to the environment in scope; this holds the explicit predicate too, so
// a change of how the transaction is scoped cannot silently turn an id lookup into a lookup
// across environments. A scan of the source, since every call is a `.where(...)`.

const FILES = ['users.ts', 'sessions.ts']

/** The text of each `.where(...)` call, parentheses balanced. */
function whereCalls(source: string): string[] {
  const calls: string[] = []
  let from = source.indexOf('.where(')
  while (from !== -1) {
    let depth = 0
    let end = from + '.where'.length
    for (; end < source.length; end++) {
      if (source[end] === '(') {
        depth++
      } else if (source[end] === ')' && --depth === 0) {
        break
      }
    }
    calls.push(source.slice(from, end + 1))
    from = source.indexOf('.where(', end)
  }
  return calls
}

/** A comparison of a table's own `id` column with a value, e.g. `eq(users.id, userId)`. */
const ID_PREDICATE =
  /\b(?:eq|inArray)\((?:users|sessions|identities|refreshTokens)\.id,\s*(?!\w+\.)/

for (const file of FILES) {
  test(`every id predicate in ${file} also names the environment`, async () => {
    const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text()
    const withId = whereCalls(source).filter((call) => ID_PREDICATE.test(call))
    expect(withId.length).toBeGreaterThan(3)
    const unscoped = withId.filter((call) => !/environmentId/.test(call))
    expect(unscoped).toEqual([])
  })
}
