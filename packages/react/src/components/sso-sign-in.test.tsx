import { describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import type { FirstFactorStrategy } from '@tula-tech/core'
import {
  expectAbsent,
  expectFocus,
  failure,
  fakeLinkStorage,
  fakePage,
  json,
  ROUTE,
  started,
  world,
} from '../testing/harness'
import { SignIn } from './sign-in'

// Single sign-on: the `sso` first factor.

const IDP_URL = 'https://idp.example/authorize?state=s'
const SSO = 'POST /v1/client/sign-ins/attempt_1/sso'
const KEY = 'tula.oauth.attempt_1'

/** A sign-in page whose first step offers exactly these strategies. */
async function begin(strategies: FirstFactorStrategy[]) {
  const tabStorage = fakeLinkStorage()
  const page = fakePage('http://localhost:5173/sign-in')
  const w = world({ tabStorage, page })
  w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_first_factor', strategies }))
  w.mount(<SignIn />, { oauthCallbackUrl: '/oauth/callback' })
  await w.user.type(await screen.findByLabelText('Email address'), 'ada@acme.example')
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
  return { w, page, tabStorage }
}

describe('<SignIn> with single sign-on', () => {
  test('sso as the only strategy: the button is drawn and no password is asked for', async () => {
    await begin(['sso'])
    const title = await screen.findByRole('heading', { name: 'Continue with SSO' })
    await expectFocus(title)
    expect(screen.getByRole('button', { name: 'Continue with SSO' })).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Password'))
    expectAbsent(screen.queryByRole('list', { name: 'Other ways to sign in' }))
  })

  test('the button starts SSO with the callback page, keeps the binding and navigates', async () => {
    const { w, page, tabStorage } = await begin(['sso'])
    w.api.on(SSO, () =>
      json(200, {
        attempt: {
          id: 'attempt_1',
          kind: 'sign_in',
          expiresAt: '2030-01-01T00:10:00.000Z',
          step: { status: 'needs_first_factor', strategies: ['sso'] },
        },
        authorizationUrl: IDP_URL,
        binding: 'tula_ob_binding',
      })
    )
    await w.user.click(await screen.findByRole('button', { name: 'Continue with SSO' }))
    await waitFor(() => expect(page.assigned).toEqual([IDP_URL]))
    expect(w.api.calls(SSO)[0]?.body).toEqual({
      redirectUrl: 'http://localhost:5173/oauth/callback',
    })
    expect(tabStorage.entries.has(KEY)).toBe(true)
  })

  test('the API’s refusal is shown and the user stays on the screen', async () => {
    const { w, page } = await begin(['sso'])
    w.api.on(SSO, () => failure(409, 'flow.invalid_step'))
    await w.user.click(await screen.findByRole('button', { name: 'Continue with SSO' }))
    await screen.findByRole('alert')
    expect(page.assigned).toEqual([])
    expect(screen.getByRole('button', { name: 'Continue with SSO' })).toBeTruthy()
  })

  test('beside a password, SSO is one of the other ways', async () => {
    await begin(['password', 'sso'])
    await screen.findByLabelText('Password')
    const others = screen.getByRole('list', { name: 'Other ways to sign in' })
    expect(others.textContent).toContain('Continue with SSO')
  })
})
