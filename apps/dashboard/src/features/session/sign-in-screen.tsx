import { KeyRound } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { messageFor, toApiError } from '~/api/errors'
import { useCreateDashboardSession, useGetDashboardSession } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { TextField } from '~/components/field'
import { LoadingState } from '~/components/states'
import { useSession } from '~/state/session'

/**
 * Why a sign-in was refused, in the operator's words.
 *
 * @param error - What the sign-in threw.
 * @returns The message to show.
 */
export function signInMessage(error: unknown): string {
  const failure = toApiError(error)
  if (failure.status === 404) {
    return NO_TOKEN_MESSAGE
  }
  if (failure.code === 'auth.invalid_key') {
    return 'That is not this deployment’s admin token. Check the value of TULA_ADMIN_TOKEN and try again.'
  }
  return messageFor(failure)
}

const NO_TOKEN_MESSAGE =
  'This deployment has no admin token, so the dashboard is switched off. Set TULA_ADMIN_TOKEN (for example with `openssl rand -hex 32`) in the API’s environment and restart it.'

/**
 * The dashboard's sign-in: one field for the instance admin token.
 *
 * The token is exchanged once for an HttpOnly session cookie (ADR 0032). It lives in this
 * component's state only while it is being typed: it is cleared the moment it is submitted,
 * and never reaches storage, the address or a log.
 *
 * @param props - `onSignedIn`: called once a session exists (after a sign-in, or because the
 *   browser already had one).
 * @returns The screen.
 */
export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('')
  const [missing, setMissing] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const signedIn = useSession((state) => state.signedIn)
  const probe = useGetDashboardSession({ query: { retry: false, staleTime: 0, gcTime: 0 } })
  // `gcTime: 0` and the `reset()` below: the query client keeps a mutation's variables, and
  // here they are the admin token. Nothing of it stays once the request has settled.
  const signIn = useCreateDashboardSession({ mutation: { gcTime: 0 } })
  const unavailable = probe.error ? toApiError(probe.error).status === 404 : false

  useEffect(() => {
    if (probe.data) {
      signedIn(probe.data.expiresAt)
      onSignedIn()
    }
  }, [probe.data, signedIn, onSignedIn])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (signIn.isPending) {
      return
    }
    const presented = token
    // Cleared before the request leaves: the token is not kept for a retry.
    setToken('')
    if (presented.trim() === '') {
      setMissing(true)
      input.current?.focus()
      return
    }
    setMissing(false)
    setRefusal(undefined)
    signIn.mutate(
      { data: { token: presented } },
      {
        onSuccess: (session) => {
          signIn.reset()
          signedIn(session.expiresAt)
          onSignedIn()
        },
        onError: (failure) => {
          setRefusal(signInMessage(failure))
          signIn.reset()
          input.current?.focus()
        },
      }
    )
  }

  const error = missing ? 'Enter the admin token.' : refusal

  return (
    <main className='flex min-h-dvh items-center justify-center p-4'>
      <div className='flex w-full max-w-md flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8'>
        <div className='flex flex-col gap-2'>
          <span className='flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground'>
            <KeyRound aria-hidden='true' className='size-5' />
          </span>
          <h1 className='text-2xl font-semibold tracking-tight'>Sign in to the dashboard</h1>
          <p className='text-sm text-muted-foreground'>
            Use this deployment’s admin token. It is exchanged for a session that lasts eight hours
            and is not kept in this browser.
          </p>
        </div>
        {probe.isPending ? (
          <LoadingState label='Checking for a session' />
        ) : unavailable ? (
          <p
            role='alert'
            className='rounded-lg border border-destructive bg-destructive-surface p-3 text-sm'
          >
            {NO_TOKEN_MESSAGE}
          </p>
        ) : (
          <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
            <TextField
              ref={input}
              label='Admin token'
              type='password'
              name='admin-token'
              autoComplete='off'
              autoCapitalize='off'
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              error={error}
              hint='The value of TULA_ADMIN_TOKEN on the server.'
            />
            <ActionButton type='submit' pending={signIn.isPending}>
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </ActionButton>
          </form>
        )}
      </div>
    </main>
  )
}
