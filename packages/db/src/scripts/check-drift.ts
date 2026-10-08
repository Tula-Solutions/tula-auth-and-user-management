import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// Fails when src/schema has changes that no committed migration captures. Generates into a
// throwaway copy of migrations/ and requires positive evidence either way, because drizzle-kit
// exits 0 even when it crashes.
const packageDir = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'tula-db-drift-'))

function fail(message: string): never {
  process.stderr.write(`db:check: ${message}\n`)
  process.exit(1)
}

try {
  cpSync(join(packageDir, 'migrations'), scratch, { recursive: true })
  const before = readdirSync(scratch).length
  const result = Bun.spawnSync(
    [
      'bunx',
      'drizzle-kit',
      'generate',
      '--dialect=postgresql',
      '--schema=./src/schema/index.ts',
      // drizzle-kit prepends "./" to --out, so it must be relative to the package.
      `--out=${relative(packageDir, scratch)}`,
    ],
    { cwd: packageDir, stdout: 'pipe', stderr: 'pipe' }
  )
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`

  if (readdirSync(scratch).length !== before) {
    fail('src/schema has changes without a migration. Run `bun run db:generate` and commit it.')
  }
  if (result.exitCode !== 0 || !output.includes('No schema changes')) {
    fail(`could not verify schema drift (drizzle-kit output below)\n${output}`)
  }
  process.stdout.write('db:check: schema and migrations are in sync\n')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
