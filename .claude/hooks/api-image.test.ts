import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  API_IMAGE_REPOSITORY,
  DEFAULT_API_IMAGE,
  VERSION,
} from '../../packages/create-tula/src/scaffold'
import { IMAGE, imageChannel, planImage, registryTags, versionsPath } from '../../scripts/api-image'

// The API image is published by a workflow that runs only on `main`, where no pull request
// exercises it, and a new project pulls what it pushed by name. These tests are what runs
// before a merge: the decisions of `scripts/api-image.ts`, the rules the workflow is held
// to, and the one name the workflow, the script and `create-tula` must agree on.

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

interface Step {
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  steps: Step[]
}
interface Workflow {
  on: unknown
  permissions: Record<string, string>
  env: Record<string, string>
  jobs: Record<string, Job>
}

const source = read('.github/workflows/image.yml')
const workflow = Bun.YAML.parse(source) as Workflow
// Comments explain what is absent; only the lines that do something are checked.
const active = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

describe('one name for the image', () => {
  test('the workflow pushes, the script asks about and create-tula names the same image', () => {
    expect(IMAGE).toBe('ghcr.io/tula-solutions/tula-api')
    expect(workflow.env.IMAGE).toBe(IMAGE)
    expect(API_IMAGE_REPOSITORY).toBe(IMAGE)
  })

  // A moving tag would give two projects made a week apart different servers, and a server
  // that is not the one the project's packages were released with.
  test('a new project names the image of its own version, never a moving or a local tag', () => {
    expect(DEFAULT_API_IMAGE).toBe(`${IMAGE}:${VERSION}`)
    expect(DEFAULT_API_IMAGE).not.toMatch(/:(alpha|latest|local)$/)
    // The tag the workflow writes for that version is the same string.
    expect(planImage(VERSION, []).version).toBe(VERSION)
  })

  test('the registry is asked about that image’s versions', () => {
    expect(versionsPath(IMAGE)).toBe('/orgs/tula-solutions/packages/container/tula-api/versions')
  })

  test.each([
    'docker.io/tula/tula-api',
    'ghcr.io/tula-solutions',
    'ghcr.io/tula-solutions/tula-api:alpha',
    'ghcr.io/tula-solutions/tula-api/../../users',
    'ghcr.io/Tula-Solutions/tula-api',
  ])('%s is not an image whose versions are asked for', (image) => {
    expect(() => versionsPath(image)).toThrow('is not an image of ghcr.io/<owner>/<name>')
  })
})

describe('which tags a version gets', () => {
  test.each([
    ['0.1.0-alpha.2', 'alpha'],
    ['0.1.0-alpha.10', 'alpha'],
    ['1.0.0-beta.1', 'beta'],
    ['1.0.0', 'latest'],
    ['12.3.45', 'latest'],
  ])('%s is released under %s', (version, channel) => {
    expect(imageChannel(version)).toBe(channel)
  })

  // What reaches a tag and a label of the image reaches a shell line of the workflow too:
  // nothing but a release's version gets that far.
  test.each([
    '0.0.0',
    '',
    'latest',
    '0.1.0-alpha',
    '0.1.0-alpha.1+build',
    '0.1.0-ALPHA.1',
    'v0.1.0',
    '0.1',
    '0.1.0 ',
    '0.1.0\n1.0.0',
    '0.1.0-alpha.1; echo injected',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an expression a workflow would expand, as text
    '0.1.0-${{ github.token }}.1',
  ])('%j is never a tag', (version) => {
    expect(() => imageChannel(version)).toThrow('is not a version an image is published under')
    expect(() => planImage(version, [])).toThrow()
  })
})

