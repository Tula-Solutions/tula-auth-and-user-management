// Which servers a Playwright run needs, from the projects named on its command line. Playwright
// starts every `webServer` of a config whatever project is selected, so `playwright.config.ts`
// asks this before it builds the list. Pure, and tested by the harness (`projects.test.ts`).

/** The servers a run starts. */
export interface Servers {
  /** The fixture API and the Next.js example (ports 4317 to 4320). */
  api: boolean
  /** The documentation site (port 4321). */
  docs: boolean
}

/** The project patterns of `--project=x` and `--project x`, as written. */
function patternsOf(argv: string[]): string[] {
  return argv.flatMap((argument, index) => {
    if (argument.startsWith('--project=')) {
      return [argument.slice('--project='.length)]
    }
    const next = argv[index + 1]
    return argument === '--project' && next !== undefined ? [next] : []
  })
}

/** Playwright matches a project name case-insensitively, `*` standing for any run of characters. */
function matches(pattern: string, name: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'i').test(name)
}

/**
 * The servers a run starts.
 *
 * No `--project` means every project, so every server. `E2E_DOCS_ONLY=1` is the same as naming
 * the docs project alone, and applies only when no other project is selected.
 *
 * @param argv - The command line (`process.argv`).
 * @param env - The environment (`process.env`).
 * @param projects - The config's project names.
 * @returns Which servers to start.
 */
export function serversFor(
  argv: string[],
  env: Record<string, string | undefined>,
  projects: string[]
): Servers {
  const patterns = patternsOf(argv)
  const selected =
    patterns.length === 0
      ? projects
      : projects.filter((name) => patterns.some((pattern) => matches(pattern, name)))
  const others = selected.filter((name) => name !== 'docs')
  const docsOnly =
    (patterns.length > 0 && selected.length > 0 && others.length === 0) ||
    (env.E2E_DOCS_ONLY === '1' && (patterns.length === 0 || others.length === 0))
  return { api: !docsOnly, docs: selected.includes('docs') || docsOnly }
}
