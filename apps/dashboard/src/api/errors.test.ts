import { describe, expect, test } from 'bun:test'
import { ApiError, messageFor } from './errors'

// The message a screen shows for a failed call: the dashboard's own for a few codes, else the
// server's. The code is a word the server chose, looked up in a table.

const DETAIL = 'The server’s own description.'

function failed(code: string): ApiError {
  return new ApiError({ status: 400, code, detail: DETAIL })
}

describe('the message for a failure', () => {
  test('a code the dashboard has words for is said in them', () => {
    expect(messageFor(failed('precondition.failed'))).toBe(
      'These settings were changed somewhere else since you opened them. Reload to see the current version.'
    )
  })

  test('a code it has none for is said as the server said it', () => {
    expect(messageFor(failed('a.later_code'))).toBe(DETAIL)
  })

  // A code that names something every object has must not find it: the "message" would be a
  // function or an object.
  test.each([['constructor'], ['__proto__'], ['toString']])(
    'the code `%s` is a code nobody knows, not a property of the table',
    (code) => {
      expect(messageFor(failed(code))).toBe(DETAIL)
    }
  )
})
