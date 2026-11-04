import { useCallback, useEffect, useRef, useState } from 'react'
import { messageFor } from '~/api/errors'
import type { SsoConnection, SsoTestResult, SsoTestStart } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Section } from '~/components/page'
import { SETUP_TEST_CHANNEL, setupRequest } from './setup-api'

/** How often the setup tab asks for the result of a test it started, in milliseconds. */
const POLL_MS = 1500

export function TestAndActivate({
  connection,
  reload,
}: {
  connection: SsoConnection
  reload: () => Promise<void>
}) {
  const [result, setResult] = useState<SsoTestResult | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const testId = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poll = useCallback(async () => {
    const id = testId.current
    if (id === null) {
      return
    }
    try {
      const next = await setupRequest<SsoTestResult>(`/connections/${connection.id}/tests/${id}`)
      setResult(next)
      if (next.status === 'pending') {
        timer.current = setTimeout(() => void poll(), POLL_MS)
      } else {
        await reload()
      }
    } catch (failure) {
      setError(messageFor(failure))
    }
  }, [connection.id, reload])

  useEffect(() => {
    const channel = new BroadcastChannel(SETUP_TEST_CHANNEL)
    channel.onmessage = (event: MessageEvent<{ testId?: string }>) => {
      if (event.data?.testId === testId.current) {
        void poll()
      }
    }
    return () => {
      channel.close()
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [poll])

  async function start() {
    setError(null)
    setResult(null)
    setFallback(null)
    // Opened on the click, before the request: a window opened after an await is blocked.
    const popup = window.open('about:blank', '_blank')
    setPending(true)
    try {
      const started = await setupRequest<SsoTestStart>(`/connections/${connection.id}/tests`, {
        method: 'POST',
      })
      testId.current = started.testId
      if (popup) {
        popup.location.href = started.authorizationUrl
      } else {
        setFallback(started.authorizationUrl)
      }
      timer.current = setTimeout(() => void poll(), POLL_MS)
    } catch (failure) {
      popup?.close()
      setError(messageFor(failure))
    } finally {
      setPending(false)
    }
  }

  async function activate() {
    setActivating(true)
    setError(null)
    try {
      await setupRequest(`/connections/${connection.id}`, {
        method: 'PATCH',
        body: { status: 'active' },
      })
      await reload()
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setActivating(false)
    }
  }

  return (
    <Section
      title='4. Test, then activate'
      description='The test signs you in through your identity provider in a new window and creates nothing. Activate the connection once it passes.'
    >
      <div className='flex flex-wrap gap-2'>
        <ActionButton onClick={start} pending={pending}>
          Run a test sign-in
        </ActionButton>
        {connection.status === 'active' ? null : (
          <ActionButton
            variant='outline'
            onClick={activate}
            pending={activating}
            disabled={!connection.tested}
          >
            Activate the connection
          </ActionButton>
        )}
      </div>
      {fallback ? (
        <p className='text-sm'>
          Your browser blocked the window.{' '}
          <a className='underline' href={fallback} target='_blank' rel='noreferrer'>
            Open the test sign-in
          </a>
        </p>
      ) : null}
      {result?.status === 'pending' ? (
        <p role='status' className='text-sm'>
          Waiting for the test sign-in to finish…
        </p>
      ) : null}
      {result?.status === 'passed' ? (
        <p role='status' className='text-sm'>
          The test passed.
          {result.groups.length > 0 ? ` Groups received: ${result.groups.join(', ')}.` : ''}
        </p>
      ) : null}
      {result?.status === 'failed' ? (
        <p role='alert' className='text-sm text-destructive'>
          The test failed{result.message ? `: ${result.message}` : ` (${result.reason})`}.
        </p>
      ) : null}
      {connection.status === 'active' ? (
        <p role='status' className='text-sm'>
          This connection is active. People with a verified domain can now sign in with it, and
          password sign-in stays available to those who have a password. Enforcement is the
          organization’s administrators’ to switch on.
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </Section>
  )
}
