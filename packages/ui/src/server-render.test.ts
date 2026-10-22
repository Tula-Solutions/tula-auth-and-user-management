import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

describe('server rendering', () => {
  test('every item renders without a DOM', () => {
    // A process of its own, without this suite's DOM preload: see `test-support/ssr-render.tsx`.
    const rendered = Bun.spawnSync(
      ['bun', 'run', join(import.meta.dir, '..', 'test-support', 'ssr-render.tsx')],
      { cwd: join(import.meta.dir, '..'), timeout: 30_000 }
    )
    expect(rendered.exitedDueToTimeout).toBeFalsy()
    expect(rendered.stderr.toString()).toBe('')
    expect(rendered.exitCode).toBe(0)
    const html = rendered.stdout.toString()
    // step-card: the title as the level asked for, the footer, the branding line.
    expect(html).toContain('Step title')
    expect(html).toContain('step footer')
    expect(html).toContain('<h2')
    expect(html).toContain('Secured by Tula')
    // status: the live region is in the page, the alert says its words.
    expect(html).toContain('status text')
    expect(html).toContain('role="alert"')
    expect(html).toContain('alert detail')
    // sign-in: a server draws nothing it cannot know (the flow has not started).
    expect(html).toContain('<output')
  }, 60_000)
})
