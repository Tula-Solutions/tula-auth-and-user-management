import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// What a workflow trusts and what it leaves lying around for the code it runs (TULA-157,
// H-339..H-351). A rule here is held for every workflow, so a new one cannot skip it.
type Step = { uses?: string; run?: string; with?: Record<string, unknown> }
type Workflow = { jobs: Record<string, { steps?: Step[] }> }

const dir = join(import.meta.dir, '..', '..', '.github', 'workflows')
const workflows = readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    source: readFileSync(join(dir, file), 'utf8'),
    steps: Object.values(
      (Bun.YAML.parse(readFileSync(join(dir, file), 'utf8')) as Workflow).jobs
    ).flatMap((job) => job.steps ?? []),
  }))

describe('workflow supply chain', () => {
  test('every action is pinned to a 40-character commit SHA, with its version as a comment', () => {
    for (const { file, steps, source } of workflows) {
      for (const step of steps.filter((one) => one.uses && !one.uses.startsWith('./'))) {
        expect(step.uses, file).toMatch(/@[0-9a-f]{40}$/)
        const line = source.split('\n').find((text) => text.includes(`uses: ${step.uses}`))
        expect(line, `${file}: ${step.uses}`).toMatch(/# v\d/)
      }
    }
  })

  test('no checkout leaves the job token in .git/config for the code that runs after it', () => {
    for (const { file, steps } of workflows) {
      for (const step of steps.filter((one) => one.uses?.startsWith('actions/checkout@'))) {
        expect(step.with?.['persist-credentials'], file).toBe(false)
      }
    }
  })

  test('the publish jobs install without running dependencies’ lifecycle scripts', () => {
    for (const file of ['release.yml', 'github-packages.yml']) {
      const installs = workflows
        .find((one) => one.file === file)
        ?.steps.filter((step) => step.run?.startsWith('bun install'))
      expect(installs?.length, file).toBeGreaterThan(0)
      for (const step of installs ?? []) {
        expect(step.run, file).toContain('--ignore-scripts')
      }
    }
  })
})
