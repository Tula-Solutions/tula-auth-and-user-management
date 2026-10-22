import { describe, expect, test } from 'bun:test'
import { estimateMs, laneTargets, parseEnvironments, runScenarios } from './lanes'
import type { ScenarioResult, Target } from './runner'
import { type Scenario, ScenarioSchema } from './scenario'

const scenario = (name: string, steps: unknown[] = [], extra: object = {}): Scenario =>
  ScenarioSchema.parse({
    name,
    description: 'A test scenario.',
    steps: steps.length > 0 ? steps : [{ name: 'wait', wait: '1s' }],
    ...extra,
  })

const target = (key: string): Target => ({
  baseUrl: 'http://tula.test',
  publishableKey: `pk_${key}`,
  fetch: async () => new Response(null),
  emailCode: async () => '000000',
  wait: async () => {},
})

/** A `run` that takes a moment, and records who ran at once and on which target. */
function recorder(durations: Record<string, number> = {}) {
  let peak = 0
  let sharedLane = false
  const started: string[] = []
  const overlaps: string[] = []
  const active = new Set<string>()
  const onTarget = new Map<string, number>()
  const run = async (s: Scenario, t: Target): Promise<ScenarioResult> => {
    for (const other of active) {
      overlaps.push(`${other}+${s.name}`)
    }
    active.add(s.name)
    started.push(s.name)
    peak = Math.max(peak, active.size)
    const on = (onTarget.get(t.publishableKey) ?? 0) + 1
    onTarget.set(t.publishableKey, on)
    if (on > 1) {
      sharedLane = true
    }
    await Bun.sleep(durations[s.name] ?? 20)
    onTarget.set(t.publishableKey, (onTarget.get(t.publishableKey) ?? 1) - 1)
    active.delete(s.name)
    return { name: s.name, status: 'passed', steps: [] }
  }
  return { run, peak: () => peak, sharedLane: () => sharedLane, started, overlaps }
}

const names = (list: string[]) => list.map((name) => scenario(name))

describe('runScenarios', () => {
  test('scenarios in different environments run at the same time', async () => {
    const r = recorder()
    await runScenarios(names(['a', 'b', 'c', 'd']), [target('1'), target('2'), target('3')], {
      run: r.run,
    })
    expect(r.peak()).toBe(3)
  })

  test('one environment never runs two scenarios at once', async () => {
    const r = recorder()
    await runScenarios(names(['a', 'b', 'c', 'd', 'e', 'f']), [target('1'), target('2')], {
      run: r.run,
    })
    expect(r.sharedLane()).toBe(false)
    expect(r.peak()).toBe(2)
  })

  test('with one environment it is the plain sequential run', async () => {
    const r = recorder()
    await runScenarios(names(['a', 'b', 'c']), [target('1')], { run: r.run })
    expect(r.peak()).toBe(1)
    expect(r.started).toHaveLength(3)
  })

  test('a serial scenario never overlaps another one', async () => {
    const r = recorder({ s: 60 })
    await runScenarios(
      names(['a', 'b', 's', 'c', 'd', 'e']),
      [target('1'), target('2'), target('3')],
      {
        run: r.run,
        serial: (s) => s.name === 's',
      }
    )
    expect(r.overlaps.filter((pair) => pair.split('+').includes('s'))).toEqual([])
    expect(r.started).toHaveLength(6)
  })

  test('the results come back in the order of the scenarios', async () => {
    const r = recorder({ a: 80, b: 10, c: 40 })
    const results = await runScenarios(
      names(['a', 'b', 'c']),
      [target('1'), target('2'), target('3')],
      {
        run: r.run,
      }
    )
    expect(results.map((result) => result.name)).toEqual(['a', 'b', 'c'])
  })

  test('each result is reported as it finishes', async () => {
    const r = recorder({ a: 80, b: 5 })
    const seen: string[] = []
    await runScenarios(names(['a', 'b']), [target('1'), target('2')], {
      run: r.run,
      onResult: (result) => seen.push(result.name),
    })
    expect(seen).toEqual(['b', 'a'])
  })

  test('the longest scenarios start first', async () => {
    const r = recorder()
    const scenarios = [
      scenario('short'),
      scenario('long', [{ name: 'w', wait: '61s' }]),
      scenario('middle', [{ name: 'w', wait: '30s' }]),
    ]
    await runScenarios(scenarios, [target('1')], { run: r.run })
    expect(r.started).toEqual(['long', 'middle', 'short'])
  })

  test('a scenario that throws is a failed result and the others still run', async () => {
    const results = await runScenarios(names(['a', 'b']), [target('1'), target('2')], {
      run: async (s) => {
        if (s.name === 'a') {
          throw new Error('boom')
        }
        return { name: s.name, status: 'passed', steps: [] }
      },
    })
    expect(results.map((result) => result.status)).toEqual(['failed', 'passed'])
    expect(results[0]?.steps.at(-1)?.problems.join(' ')).toContain('boom')
  })

  test('no environment at all is an error, not a run that checks nothing', async () => {
    await expect(runScenarios(names(['a']), [], {})).rejects.toThrow('environment')
  })
})

