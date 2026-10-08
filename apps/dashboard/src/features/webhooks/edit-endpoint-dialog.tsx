import { useQueryClient } from '@tanstack/react-query'
import { UpdateWebhookEndpointRequestSchema } from '@tula/contract'
import { ACTIVITY_TYPES } from '@tula/contract/event-types'
import { type FormEvent, useEffect, useState } from 'react'
import { useUpdateWebhookEndpoint, type WebhookEndpoint } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import {
  AddressField,
  type EndpointProblems,
  EventTypesField,
  endpointProblems,
  orderedTypes,
  serverProblems,
} from './endpoint-form'
import { refreshWebhooks } from './queries'

const KNOWN: ReadonlySet<string> = new Set(ACTIVITY_TYPES)

/** The endpoint's event types this version of the contract defines. */
function knownTypes(endpoint: WebhookEndpoint): Set<string> {
  return new Set(endpoint.eventTypes.filter((type) => KNOWN.has(type)))
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((entry) => b.has(entry))
}

/**
 * Change an endpoint's address or its event types. Only what changed is sent: a field left
 * alone keeps its value on the server, whatever it is by then.
 *
 * @param props - `endpoint`: the endpoint as listed; `open` and `onClose`.
 * @returns The dialog.
 */
export function EditEndpointDialog({
  endpoint,
  open,
  onClose,
}: {
  endpoint: WebhookEndpoint
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const update = useUpdateWebhookEndpoint({ request: useEnvironmentRequest() })
  const [url, setUrl] = useState(endpoint.url)
  const [types, setTypes] = useState<ReadonlySet<string>>(() => knownTypes(endpoint))
  const [problems, setProblems] = useState<EndpointProblems>({})
  // A later server may deliver types this dashboard cannot offer as a checkbox.
  const unknown = endpoint.eventTypes.filter((type) => !KNOWN.has(type))

  useEffect(() => {
    if (!open) {
      setUrl(endpoint.url)
      setTypes(knownTypes(endpoint))
      setProblems({})
    }
  }, [open, endpoint])

  function close() {
    update.reset()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const address = url.trim()
    const parsed = UpdateWebhookEndpointRequestSchema.safeParse({
      ...(address === endpoint.url ? {} : { url: address }),
      ...(sameSet(types, knownTypes(endpoint)) ? {} : { eventTypes: orderedTypes(types) }),
    })
    if (!parsed.success) {
      update.reset()
      setProblems(endpointProblems(parsed.error.issues, address))
      return
    }
    setProblems({})
    update.mutate(
      { id: endpoint.id, data: parsed.data },
      {
        onSuccess: async () => {
          await refreshWebhooks(queryClient)
          notify('Endpoint saved')
          close()
        },
      }
    )
  }

  const shown = { ...serverProblems(update.error), ...problems }
  return (
    <Modal
      open={open}
      onClose={close}
      title='Edit webhook endpoint'
      description='A new address is judged like a new endpoint’s, and the server forgets since when the old one was failing. The signing secret stays the same.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <AddressField value={url} onChange={setUrl} error={shown.url} />
        <EventTypesField value={types} onChange={setTypes} error={shown.eventTypes} />
        {unknown.length > 0 ? (
          <p data-testid='unknown-types' className='text-sm text-muted-foreground'>
            This endpoint also subscribes to types this version of the dashboard does not know:{' '}
            {unknown.join(', ')}. They stay as they are unless you change the event types here; a
            change replaces the whole list.
          </p>
        ) : null}
        {shown.general ? (
          <p role='alert' className='text-sm text-destructive'>
            {shown.general}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={close}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={update.isPending}>
            Save changes
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
