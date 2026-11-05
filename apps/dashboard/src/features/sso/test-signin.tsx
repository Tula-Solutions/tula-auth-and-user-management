import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { messageFor } from '~/api/errors'
import {
  type SsoConnection,
  useGetSsoConnectionTest,
  useStartSsoConnectionTest,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { SETUP_TEST_CHANNEL } from '~/features/setup/setup-api'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { isHttpsUrl } from '~/lib/https-url'
import { printable, printableName } from '~/lib/printable'
import { refreshSso } from './queries'

/** How often a started test is asked about while its window is open, in milliseconds. */
const POLL_MS = 1500

/**
 * A test sign-in for one connection (ADR 0067): a popup round through the identity provider
 * that creates nothing, and its result: the attributes and groups that arrived, how they
 * mapped, or the reason it failed. A passing test is what lets the connection be activated.
 *
 * The window is opened on the click, before the request, because a window opened after an
 * await is blocked. The server returns it to the setup page, which tells this tab which test
 * came back over a BroadcastChannel; the poll is the fallback.
 *
 * @param props - The connection to test.
 * @returns The button and the result.
 */
export function TestSignIn({ connection }: { connection: SsoConnection }) {
  const name = printableName(connection.name)
  const queryClient = useQueryClient()
  const request = useEnvironmentRequest()
  const start = useStartSsoConnectionTest({ request })
  const [testId, setTestId] = useState<string | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const settled = useRef<string | null>(null)

  const result = useGetSsoConnectionTest(connection.id, testId ?? '', {
    query: {
      enabled: testId !== null,
      refetchInterval: (query) => (query.state.data?.status === 'pending' ? POLL_MS : false),
    },
    request,
  })
  const outcome = testId === null ? undefined : result.data
  const refetch = result.refetch

  useEffect(() => {
    if (testId === null) {
      return
    }
    const channel = new BroadcastChannel(SETUP_TEST_CHANNEL)
    channel.onmessage = (event: MessageEvent<{ testId?: string }>) => {
      if (event.data?.testId === testId) {
        void refetch()
      }
    }
    return () => channel.close()
  }, [testId, refetch])

  useEffect(() => {
    // A finished test changes the connection's `tested`: read the list again, once.
    if (outcome && outcome.status !== 'pending' && settled.current !== outcome.testId) {
      settled.current = outcome.testId
      void refreshSso(queryClient)
    }
  }, [outcome, queryClient])

  function run() {
    setFailure(null)
    setFallback(null)
    setTestId(null)
    const popup = window.open('about:blank', '_blank')
    if (popup) {
      popup.opener = null // `noopener` would make open() return null
    }
    start.mutate(
      { id: connection.id, data: {} },
      {
        onSuccess: (started) => {
          if (!isHttpsUrl(started.authorizationUrl)) {
            popup?.close()
            setFailure('The sign-in address was not an https address.')
            return
          }
          setTestId(started.testId)
          if (popup) {
            popup.location.href = started.authorizationUrl
          } else {
            setFallback(started.authorizationUrl)
          }
        },
        onError: (error) => {
          popup?.close()
          setFailure(messageFor(error))
        },
      }
    )
  }

  const why = outcome?.message ? `: ${printableName(outcome.message)}` : ` (${outcome?.reason})`

  return (
    <div className='flex flex-col gap-2'>
      <div>
        <ActionButton
          variant='outline'
          size='sm'
          aria-label={`Run test sign-in for ${name}`}
          pending={start.isPending}
          onClick={run}
        >
          Run test sign-in
        </ActionButton>
      </div>
      {fallback ? (
        <p className='text-sm'>
          Your browser blocked the window.{' '}
          <a className='underline' href={fallback} target='_blank' rel='noreferrer'>
            Open the test sign-in
          </a>
        </p>
      ) : null}
      {failure ? (
        <p role='alert' className='text-sm text-destructive'>
          {failure}
        </p>
      ) : null}
      {outcome?.status === 'pending' ? (
        <p role='status' className='text-sm'>
          Waiting for the test sign-in to finish…
        </p>
      ) : null}
      {outcome?.status === 'failed' ? (
        <p role='alert' className='text-sm text-destructive'>
          The test failed{why}.
        </p>
      ) : null}
      {outcome?.status === 'passed' ? (
        <div role='status' className='flex flex-col gap-1 text-sm'>
          <p>The test passed. Nothing was created.</p>
          {outcome.mapped ? (
            <p>
              Mapped to email <bdi dir='ltr'>{printable(outcome.mapped.email ?? 'none')}</bdi>
              {outcome.mapped.emailOnVerifiedDomain
                ? ', on a verified domain.'
                : ', which is not on a verified domain.'}
            </p>
          ) : null}
          <p>
            Groups received:{' '}
            {outcome.groups.length === 0 ? 'none' : outcome.groups.map(printable).join(', ')}.
          </p>
          {outcome.attributes.length > 0 ? (
            <ul className='list-disc pl-5'>
              {outcome.attributes.map((attribute) => (
                <li key={attribute.name}>
                  <bdi dir='ltr'>{printable(attribute.name)}</bdi>:{' '}
                  {attribute.values.map(printable).join(', ')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
