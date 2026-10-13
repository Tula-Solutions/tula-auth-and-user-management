import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ACTIVITY_TYPES, type ActivityType } from '@tula/contract/event-types'
import { useEffect, useState } from 'react'
import {
  useSendTestWebhook,
  type WebhookEndpoint,
  type WebhookSendResult,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { SelectField } from '~/components/field'
import { Modal } from '~/components/modal'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { Address } from './address'
import { eventTypeNote } from './event-type-notes'
import { refreshWebhooks } from './queries'
import { SendResult } from './send-result'
import { webhookMessageFor } from './words'

/**
 * The type a test starts on: the first the endpoint subscribes to that the contract knows,
 * or the contract's first.
 *
 * @param eventTypes - The endpoint's subscription (a later server may name types this
 *   version does not know).
 * @returns A type of the contract's list.
 */
function firstKnownType(eventTypes: readonly string[]): ActivityType {
  const known = new Set<string>(ACTIVITY_TYPES)
  const first = eventTypes.find((type): type is ActivityType => known.has(type))
  return first ?? ACTIVITY_TYPES[0]
}

/**
 * Send one test event to an endpoint and say what became of it.
 *
 * The operator chooses the event's type from the contract's list and nothing else: the body
 * is the contract's example of that type, made by the server.
 *
 * @param props - `scope`: the environment's address, for the link to the delivery;
 *   `endpoint`; `open` and `onClose`.
 * @returns The dialog.
 */
export function TestEventDialog({
  scope,
  endpoint,
  open,
  onClose,
}: {
  scope: EnvironmentScope
  endpoint: Pick<WebhookEndpoint, 'id' | 'url' | 'eventTypes'>
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const send = useSendTestWebhook({ request: useEnvironmentRequest() })
  const [eventType, setEventType] = useState<ActivityType>(() =>
    firstKnownType(endpoint.eventTypes)
  )
  const [result, setResult] = useState<WebhookSendResult | null>(null)
  const { reset } = send
  const subscribed = endpoint.eventTypes.join(' ')

  // Opened again, the dialog starts over: no result of an earlier send, no error.
  useEffect(() => {
    if (open) {
      setResult(null)
      setEventType(firstKnownType(subscribed.split(' ')))
      reset()
    }
  }, [open, subscribed, reset])

  function submit() {
    setResult(null)
    send.mutate(
      { id: endpoint.id, data: { eventType } },
      {
        onSuccess: async (answer) => {
          setResult(answer)
          await refreshWebhooks(queryClient)
        },
      }
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title='Send a test event'
      description={
        <>
          One request is made to <Address url={endpoint.url} />, now, signed like any delivery. Its
          body is an example of the type you choose, with{' '}
          <code className='font-mono'>"test": true</code> in it so that your receiver can tell it
          from a real event.
        </>
      }
      footer={
        <>
          <ActionButton variant='outline' onClick={onClose}>
            Close
          </ActionButton>
          <ActionButton onClick={submit} pending={send.isPending}>
            Send test event
          </ActionButton>
        </>
      }
    >
      <p className='text-sm text-muted-foreground'>
        It does not change the endpoint’s health: a failure does not count towards switching it off,
        and a success does not end a run of failures. It is not retried, and it can be sent to an
        endpoint that is switched off.
      </p>
      <SelectField
        label='Event type'
        hint={eventTypeNote(eventType)}
        value={eventType}
        onChange={(event) => setEventType(event.target.value as ActivityType)}
      >
        {ACTIVITY_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </SelectField>
      {send.error ? (
        <p role='alert' className='text-sm text-destructive'>
          {webhookMessageFor(send.error, 'test')}
        </p>
      ) : null}
      {result ? (
        <SendResult result={result}>
          <Link
            to='/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId/deliveries/$deliveryId'
            params={{ ...scope, endpointId: endpoint.id, deliveryId: result.deliveryId }}
            className='font-medium text-link underline underline-offset-4'
          >
            See this delivery
          </Link>
        </SendResult>
      ) : null}
    </Modal>
  )
}
