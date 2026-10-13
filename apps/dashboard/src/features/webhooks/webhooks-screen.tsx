import { MAX_WEBHOOK_ENDPOINTS } from '@tula/contract'
import { useEffect, useRef, useState } from 'react'
import { useListWebhookEndpoints } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { CreateEndpointDialog } from './create-endpoint-dialog'
import { EndpointCard } from './endpoint-card'

/**
 * The webhook endpoints of an environment: where its events are delivered, signed.
 *
 * @param props - `scope`: the ids of the environment's address.
 * @returns The screen.
 */
export function WebhooksScreen({ scope }: { scope: EnvironmentScope }) {
  const environment = useEnvironment()
  const endpoints = useListWebhookEndpoints({ request: useEnvironmentRequest() })
  const [adding, setAdding] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const deleted = useRef(false)
  const listed = endpoints.data?.data.map((endpoint) => endpoint.id).join(' ')

  // A deleted endpoint's card goes, and with it the dialog that had the focus: it would
  // fall to the document. Once the list no longer holds the card, the page's heading takes
  // it. (Not sooner: while the dialog is open nothing outside it can be focused.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list changed, which is what `listed` says
  useEffect(() => {
    if (deleted.current) {
      deleted.current = false
      heading.current?.focus()
    }
  }, [listed])

  return (
    <>
      <PageHeader
        headingRef={heading}
        title='Webhooks'
        description='A webhook is a signed notice, sent to your backend, of something that has already happened in this environment. Its answer changes nothing here.'
        actions={<ActionButton onClick={() => setAdding(true)}>Add endpoint</ActionButton>}
      />
      <QueryState query={endpoints} label='Loading webhook endpoints'>
        {(list) => (
          <>
            <p className='text-sm text-muted-foreground'>
              {list.data.length} of {MAX_WEBHOOK_ENDPOINTS} endpoints
            </p>
            {list.data.length === 0 ? (
              <EmptyState title='No webhook endpoints yet'>
                Add the address of your backend and pick the event types it handles. Only events
                that happen after an endpoint was added are sent to it.
              </EmptyState>
            ) : (
              <ul className='grid gap-4'>
                {list.data.map((endpoint) => (
                  // The environment is part of the key: a card holds open dialogs and a form.
                  <li key={`${environment.id}:${endpoint.id}`}>
                    <EndpointCard
                      scope={scope}
                      endpoint={endpoint}
                      onDeleted={() => {
                        deleted.current = true
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </QueryState>
      <CreateEndpointDialog open={adding} onClose={() => setAdding(false)} />
    </>
  )
}
