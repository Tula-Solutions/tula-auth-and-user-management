import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildRegistry, drift } from '../src/build'
import { REGISTRY } from '../src/registry'

// Writes the registry's JSON from the sources under items/, or checks it is what they write.
//
//   bun run registry:generate                       write r/registry.json and r/<item>.json
//   bun run registry:check                          fail if r/ is not what the sources write
//                                                   (part of `verify`)
//   bun run registry:generate --base-url <url> --out <dir>
//                                                   build for another address, into another
//                                                   directory, to try an install from a local server
//
// The theme item is generated from @tula-tech/contract/theme; no item is written by hand.

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)

function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const checking = args.includes('--check')
const baseUrl = (option('--base-url') ?? REGISTRY.baseUrl).replace(/\/+$/, '')
const out = resolve(option('--out') ?? join(root, 'r'))

const built = buildRegistry({
  baseUrl,
  read: (source) => readFileSync(join(root, 'items', source), 'utf8'),
})

if (checking) {
  const present = existsSync(out) ? readdirSync(out).filter((name) => name.endsWith('.json')) : []
  const problems = drift(
    built,
    (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : null),
    present
  )
  if (problems.length > 0) {
    console.error(
      `packages/ui/r is out of date with its sources:\n${problems.map((line) => `  ${line}`).join('\n')}\nRun \`bun run registry:generate\`.`
    )
    process.exit(1)
  }
  console.log(`packages/ui/r matches its sources (${built.length} files)`)
} else {
  mkdirSync(out, { recursive: true })
  for (const file of built) {
    writeFileSync(join(out, file.name), file.text)
  }
  console.log(`wrote ${built.length} files to ${out}`)
}
