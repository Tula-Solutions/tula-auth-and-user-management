import { join } from 'node:path'

// `bun run dev`: build the site, then serve it. There is no hot reload; rerun it after changing
// a page of docs/ or the app.

const root = join(import.meta.dir, '..')

async function run(script: string): Promise<void> {
  const child = Bun.spawn(['bun', 'run', script], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await child.exited) !== 0) {
    process.exit(1)
  }
}

await run('scripts/build.ts')
await run('scripts/serve.ts')
