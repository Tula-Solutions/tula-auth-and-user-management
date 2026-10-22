/** What runs a command: injected, so that the rule is tested without a repository. */
export type Run = (args: string[]) => { ok: boolean; out: string }

/** Run `git` in a directory, with a deadline: a child that never exits must not hang a build. */
export function runGit(root: string): Run {
  return (args) => {
    const result = Bun.spawnSync(['git', '-C', root, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 15_000,
    })
    return { ok: result.exitCode === 0, out: result.stdout.toString().trim() }
  }
}

/**
 * The date a file last changed, from git, or `undefined` for every file when git cannot say it
 * honestly. A shallow clone (which is what the Pages workflow checks out) gives every file the
 * date of the one commit it has, which would be a wrong `updated` on each page, so no date is
 * better than that one.
 *
 * @param run - Runs `git` in the repository.
 * @returns A function from a file (from the repository root) to `YYYY-MM-DD`, or `undefined`.
 */
export function lastUpdated(run: Run): (file: string) => string | undefined {
  const shallow = run(['rev-parse', '--is-shallow-repository'])
  if (!shallow.ok || shallow.out !== 'false') {
    return () => undefined
  }
  return (file) => {
    const result = run(['log', '-1', '--format=%cs', '--', file])
    return result.ok && /^\d{4}-\d{2}-\d{2}$/.test(result.out) ? result.out : undefined
  }
}
