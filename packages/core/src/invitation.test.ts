import { describe, expect, test } from 'bun:test'
import { readInvitationLink } from './invitation'

describe('readInvitationLink', () => {
  test('reads the token from the fragment and returns the URL without it', () => {
    expect(readInvitationLink('https://app.example.com/join#tula_invitation=abc%2F123')).toEqual({
      token: 'abc/123',
      cleanUrl: 'https://app.example.com/join',
    })
  })

  test('keeps the rest of the fragment, and the query', () => {
    expect(
      readInvitationLink('https://app.example.com/join?x=1#tab=a&tula_invitation=abc&y=2')
    ).toEqual({ token: 'abc', cleanUrl: 'https://app.example.com/join?x=1#tab=a&y=2' })
  })

  test.each([
    ['no fragment', 'https://app.example.com/join'],
    ['an empty fragment', 'https://app.example.com/join#'],
    ['another fragment', 'https://app.example.com/join#tula_link=abc&tula_attempt=1'],
    ['an empty token', 'https://app.example.com/join#tula_invitation='],
    // The token is only ever read from the fragment: a query is sent to servers and logged.
    ['a token in the query', 'https://app.example.com/join?tula_invitation=abc'],
  ])('is null for %s', (_, url) => {
    expect(readInvitationLink(url)).toBeNull()
  })
})
