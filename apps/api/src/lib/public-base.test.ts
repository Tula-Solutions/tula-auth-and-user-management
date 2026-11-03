import { expect, test } from 'bun:test'
import { publicBase } from './public-base'

test('publicBase drops trailing slashes and keeps a path', () => {
  expect(publicBase({ publicUrl: 'https://a.test/' })).toBe('https://a.test')
  expect(publicBase({ publicUrl: 'https://a.test/auth//' })).toBe('https://a.test/auth')
  expect(publicBase({ publicUrl: 'https://a.test' })).toBe('https://a.test')
})
