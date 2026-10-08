import { describe, expect, test } from 'bun:test'
import { memoryStorage } from './storage'

describe('memoryStorage', () => {
  test('stores, replaces and removes values; a missing key is null', async () => {
    const storage = memoryStorage()
    expect(await storage.get('a')).toBeNull()
    await storage.set('a', '1')
    await storage.set('a', '2')
    expect(await storage.get('a')).toBe('2')
    await storage.remove('a')
    await storage.remove('a')
    expect(await storage.get('a')).toBeNull()
  })

  test('two storages share nothing', async () => {
    const one = memoryStorage()
    const two = memoryStorage()
    await one.set('a', '1')
    expect(await two.get('a')).toBeNull()
  })
})
