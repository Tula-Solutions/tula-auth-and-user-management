import type { ReactNode } from 'react'
import type { UserAuthentication } from '~/api/generated/api.gen'
import { Section } from '~/components/page'
import { type QueryLike, QueryState } from '~/components/states'
import { formatDateTime } from '~/lib/format'
import { own } from '~/lib/own'

/** Display names of the providers the API knows; any other is shown as the API names it. */
const PROVIDER_NAME: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  linkedin: 'LinkedIn',
}

/** Display names of second factors; any other is shown as the API names it. */
const FACTOR_NAME: Record<string, string> = {
  totp: 'Authenticator app',
}

function providerName(provider: string): string {
  return own(PROVIDER_NAME, provider) ?? provider
}

function joined(items: readonly string[]): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * What a user signs in with, in one sentence.
 *
 * @param authentication - The user's sign-in methods.
 * @returns "Has a password", or what a user without one signs in with instead.
 *
 * @example
 * ```ts
 * passwordSummary({ ...methods, hasPassword: false }) // 'No password; signs in with Google.'
 * ```
 */
export function passwordSummary(authentication: UserAuthentication): string {
  if (authentication.hasPassword) {
    return 'Has a password'
  }
  const others = [
    ...authentication.identities.map((identity) => providerName(identity.provider)),
    ...(authentication.passkeys.length > 0 ? ['a passkey'] : []),
  ]
  return others.length > 0
    ? `No password; signs in with ${joined(others)}.`
    : 'No password, linked account or passkey. They can sign in only with an emailed code or link, where one is switched on and their address is verified.'
}

function Method({
  label,
  children,
  wide = false,
}: {
  label: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className={wide ? 'flex flex-col gap-0.5 sm:col-span-2' : 'flex flex-col gap-0.5'}>
      <dt className='text-xs font-medium text-muted-foreground'>{label}</dt>
      <dd className='text-sm break-words'>{children}</dd>
    </div>
  )
}

function Lines({ children }: { children: ReactNode }) {
  return <ul className='flex flex-col gap-1'>{children}</ul>
}

/**
 * The "How this user signs in" section of a user's screen: password, address, linked
 * accounts, two-step verification and passkeys.
 *
 * Text only, and every state in words: the API sends no secret here (no authenticator secret,
 * backup code or credential id), and a passkey's name, which its owner chose, is drawn as text.
 *
 * @param props - `query`: the `getUserAuthentication` query of the user on screen.
 * @returns The section, with its own loading and error states.
 */
export function SignInMethods({ query }: { query: QueryLike<UserAuthentication> }) {
  return (
    <Section
      title='How this user signs in'
      description='What the account has. Whether a method can be used also depends on what this environment has switched on.'
    >
      <QueryState query={query} label='Loading sign-in methods'>
        {(authentication) => (
          <dl className='grid gap-4 sm:grid-cols-2'>
            <Method label='Password'>{passwordSummary(authentication)}</Method>
            <Method label='Email address'>
              {authentication.emailVerified ? 'Verified' : 'Not verified'}
            </Method>
            <Method label='Linked accounts'>
              {authentication.identities.length === 0 ? (
                'No linked accounts'
              ) : (
                <Lines>
                  {authentication.identities.map((identity) => (
                    <li key={`${identity.provider}:${identity.linkedAt}`}>
                      {providerName(identity.provider)}, linked {formatDateTime(identity.linkedAt)}
                    </li>
                  ))}
                </Lines>
              )}
            </Method>
            <Method label='Two-step verification'>
              {authentication.factors.length === 0 ? (
                'Off'
              ) : (
                <Lines>
                  {authentication.factors.map((factor) => (
                    <li key={factor.type}>
                      {FACTOR_NAME[factor.type] ?? factor.type} since{' '}
                      {formatDateTime(factor.confirmedAt)}
                    </li>
                  ))}
                  <li>
                    {authentication.backupCodesRemaining === 1
                      ? '1 backup code left'
                      : `${authentication.backupCodesRemaining} backup codes left`}
                  </li>
                </Lines>
              )}
            </Method>
            <Method label='Passkeys' wide>
              {authentication.passkeys.length === 0 ? (
                'No passkeys'
              ) : (
                <Lines>
                  {authentication.passkeys.map((passkey) => (
                    <li key={passkey.id}>
                      <span className='font-medium'>{passkey.name}</span>: added{' '}
                      {formatDateTime(passkey.createdAt)},{' '}
                      {passkey.lastUsedAt
                        ? `last used ${formatDateTime(passkey.lastUsedAt)}`
                        : 'never used'}
                      , {passkey.synced ? 'synced' : 'this device only'}
                    </li>
                  ))}
                </Lines>
              )}
            </Method>
          </dl>
        )}
      </QueryState>
    </Section>
  )
}
