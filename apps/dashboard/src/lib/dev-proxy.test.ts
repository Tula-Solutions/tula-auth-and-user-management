import { describe, expect, test } from 'bun:test'
import { originForApi } from './dev-proxy'

// `vite dev` only. The API takes a dashboard request from its own origin or CORS_ORIGINS and
// from nowhere else, so the dev proxy presents the API's origin for the dev page's own calls.

const API = 'http://localhost:3003'

describe('originForApi', () => {
  test.each(['http://localhost:5175', 'http://127.0.0.1:5175', 'http://[::1]:5175'])(
    'the dev page’s own origin %s is presented as the API’s',
    (origin) => {
      expect(originForApi(origin, 5175, API)).toBe(API)
    }
  )

  test.each([
    'http://localhost:5174',
    'http://localhost:51750',
    'https://localhost:5175',
    'http://localhost.evil.test:5175',
    'http://evil.test',
    'null',
    '',
  ])('any other origin (%s) is passed on as it came, for the API to refuse', (origin) => {
    expect(originForApi(origin, 5175, API)).toBe(origin)
  })

  test('a request without an Origin gets none', () => {
    expect(originForApi(undefined, 5175, API)).toBeUndefined()
  })
})
