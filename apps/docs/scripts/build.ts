import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE } from '../src/lib/config'
import { LinkError } from '../src/lib/links'
import { RenderError } from '../src/lib/markdown'
import { resolveOutDir } from '../src/lib/paths'
import { buildSite, writeSite } from '../src/lib/site'
import { tokensCss } from '../src/lib/tokens'

// Builds the documentation site into dist/:
//
//   bun run build            tokens, the script and stylesheet (Vite), then one static
//                            index.html per page, the search index and the images
//   bun run build --check    renders every page in memory and writes nothing: the part of the
//                            build that can fail for a file, a link or an anchor. `verify` runs it.
//
// A Markdown file that cannot be rendered, or a relative link or anchor that cannot be resolved,
// stops the build with the file and the link named.

const root = join(import.meta.dir, '..')
// Resolved (and refused if it is not apps/docs/dist or a temporary directory) before anything is
// written or deleted; Vite (vite.config.ts) and serve.ts use the same function.
const outDir = resolveOutDir()
const check = process.argv.includes('--check')

async function bundle(): Promise<{ css: string[]; js: string }> {
  await Bun.write(join(root, 'src/styles/tokens.gen.css'), tokensCss())
  // Vite runs as the process it launches itself as (Node): its config reads no Bun API.
  const child = Bun.spawn(['bunx', 'vite', 'build', '--logLevel', 'warn'], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 180_000,
  })
  if ((await child.exited) !== 0) {
    throw new Error('vite build failed')
  }
  const manifest = JSON.parse(
    await readFile(join(outDir, '.vite/manifest.json'), 'utf8')
  ) as Record<string, { file: string; css?: string[] }>
  const entry = manifest['src/client/main.ts']
  if (entry === undefined) {
    throw new Error('the bundle has no entry for src/client/main.ts')
  }
  return { js: `${BASE}${entry.file}`, css: (entry.css ?? []).map((file) => `${BASE}${file}`) }
}

try {
  // Render first: a file or a link that cannot be rendered stops the build before `bundle()`
  // empties dist/, so a bad edit leaves the previous build in place.
  const checked = await buildSite({ css: [], js: '' })
  if (check) {
    console.log(`docs site: ${checked.pages.length} pages render, every link and anchor resolves`)
  } else {
    const site = await buildSite(await bundle())
    await writeSite(site, outDir)
    console.log(
      `docs site: wrote ${site.documents.size} pages and ${site.index.length} search entries to apps/docs/dist`
    )
  }
} catch (error) {
  if (error instanceof RenderError || error instanceof LinkError) {
    console.error(`docs site: ${error.message}`)
    process.exit(1)
  }
  throw error
}
