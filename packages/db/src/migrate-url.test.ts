import { describe, expect, test } from 'bun:test'
import { migrationUrl } from './migrate'

describe('migrationUrl (H-238)', () => {
  test('prefers the owner URL', () => {
    expect(migrationUrl({ DATABASE_MIGRATION_URL: 'owner', DATABASE_URL: 'runtime' })).toEqual({
      url: 'owner',
      fellBack: false,
    })
  })

  test('says it fell back to the runtime URL', () => {
    expect(migrationUrl({ DATABASE_URL: 'runtime' })).toEqual({ url: 'runtime', fellBack: true })
  })

  test('returns null when neither is set', () => {
    expect(migrationUrl({})).toBeNull()
  })
})
