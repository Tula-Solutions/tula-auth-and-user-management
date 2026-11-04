import { describe, expect, test } from 'bun:test'
import { UUID_PATTERN } from '~/lib/uuid'

describe('UUID_PATTERN', () => {
  test.each([
    ['0191f3c2-7a1b-7c3d-8e4f-0123456789ab', true],
    ['0191F3C2-7A1B-7C3D-8E4F-0123456789AB', true],
    ['0191f3c2-7a1b-7c3d-8e4f-0123456789a', false],
    ['0191f3c27a1b7c3d8e4f0123456789ab', false],
    ['0191f3c2-7a1b-7c3d-8e4f-0123456789ab\n', false],
    ['not-a-uuid', false],
    ['', false],
  ])('%j -> %p', (value, expected) => {
    expect(UUID_PATTERN.test(value)).toBe(expected)
  })
})
