import { describe, expect, test } from 'bun:test'
import { runEvery } from '~/adapters/postgres/integration-support'

describe('runEvery: the cleanup of an integration run', () => {
  test('a step that fails does not keep the later ones from running, and its error is rethrown', async () => {
    const ran: string[] = []
    const first = new Error('the first pool would not close')
    const outcome = runEvery([
      async () => {
        ran.push('tenants')
      },
      async () => {
        ran.push('first')
        throw first
      },
      async () => {
        ran.push('second')
        throw new Error('nor would the second')
      },
      async () => {
        ran.push('owner')
      },
    ])
    await expect(outcome).rejects.toBe(first)
    expect(ran).toEqual(['tenants', 'first', 'second', 'owner'])
  })

  test('steps run one after another, in the order given', async () => {
    const ran: string[] = []
    await runEvery([
      async () => {
        await Bun.sleep(5)
        ran.push('slow')
      },
      async () => {
        ran.push('fast')
      },
    ])
    expect(ran).toEqual(['slow', 'fast'])
  })

  test('with nothing failing it resolves', async () => {
    expect(await runEvery([])).toBeUndefined()
  })
})