describe('a version is pushed once', () => {
  test('a version the registry does not hold is built', () => {
    expect(planImage('0.1.0-alpha.2', [])).toEqual({
      version: '0.1.0-alpha.2',
      channel: 'alpha',
      publish: true,
    })
    expect(planImage('0.1.0-alpha.2', ['0.1.0-alpha.1', 'alpha']).publish).toBe(true)
  })

  test('a version the registry holds is not built again', () => {
    expect(planImage('0.1.0-alpha.2', ['0.1.0-alpha.1', '0.1.0-alpha.2', 'alpha'])).toEqual({
      version: '0.1.0-alpha.2',
      channel: 'alpha',
      publish: false,
    })
  })

  // Only the whole tag counts: `0.1.0-alpha.2` is not there because `0.1.0-alpha.20` is.
  test('a tag that merely starts like the version does not count', () => {
    expect(planImage('0.1.0-alpha.2', ['0.1.0-alpha.20', '0.1.0-alpha']).publish).toBe(true)
  })

  test('the tags are what the registry listed, one a line', () => {
    expect(
      registryTags({ exitCode: 0, stdout: '0.1.0-alpha.1\nalpha\n\n 0.1.0-alpha.2 \n', stderr: '' })
    ).toEqual(['0.1.0-alpha.1', 'alpha', '0.1.0-alpha.2'])
    expect(registryTags({ exitCode: 0, stdout: '', stderr: '' })).toEqual([])
  })

  test('a package that does not exist yet holds no tag', () => {
    expect(
      registryTags({ exitCode: 1, stdout: '', stderr: 'gh: Package not found. (HTTP 404)\n' })
    ).toEqual([])
  })

  // Read as "holds nothing", any of these would push over a version that may be there.
  test.each([
    ['a refused token', 1, 'gh: Bad credentials (HTTP 401)'],
    ['no permission', 1, 'gh: Resource not accessible by integration (HTTP 403)'],
    ['a server error', 1, 'gh: Server Error (HTTP 500)'],
    ['no network', 1, 'error connecting to api.github.com'],
    ['a 404 only in passing', 1, 'gh: see https://example.test/HTTP 404 (HTTP 502)'],
    ['a call that timed out', null, ''],
    ['no gh at all', 127, 'gh: command not found'],
  ])('%s fails the plan instead of reading as "not there"', (_what, exitCode, stderr) => {
    expect(() => registryTags({ exitCode, stdout: '', stderr })).toThrow(
      'the registry could not be asked which versions it holds'
    )
  })
})

