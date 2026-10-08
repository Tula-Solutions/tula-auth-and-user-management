import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import {
  useGetWebhookDelivery,
  useGetWebhookEndpoint,
  useRedeliverWebhook,
  type WebhookDeliveryAttempt,
  type WebhookDeliveryDetail,
  type WebhookSendResult,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { type Column, DataTable } from '~/components/data-table'
import { PageHeader, Section } from '~/components/page'
import { EmptyState, type QueryLike, QueryState } from '~/components/states'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { Address } from './address'
import { refreshWebhooks } from './queries'
import { Moment } from './rotate-secret-dialog'
import { SendResult } from './send-result'
import {
  answerText,
  deliveryStateLabel,
  failureReasonText,
  isNotFound,
  webhookMessageFor,
} from './words'

/** Props of {@link WebhookDeliveryScreen}. */
export interface WebhookDeliveryScreenProps {
  /** The ids of the environment's address, for the links. */
  scope: EnvironmentScope
  endpointId: string
  deliveryId: string
}

// Everything the server keeps of a request: when, the status code, how long, and its own
// word for a failure. No header and no body of the receiver's answer exists to show.
const ATTEMPT_COLUMNS: Column<WebhookDeliveryAttempt>[] = [
  { header: 'Request', cell: (attempt) => attempt.attempt },
  { header: 'When', cell: (attempt) => <Moment iso={attempt.attemptedAt} /> },
  { header: 'Answer', cell: (attempt) => answerText(attempt.statusCode) },
  { header: 'Duration', cell: (attempt) => `${attempt.durationMs} ms` },
  {
    header: 'What went wrong',
    cell: (attempt) =>
      attempt.failureReason === null ? '—' : failureReasonText(attempt.failureReason),
  },
]

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <dt className='text-xs font-medium text-muted-foreground'>{name}</dt>
      <dd className='break-words'>{children}</dd>
    </div>
  )
}

function Facts({ delivery, address }: { delivery: WebhookDeliveryDetail; address: ReactNode }) {
  return (
    <dl data-testid='delivery-facts' className='grid gap-3 text-sm sm:grid-cols-2'>
      <Fact name='Endpoint'>{address}</Fact>
      <Fact name='Event type'>
        <code className='text-xs'>{delivery.eventType}</code>
      </Fact>
      <Fact name='State'>
        <span data-state={delivery.state} className='font-medium'>
          {deliveryStateLabel(delivery.state)}
        </span>
      </Fact>
      <Fact name='Event'>
        {delivery.test || delivery.eventId === null ? (
          'A test event, sent on demand. It is no event of this environment.'
        ) : (
          <code className='text-xs break-all'>{delivery.eventId}</code>
        )}
      </Fact>
      <Fact name='Requests made'>{delivery.attemptCount}</Fact>
      <Fact name='Queued'>
        <Moment iso={delivery.createdAt} />
      </Fact>
      {delivery.nextAttemptAt ? (
        <Fact name='Next request'>
          <Moment iso={delivery.nextAttemptAt} />
        </Fact>
      ) : null}
      {delivery.completedAt ? (
        <Fact name='Ended'>
          <Moment iso={delivery.completedAt} />
        </Fact>
      ) : null}
      {delivery.attempts.length === 0 && delivery.failureReason ? (
        <Fact name='What went wrong'>{failureReasonText(delivery.failureReason)}</Fact>
      ) : null}
    </dl>
  )
}

function SendAgain({ delivery }: { delivery: WebhookDeliveryDetail }) {
  const queryClient = useQueryClient()
  const redeliver = useRedeliverWebhook({ request: useEnvironmentRequest() })
  const [result, setResult] = useState<WebhookSendResult | null>(null)

  if (delivery.test || delivery.eventId === null) {
    return (
      <p data-testid='send-again-note' className='text-sm text-muted-foreground'>
        A test event is not sent again. Send a new one from the endpoint.
      </p>
    )
  }

  function send() {
    setResult(null)
    redeliver.mutate(
      { id: delivery.endpointId, deliveryId: delivery.id },
      {
        onSuccess: async (answer) => {
          setResult(answer)
          await refreshWebhooks(queryClient)
        },
      }
    )
  }

  return (
    <div className='flex flex-col items-start gap-3'>
      <p data-testid='send-again-note' className='max-w-prose text-sm text-muted-foreground'>
        One request is made now, with the same event and the same id, and is not retried. If it gets
        through, the delivery is delivered and the endpoint’s run of failures ends.
      </p>
      <ActionButton variant='outline' onClick={send} pending={redeliver.isPending}>
        Send again
      </ActionButton>
      {redeliver.error ? (
        <p role='alert' className='text-sm text-destructive'>
          {webhookMessageFor(redeliver.error, 'send')}
        </p>
      ) : null}
      {result ? <SendResult result={result} /> : null}
    </div>
  )
}

/**
 * One delivery and every request the server made for it, with "Send again".
 *
 * @param props - See {@link WebhookDeliveryScreenProps}.
 * @returns The screen.
 */
export function WebhookDeliveryScreen({
  scope,
  endpointId,
  deliveryId,
}: WebhookDeliveryScreenProps) {
  const request = useEnvironmentRequest()
  const endpoint = useGetWebhookEndpoint(endpointId, { request })
  const delivery = useGetWebhookDelivery(endpointId, deliveryId, { request })

  return (
    <>
      <Link
        to='/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId'
        params={{ ...scope, endpointId }}
        className='text-sm text-link underline underline-offset-4'
      >
        ← Deliveries of this endpoint
      </Link>
      <PageHeader
        title='Delivery'
        description='One event owed to one endpoint, and every request the server made to hand it over. Of an answer the server keeps the status code and the time it took, nothing else.'
      />
      {delivery.data === undefined && isNotFound(delivery.error) ? (
        <EmptyState title='Delivery not found'>
          This endpoint has no delivery with that id. Deliveries are kept for 90 days after they
          ended, and go with their endpoint when it is deleted.
        </EmptyState>
      ) : (
        <DeliveryFound query={delivery} address={endpoint.data?.url} />
      )}
    </>
  )
}

function DeliveryFound({
  query,
  address,
}: {
  query: QueryLike<WebhookDeliveryDetail>
  /** The endpoint's address, once it is known. */
  address: string | undefined
}) {
  return (
    <QueryState query={query} label='Loading the delivery'>
      {(found) => (
        <>
          <Section title='What was sent'>
            <Facts
              delivery={found}
              address={address === undefined ? '…' : <Address url={address} className='text-xs' />}
            />
          </Section>
          <Section title='Requests'>
            {found.attempts.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                No request has been made for this delivery yet.
              </p>
            ) : (
              <DataTable
                caption='Requests made for this delivery'
                rows={found.attempts}
                rowKey={(attempt) => String(attempt.attempt)}
                columns={ATTEMPT_COLUMNS}
              />
            )}
          </Section>
          <Section title='Send again'>
            <SendAgain delivery={found} />
          </Section>
        </>
      )}
    </QueryState>
  )
}
