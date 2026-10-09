import { describe, expect, test } from 'bun:test'
import { accountLabel } from './account-label'

describe('accountLabel', () => {
  test.each([
    [
      'the address, when there is one',
      { email: 'maya@northline.app', firstName: 'Maya', lastName: null },
      'maya@northline.app',
    ],
    [
      'the name of an account with no address',
      { email: null, firstName: 'Nelly', lastName: 'Okafor' },
      'Nelly Okafor',
    ],
    ['one name alone', { email: null, firstName: null, lastName: 'Okafor' }, 'Okafor'],
    [
      'a fixed word when there is neither',
      { email: null, firstName: null, lastName: null },
      'Account',
    ],
    [
      'a fixed word for names that are empty',
      { email: null, firstName: '', lastName: '' },
      'Account',
    ],
  ] as const)('%s', (_name, user, label) => {
    expect(accountLabel(user)).toBe(label)
  })
})
