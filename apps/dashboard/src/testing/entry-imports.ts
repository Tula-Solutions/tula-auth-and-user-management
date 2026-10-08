import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// A static walk of what a module loads when it is imported, for the one rule a component
// test cannot see: what a route file runs before its screen is loaded (`validateSearch`,
// `beforeLoad`) must not reach Zod. TanStack Router's plugin splits a route's `component`
// into a chunk of its own and leaves the rest of the file in the entry chunk, whose imports
// are evaluated before `lib/zod-csp.ts` has told Zod not to probe for `eval`.

/** The contract's entry points that hold no Zod schema (AGENTS.md, "Publishable packages"). */
const ZOD_FREE_CONTRACT = new Set([
  '@tula/contract/error-codes',
  '@tula/contract/event-types',
  '@tula/contract/headers',
  '@tula/contract/password-rules',
  '@tula/contract/theme',
  '@tula/contract/issuer',
  '@tula/contract/webhook-signature',
])

/** What {@link entryImports} found. */
export interface EntryImports {
  /** Every source file of the app the walk loaded, the entry included. */
  reached: string[]
  /** The specifiers that build a Zod schema when loaded: `zod` and the contract's schemas. */
  forbidden: string[]
  /** A route file's screen modules: split off by the router, and not walked. */
  lazy: string[]
}

interface Import {
  specifier: string
  /** The imported names; empty for a namespace, a default or a side-effect import. */
  names: string[]
}

/** The value imports and re-exports of a module. `import type` loads nothing. */
function importsOf(code: string): Import[] {
  const found: Import[] = []
  // The clause is names, braces, commas and `*` only: an `export function` or an
  // `export const` has a bracket or an `=` before any quote, and is no import.
  const statement =
    /^\s*(?:import|export)\s+(?!type[\s{])(?:([\w$*\s,{}]+?)\s+from\s+)?['"]([^'"]+)['"]/gm
  for (const match of code.matchAll(statement)) {
    const clause = match[1] ?? ''
    const braces = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? ''
    const names = braces
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '' && !name.startsWith('type '))
      .map((name) => name.split(/\s+as\s+/)[0] as string)
    // `import { type A, type B } from` loads nothing either.
    if (braces !== '' && names.length === 0 && !/^[\w$]+\s*,/.test(clause)) {
      continue
    }
    found.push({ specifier: match[2] as string, names })
  }
  return found
}

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

function isForbidden(specifier: string): boolean {
  if (specifier === 'zod' || specifier.startsWith('zod/')) {
    return true
  }
  return (
    (specifier === '@tula/contract' || specifier.startsWith('@tula/contract/')) &&
    !ZOD_FREE_CONTRACT.has(specifier)
  )
}

/**
 * Walk the static imports of a source file of the app, through `~/` and relative
 * specifiers, and say what they reach.
 *
 * In a file under `routes/`, an import of nothing but `…Screen` names from a `*-screen`
 * module is the route's component and is not followed: the router's plugin moves it, and
 * the function that uses it, to a chunk loaded later. Everything else is followed.
 * A package is not walked into: only named.
 *
 * @param entry - The file to start from.
 * @param src - The app's `src` directory, which `~/` stands for.
 * @param options - `everything`: follow a route's screen too.
 * @returns What was reached, what of it builds Zod schemas, and what was left as lazy.
 * @throws Error for a `~/` or relative import that resolves to no file: a walk that
 *   silently skipped one would prove nothing.
 */
export function entryImports(
  entry: string,
  src: string,
  options: { everything?: boolean } = {}
): EntryImports {
  const reached = new Set<string>()
  const forbidden = new Set<string>()
  const lazy = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (reached.has(file)) {
      continue
    }
    reached.add(file)
    const isRoute = file.startsWith(join(src, 'routes'))
    for (const { specifier, names } of importsOf(readFileSync(file, 'utf8'))) {
      const local = specifier.startsWith('~/')
        ? join(src, specifier.slice(2))
        : specifier.startsWith('.')
          ? join(dirname(file), specifier)
          : null
      if (local === null) {
        if (isForbidden(specifier)) {
          forbidden.add(specifier)
        }
        continue
      }
      const resolved = resolveFile(local)
      if (resolved === null) {
        // A stylesheet or another asset is no module that could build a schema.
        if (/\.(css|svg|png|json)$/.test(specifier)) {
          continue
        }
        throw new Error(`${specifier}, imported by ${file}, resolves to no file`)
      }
      const screen =
        isRoute &&
        !options.everything &&
        /-screen(\.tsx?)?$/.test(specifier) &&
        names.length > 0 &&
        names.every((name) => name.endsWith('Screen'))
      if (screen) {
        lazy.add(resolved)
      } else {
        queue.push(resolved)
      }
    }
  }
  return { reached: [...reached], forbidden: [...forbidden], lazy: [...lazy] }
}