describe('estimateMs', () => {
  test('adds up the waits, and the settle after each change of the settings', () => {
    const put = { method: 'PUT', path: '/v1/admin/settings', auth: 'secret', body: {} }
    const s = scenario(
      'x',
      [
        { name: 'w', wait: '61s' },
        { name: 'put', request: put, expect: { status: 200 } },
        { name: 'get', request: { ...put, method: 'GET' }, expect: { status: 200 } },
      ],
      { needsSecretKey: true, cleanup: [{ name: 'back', request: put, expect: { status: 200 } }] }
    )
    expect(estimateMs(s, 0)).toBe(61_000)
    expect(estimateMs(s, 6_000)).toBe(61_000 + 2 * 6_000)
  })
})

describe('parseEnvironments', () => {
  test('reads publishable:secret pairs separated by commas', () => {
    expect(parseEnvironments('tula_pk_a:tula_sk_a, tula_pk_b:tula_sk_b')).toEqual([
      { publishableKey: 'tula_pk_a', secretKey: 'tula_sk_a' },
      { publishableKey: 'tula_pk_b', secretKey: 'tula_sk_b' },
    ])
  })

  test('nothing set is no extra environment', () => {
    expect(parseEnvironments(undefined)).toEqual([])
    expect(parseEnvironments('')).toEqual([])
  })

  test('a malformed pair is refused', () => {
    expect(() => parseEnvironments('tula_pk_a')).toThrow('publishable')
    expect(() => parseEnvironments('tula_pk_a:')).toThrow('publishable')
    expect(() => parseEnvironments('tula_pk_a:tula_sk_a,')).toThrow('publishable')
  })
})

describe('laneTargets', () => {
  test('the base target first, then one per environment with its own keys', () => {
    const base = { ...target('base'), secretKey: 'sk_base' }
    const lanes = laneTargets(base, [{ publishableKey: 'pk_x', secretKey: 'sk_x' }])
    expect(lanes.map((lane) => [lane.publishableKey, lane.secretKey])).toEqual([
      ['pk_base', 'sk_base'],
      ['pk_x', 'sk_x'],
    ])
    expect(lanes[1]?.baseUrl).toBe(base.baseUrl)
  })

  test('an environment named twice, or the primary again, is refused', () => {
    const base = { ...target('base'), secretKey: 'sk_base' }
    const x = { publishableKey: 'pk_x', secretKey: 'sk_x' }
    expect(() => laneTargets(base, [x, x])).toThrow('environment')
    expect(() => laneTargets(base, [{ publishableKey: 'pk_base', secretKey: 'sk_y' }])).toThrow(
      'environment'
    )
    expect(() => laneTargets(base, [{ publishableKey: 'pk_y', secretKey: 'sk_base' }])).toThrow(
      'environment'
    )
  })
})
