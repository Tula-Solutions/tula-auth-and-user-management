import { Link } from '@tanstack/react-router'
import { WEBHOOK_DELIVERY_STATES } from '@tula/contract'
import { ACTIVITY_TYPES } from '@tula/contract/event-types'
import { useState } from 'react'
import {
  type ActivityType,
  useGetWebhookEndpoint,
  useListWebhookDeliveries,
  type WebhookDelivery,
  type WebhookDeliveryQueryState,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { type Column, DataTable, Pagination } from '~/components/data-table'
import { SelectField } from '~/components/field'
import { PageHeader, Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { NativeSelectOption } from '~/components/ui/native-select'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { formatDateTime } from '~/lib/format'
import { pageSearch } from '~/lib/search'
import { EndpointCard } from './endpoint-card'
import { Moment } from './rotate-secret-dialog'
import { deliveryStateLabel, lastResultText } from './words'

/** How many deliveries one page of the list holds (the API's default). */
export const DELIVERY_PAGE_SIZE = 20

/** The delivery list's filters and page, as the address holds them. */
export interface DeliveryFilters {
  /** One of the contract's delivery states. */
  state?: string
  /** One of the contract's event types. */
  eventType?: string
  page?: number
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/**
 * Read the delivery list's filters from a route's search parameters. A state or a type the
 * contract does not know is left out, so a hand-edited address cannot produce a refused
 * request.
 *
 * @param search - The raw search parameters.
 * @returns The filters.
 */
export function deliverySearch(search: Record<string, unknown>): DeliveryFilters {
  return {
    ...(isOneOf(WEBHOOK_DELIVERY_STATES, search.state) ? { state: search.state } : {}),
    ...(isOneOf(ACTIVITY_TYPES, search.eventType) ? { eventType: search.eventType } : {}),
    ...pageSearch(search),
  }
}

/** Props of {@link WebhookEndpointScreen}. */
export interface WebhookEndpointScreenProps {
  /** The ids of the environment's address, for the links. */
  scope: EnvironmentScope
  endpointId: string
  /** The filters from the address. */
  filters: DeliveryFilters
  /** Put new filters in the address. */
  onFilters: (filters: DeliveryFilters) => void
  /** Leave for the list: the endpoint was deleted. */
  onGone: () => void
}

function columns(scope: EnvironmentScope, endpointId: string): Column<WebhookDelivery>[] {
  return [
    { header: 'Queued', cell: (delivery) => <Moment iso={delivery.createdAt} /> },
    {
      header: 'Event type',
      cell: (delivery) => (
        <span className='flex flex-wrap items-center gap-2'>
          <code className='text-xs'>{delivery.eventType}</code>
          {delivery.test ? (
            <span className='rounded-full border px-2 py-0.5 text-xs font-semibold'>
              Test event
            </span>
          ) : null}
        </span>
      ),
    },
    {
      header: 'State',
      cell: (delivery) => (
        <span data-state={delivery.state} className='font-medium'>
          {deliveryStateLabel(delivery.state)}
        </span>
      ),
    },
    { header: 'Requests', cell: (delivery) => delivery.attemptCount },
    { header: 'Last result', cell: (delivery) => lastResultText(delivery) },
    {
      header: 'Attempts',
      cell: (delivery) => (
        <Link
          to='/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId/deliveries/$deliveryId'
          params={{ ...scope, endpointId, deliveryId: delivery.id }}
          // Many rows read "See attempts": the name says which delivery each one leads to.
          aria-label={`Attempts of the ${delivery.eventType} delivery queued ${formatDateTime(delivery.createdAt)}`}
          className='text-link underline underline-offset-4'
        >
          See attempts
        </Link>
      ),
    },
  ]
}

function Deliveries({
  scope,
  endpointId,
  filters,
  onFilters,
}: Omit<WebhookEndpointScreenProps, 'onGone'>) {
  const deliveries = useListWebhookDeliveries(
    endpointId,
    {
      ...(filters.state ? { state: filters.state as WebhookDeliveryQueryState } : {}),
      ...(filters.eventType ? { eventType: filters.eventType as ActivityType } : {}),
      page: filters.page ?? 1,
      size: DELIVERY_PAGE_SIZE,
    },
    { request: useEnvironmentRequest() }
  )
  const filtered = filters.state !== undefined || filters.eventType !== undefined

  /** A new filter starts again at the first page; an empty choice removes the filter. */
  function choose(key: 'state' | 'eventType', value: string) {
    const { page: _page, [key]: _old, ...rest } = filters
    onFilters(value === '' ? rest : { ...rest, [key]: value })
  }

  return (
    <Section
      title='Deliveries'
      description='One delivery per event this endpoint is owed, and one per test event, newest first. A delivery is kept for 90 days after it ended.'
    >
      <div className='grid gap-4 sm:grid-cols-3'>
        <SelectField
          label='State'
          value={filters.state ?? ''}
          onChange={(event) => choose('state', event.target.value)}
        >
          <NativeSelectOption value=''>Any state</NativeSelectOption>
          {WEBHOOK_DELIVERY_STATES.map((state) => (
            <NativeSelectOption key={state} value={state}>
              {deliveryStateLabel(state)}
            </NativeSelectOption>
          ))}
        </SelectField>
        <SelectField
          label='Event type'
          value={filters.eventType ?? ''}
          onChange={(event) => choose('eventType', event.target.value)}
        >
          <NativeSelectOption value=''>Any type</NativeSelectOption>
          {ACTIVITY_TYPES.map((type) => (
            <NativeSelectOption key={type} value={type}>
              {type}
            </NativeSelectOption>
          ))}
        </SelectField>
        {filtered ? (
          <div className='flex items-end'>
            <ActionButton variant='outline' onClick={() => onFilters({})}>
              Clear filters
            </ActionButton>
          </div>
        ) : null}
      </div>
      <QueryState query={deliveries} label='Loading the deliveries'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState
              title={
                filtered
                  ? 'No delivery matches these filters'
                  : 'Nothing has been queued for this endpoint yet'
              }
            />
          ) : (
            <>
              <DataTable
                caption='Deliveries'
                rows={list.data}
                rowKey={(delivery) => delivery.id}
                columns={columns(scope, endpointId)}
              />
              <Pagination
                label='Deliveries'
                meta={list.meta}
                // Through the reader again: the first page is no page in the address.
                onPage={(page) => onFilters(deliverySearch({ ...filters, page }))}
              />
            </>
          )
        }
      </QueryState>
    </Section>
  )
}

/**
 * One webhook endpoint and its deliveries: the endpoint's card with everything that can be
 * done to it, and the paged, filterable log of what was sent to it.
 *
 * @param props - See {@link WebhookEndpointScreenProps}.
 * @returns The screen.
 */
export function WebhookEndpointScreen({
  scope,
  endpointId,
  filters,
  onFilters,
  onGone,
}: WebhookEndpointScreenProps) {
  // Once the endpoint is deleted nothing here asks for it again: the way out is the list.
  const [gone, setGone] = useState(false)
  const endpoint = useGetWebhookEndpoint(endpointId, {
    query: { enabled: !gone },
    request: useEnvironmentRequest(),
  })

  return (
    <>
      <Link
        to='/w/$workspaceId/p/$projectId/e/$environmentId/webhooks'
        params={scope}
        className='text-sm text-link underline underline-offset-4'
      >
        ← All webhook endpoints
      </Link>
      <PageHeader
        title='Webhook endpoint'
        description='What this endpoint is, how it is doing, and everything that was sent to it.'
      />
      {gone ? null : (
        <QueryState query={endpoint} label='Loading the endpoint'>
          {(found) => (
            <>
              <EndpointCard
                scope={scope}
                endpoint={found}
                hideDeliveriesLink
                onDeleted={() => {
                  setGone(true)
                  onGone()
                }}
              />
              <Deliveries
                scope={scope}
                endpointId={endpointId}
                // Read again here: the router hands a route its validated search merged over
                // the raw one, so a key the validation left out is still in what it gives.
                filters={deliverySearch({ ...filters })}
                onFilters={onFilters}
              />
            </>
          )}
        </QueryState>
      )}
    </>
  )
}
