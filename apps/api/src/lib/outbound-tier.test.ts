import { describe, expect, test } from 'bun:test'
import { localTierIsExposed } from '~/lib/outbound-tier'

describe('localTierIsExposed (H-200)', () => {
  test.each([
    ['local', 'https://auth.example.com', true],
    ['local', 'http://10.0.0.5:3003', true],
    ['local', 'http://localhost:3003', false],
    ['local', 'http://127.0.0.1:3003', false],
    ['local', 'http://[::1]:3003', false],
    ['dev', 'https://auth.example.com', false],
    ['prod', 'https://auth.example.com', false],
    ['local', 'not a url', true],
  ])('%s with %s -> %p', (tier, publicUrl, exposed) => {
    expect(localTierIsExposed({ ENVIRONMENT: tier, PUBLIC_URL: publicUrl } as never)).toBe(exposed)
  })
})
