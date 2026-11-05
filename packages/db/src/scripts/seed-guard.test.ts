import { describe, expect, test } from 'bun:test'
import { seedRefusal } from './seed-guard'

describe('seedRefusal (H-254)', () => {
  test.each(['local', 'dev'])('allows ENVIRONMENT=%s', (environment) => {
    expect(seedRefusal({ ENVIRONMENT: environment })).toBeNull()
  })

  test.each(['staging', 'prod', 'production', '', undefined])(
    'refuses ENVIRONMENT=%p with a fixed message',
    (environment) => {
      expect(seedRefusal({ ENVIRONMENT: environment })).toBe(
        'seed: refused: it creates a workspace and environments for local development; set ENVIRONMENT to local or dev'
      )
    }
  )
})
