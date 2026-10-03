import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod'
import { ScenarioSchema } from './scenario'

test('the committed JSON Schema is what the Zod schema generates', async () => {
  const committed = await Bun.file(
    join(import.meta.dir, '../../../conformance/scenario.schema.json')
  ).json()
  expect(committed).toEqual(
    JSON.parse(JSON.stringify(z.toJSONSchema(ScenarioSchema, { io: 'input' })))
  )
})

test('requests default to the publishable key', () => {
  const scenario = ScenarioSchema.parse({
    name: 'x',
    description: 'y',
    steps: [{ name: 's', request: { method: 'GET', path: '/v1/status' }, expect: { status: 200 } }],
  })
  const [step] = scenario.steps
  expect(step && 'request' in step && step.request.auth).toBe('publishable')
})

test.each([
  ['a relative path', { method: 'GET', path: 'v1/status' }],
  ['an unknown method', { method: 'TRACE', path: '/v1/status' }],
  ['an unknown client', { method: 'GET', path: '/v1/status', client: 'fridge' }],
])('rejects a request with %s', (_name, request) => {
  expect(
    ScenarioSchema.safeParse({
      name: 'x',
      description: 'y',
      steps: [{ name: 's', request, expect: { status: 200 } }],
    }).success
  ).toBe(false)
})
