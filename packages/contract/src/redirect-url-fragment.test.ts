import { describe, expect, test } from 'bun:test'
import { redirectUrlKind } from './redirect-url'

// H-152: `new URL(...).hash` is '' for a bare trailing '#', so the server's own `#name=` would
// have made a double fragment.
describe('a listed web redirect URL holds no fragment marker at all', () => {
  test.each([
    ['https://app.example.com/cb#'],
    ['https://app.example.com/cb?x=1#'],
    ['http://localhost:3000/cb#'],
  ])('%s is refused', (value) => {
    expect(redirectUrlKind(value)).toBeNull()
  })
})
