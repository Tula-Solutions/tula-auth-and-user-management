import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { VERSION as CLI_VERSION } from '../../packages/cli/src/version'
import { VERSION as CREATE_TULA_VERSION } from '../../packages/create-tula/src/scaffold'
import { MCP_VERSION } from '../../packages/mcp/src/server'
import { type Manifest, PUBLISHABLE_PACKAGES } from '../../scripts/publish-manifest'

// One version, written in several places. Changesets moves the eleven packages of the fixed
// group together; four more places are kept by hand when a release is cut
// (docs/releasing.md, "First release", step 3): three constants a program prints or pins
// with, and the version of the API, which Changesets ignores and `tula doctor` compares
// with the CLI's own. One left behind is a CLI that warns about every deployment, or a
// scaffolded project pinned to a version that is not on npm. This test names the place.

const root = join(import.meta.dir, '..', '..')

const versionOf = async (dir: string) =>
  ((await Bun.file(join(root, dir, 'package.json')).json()) as Manifest).version

describe('the release’s version is the same everywhere it is written', () => {
  test('the publishable packages, the API and the three constants agree', async () => {
    const places: [string, string][] = []
    for (const dir of PUBLISHABLE_PACKAGES) {
      places.push([`${dir}/package.json`, await versionOf(dir)])
    }
    places.push(
      ['apps/api/package.json', await versionOf('apps/api')],
      ['VERSION in packages/create-tula/src/scaffold.ts', CREATE_TULA_VERSION],
      ['VERSION in packages/cli/src/version.ts', CLI_VERSION],
      ['MCP_VERSION in packages/mcp/src/server.ts', MCP_VERSION]
    )

    // Held to the first of the group, and reported place by place: a failure names what
    // was left behind and not only two strings.
    const expected = places[0]?.[1]
    expect(expected).toMatch(/^\d+\.\d+\.\d+/)
    const apart = places
      .filter(([, version]) => version !== expected)
      .map(([place, version]) => `${place} is ${version}, not ${expected}`)
    expect(apart).toEqual([])
    expect(places).toHaveLength(PUBLISHABLE_PACKAGES.length + 4)
  })
})
