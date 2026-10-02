import { describe, expect, test } from 'bun:test'
import { maskEmail, normalizeEmail } from '~/lib/email'

describe('normalizeEmail', () => {
  test.each([
    ['  Maya@Northline.APP ', 'maya@northline.app'],
    ['maya@northline.app', 'maya@northline.app'],
    ['MAYA+tag@Northline.app', 'maya+tag@northline.app'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected)
  })
})

describe('maskEmail', () => {
  test.each([
    ['maya@northline.app', 'm***@northline.app'],
    ['a@b.co', 'a***@b.co'],
    ['Maya@Northline.app', 'M***@Northline.app'],
    ['not-an-email', '***'],
    ['@northline.app', '***'],
    ['', '***'],
  ])('%p → %p', (input, expected) => {
    expect(maskEmail(input)).toBe(expected)
  })

  test('never reveals more than the first character of the local part', () => {
    expect(maskEmail('averyveryverylongname@example.com')).toBe('a***@example.com')
  })
})
