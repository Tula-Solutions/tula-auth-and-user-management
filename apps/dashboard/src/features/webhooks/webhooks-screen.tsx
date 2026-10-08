import { MAX_WEBHOOK_ENDPOINTS } from '@tula/contract'
import { useState } from 'react'
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
  return (
    <>
      <PageHeader
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
                    <EndpointCard scope={scope} endpoint={endpoint} />
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
