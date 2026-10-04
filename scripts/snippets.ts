import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

// The snippet blocks of the documentation (`scripts/docs.ts`): a block between
// `<!-- snippet: path#region -->` and `<!-- /snippet -->` is filled from a file of the
// repository. `docs:generate` and `docs:check` both fill through `withSnippets`, so a path
// that `snippetSource` refuses fails both.

/** Remove the indentation a nested declaration carries, so code blocks start at column 0. */
export function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  return [lines[0], ...lines.slice(1).map((line) => line.slice(indent))].join('\n')
}

const SNIPPET = /^<!-- snippet: (\S+?)(?:#([\w-]+))? -->$/
const SNIPPET_END = '<!-- /snippet -->'

const LANGUAGES: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  conf: 'nginx',
  sh: 'bash',
  css: 'css',
}

/** Whether `file` is `directory` itself or something inside it (both absolute). */
function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/**
 * Whether a path inside the repository names something a snippet must never copy: a local
 * secrets file (`.env`, `.env.local`, …; only `.env.example` is committed), a dependency's
 * tree or git's own files. Names are compared without case: `.ENV` opens `.env` on the file
 * systems of macOS and Windows.
 */
function isOffLimits(pathInRepository: string): boolean {
  return pathInRepository.split(sep).some((segment) => {
    const name = segment.toLowerCase()
    return (
      name === 'node_modules' ||
      name === '.git' ||
      (name.startsWith('.env') && name !== '.env.example')
    )
  })
}

/**
 * The file a snippet marker names, as an absolute path, once it is known to be a file of the
 * repository that may be shown.
 *
 * What a snippet reads is written into committed markdown, so the marker's path is untrusted:
 * it is checked as written and again after symbolic links are resolved, and a refusal names
 * the marker only, never the file it led to or anything in it.
 *
 * @param root - The repository's root, absolute.
 * @param path - The path as the marker has it, relative to the repository.
 * @param from - The markdown file holding the marker, for the message.
 * @returns The real path of the file to read.
 * @throws Error when the path is absolute, leaves the repository (by `..` or by a symbolic
 *   link), names a `.env*` file other than `.env.example`, lies under `node_modules` or
 *   `.git`, or does not exist.
 */
export function snippetSource(root: string, path: string, from: string): string {
  const refused = new Error(
    `docs: ${from} takes a snippet from ${path}, which is not allowed: a snippet is a file of the repository, by a relative path, and never a .env file, node_modules or .git`
  )
  const lexical = resolve(root, path)
  if (isAbsolute(path) || !isInside(root, lexical) || isOffLimits(relative(root, lexical))) {
    throw refused
  }
  let realRoot: string
  let real: string
  try {
    realRoot = realpathSync(root)
    real = realpathSync(lexical)
  } catch {
    throw new Error(`docs: ${from} takes a snippet from ${path}, which does not exist`)
  }
  if (!isInside(realRoot, real) || isOffLimits(relative(realRoot, real))) {
    throw refused
  }
  return real
}

/** The lines of a file, or of one `// #region name` … `// #endregion` block of it. */
function snippetLines(
  root: string,
  path: string,
  region: string | undefined,
  from: string
): string[] {
  const file = snippetSource(root, path, from)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`docs: ${from} takes a snippet from ${path}, which does not exist`)
  }
  const lines = text.replace(/\n$/, '').split('\n')
  if (!region) {
    return lines
  }
  const start = lines.findIndex((line) => line.trim() === `// #region ${region}`)
  const end = lines.findIndex((line, index) => index > start && line.trim() === '// #endregion')
  if (start === -1 || end === -1) {
    throw new Error(`docs: ${from} takes the region \`${region}\` from ${path}, which has none`)
  }
  return dedent(['', ...lines.slice(start + 1, end)].join('\n'))
    .split('\n')
    .slice(1)
}

/** A markdown file with every snippet block filled from its source. */
export function withSnippets(root: string, markdown: string, from: string): string {
  const out: string[] = []
  const lines = markdown.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const match = SNIPPET.exec(line)
    out.push(line)
    if (!match) {
      continue
    }
    const [, path = '', region] = match
    const end = lines.indexOf(SNIPPET_END, index)
    if (end === -1) {
      throw new Error(`docs: ${from} opens a snippet (${path}) and never closes it`)
    }
    const extension = path.split('.').at(-1) ?? ''
    out.push(
      `\`\`\`${LANGUAGES[extension] ?? ''}`,
      ...snippetLines(root, path, region, from),
      '```',
      SNIPPET_END
    )
    index = end
  }
  return out.join('\n')
}