describe('the image workflow', () => {
  test('runs for a push to main and for nothing else', () => {
    expect(workflow.on).toEqual({ push: { branches: ['main'] } })
    expect(active).not.toMatch(
      /pull_request|workflow_dispatch|workflow_run|workflow_call|schedule:|repository_dispatch/
    )
  })

  test('stores no secret: it pushes with the run’s own token', () => {
    expect(active).not.toMatch(/secrets\./)
    for (const name of ['build', 'tag']) {
      const login = workflow.jobs[name]?.steps.find((step) =>
        step.uses?.startsWith('docker/login-action@')
      )
      expect(login?.with).toEqual({
        registry: 'ghcr.io',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
        username: '${{ github.actor }}',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
        password: '${{ github.token }}',
      })
    }
  })

  test('only the two jobs that push may write, and only packages', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['plan', 'build', 'tag', 'public'])
    expect(workflow.jobs.plan?.permissions).toEqual({ contents: 'read', packages: 'read' })
    expect(workflow.jobs.build?.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(workflow.jobs.tag?.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(active.match(/:\s*write\b/g)).toEqual([': write', ': write'])
    expect(active).not.toMatch(/id-token|continue-on-error/)
  })

  test('nothing is built or tagged unless the plan said the version is new', () => {
    expect(workflow.jobs.plan?.steps.map((step) => step.run).filter(Boolean)).toEqual([
      'bun run scripts/api-image.ts',
    ])
    expect(workflow.jobs.build?.needs).toBe('plan')
    expect(workflow.jobs.build?.if).toBe("needs.plan.outputs.publish == 'true'")
    // No status function: a skipped or failed build skips the tagging with it.
    expect(workflow.jobs.tag?.needs).toEqual(['plan', 'build'])
    expect(workflow.jobs.tag?.if).toBeUndefined()
  })

  test('each architecture is built on a runner of its own, from the API’s Dockerfile', () => {
    const build = workflow.jobs.build as Job & {
      strategy: { matrix: { include: { arch: string; runner: string }[] } }
    }
    expect(build.strategy.matrix.include).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04' },
      { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    ])
    const step = build.steps.find((item) => item.uses?.startsWith('docker/build-push-action@'))
    expect(step?.with).toMatchObject({
      context: '.',
      file: 'apps/api/Dockerfile',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      platforms: 'linux/${{ matrix.arch }}',
    })
    // Pushed under a digest: a half-built release never carries the version's tag.
    expect(String(step?.with?.outputs)).toContain('push-by-digest=true')
    expect(step?.with).not.toHaveProperty('tags')
  })

  test('the two tags are written in one place, from the plan’s values, never from the event', () => {
    const tagging = workflow.jobs.tag?.steps.filter((step) => step.run !== undefined) ?? []
    expect(tagging).toHaveLength(1)
    const [step] = tagging
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(step?.env?.VERSION).toBe('${{ needs.plan.outputs.version }}')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(step?.env?.CHANNEL).toBe('${{ needs.plan.outputs.channel }}')
    expect(step?.run).toContain('--tag "$IMAGE:$VERSION"')
    expect(step?.run).toContain('--tag "$IMAGE:$CHANNEL"')
    expect(step?.run).toContain('test "$(ls | wc -l)" -eq 2')
    expect(active.match(/--tag /g)).toHaveLength(2)
    // An expression inside a shell line is expanded before the shell reads it: every value
    // a `run` uses arrives through `env`.
    for (const job of Object.values(workflow.jobs)) {
      for (const { run } of job.steps) {
        expect(run ?? '').not.toContain('${{')
      }
    }
    expect(active).not.toMatch(/github\.event\.|github\.head_ref|github\.ref_name/)
  })

  // A package is private when GitHub creates it. Without this job the first release would
  // look done while every new project's `tula dev` was answered "denied".
  test('the last job pulls as a stranger, also when nothing was built', () => {
    const job = workflow.jobs.public
    expect(job?.needs).toEqual(['plan', 'build', 'tag'])
    expect(job?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      "${{ !cancelled() && needs.plan.result == 'success' && needs.build.result != 'failure' && needs.tag.result != 'failure' }}"
    )
    expect(job?.permissions).toBeUndefined()
    expect(job?.steps.some((step) => step.uses !== undefined)).toBe(false)
    const [pull] = job?.steps ?? []
    expect(pull?.run).toContain('docker pull --quiet --platform "$platform" "$IMAGE:$VERSION"')
    expect(pull?.run).toContain('linux/amd64 linux/arm64')
    expect(pull?.run).toContain('exit 1')
    expect(pull?.run).not.toMatch(/docker login|GH_TOKEN|github\.token/)
  })

  // GitHub keeps one pending run a concurrency group and cancels an older pending one, and
  // this workflow cannot be started by hand: a release whose run was cancelled has no image
  // until that run is run again. The runbook has to say so.
  test('the runbook says what to do about a run that was cancelled by a later push', () => {
    expect(source).toContain('cancel-in-progress: false')
    const doc = read('docs/releasing.md').replace(/\s+/g, ' ')
    expect(doc).toContain('**One release at a time.**')
    expect(doc).toMatch(/cancelled[^.]*\. Run it again from the Actions page/)
  })

  test('the release workflow is left as it was: the image is not a job of it', () => {
    const release = read('.github/workflows/release.yml')
    expect(release).not.toMatch(/ghcr\.io|packages:\s*write|docker\//)
  })
})

// The quickstart's checkout path builds `tula-api:local` in its first step. A project made
// without `--api-image` names the published image of the checkout's version instead, which
// a checkout between releases does not have on the registry: the stack would not start, and
// the image just built would go unused.
describe('the quickstart from a checkout uses the image it built', () => {
  const quickstart = read('docs/quickstart.md')
  const invocations = quickstart
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => line.includes('dist/bin.js'))

  test('it builds the local tag first', () => {
    expect(quickstart).toContain('docker build -f apps/api/Dockerfile -t tula-api:local .')
    expect(invocations.length).toBeGreaterThanOrEqual(4)
  })

  test.each(invocations)('%s', (line) => {
    expect(line).toContain('--api-image tula-api:local')
  })
})
