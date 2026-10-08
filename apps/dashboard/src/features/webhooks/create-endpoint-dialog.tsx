import { useQueryClient } from '@tanstack/react-query'
import { CreateWebhookEndpointRequestSchema } from '@tula/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { useCreateWebhookEndpoint } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Modal } from '~/components/modal'
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
import { SecretOnce } from './secret-once'

/**
 * Add a webhook endpoint, then show its signing secret exactly once.
 *
 * The server makes the secret and returns it in the answer to the registration only. It
 * exists here as this dialog's state while the dialog is open: the mutation that carried it
 * is not kept by the query client (`gcTime: 0`, and `reset()` as soon as the secret is in
 * state and again when the dialog closes).
 *
 * @param props - `open` and `onClose`.
 * @returns The dialog.
 */
export function CreateEndpointDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const create = useCreateWebhookEndpoint({
    mutation: { gcTime: 0 },
    request: useEnvironmentRequest(),
  })
  const [url, setUrl] = useState('')
  const [types, setTypes] = useState<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = useState<EndpointProblems>({})
  const [secret, setSecret] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setSecret(null)
      setUrl('')
      setTypes(new Set())
      setProblems({})
    }
  }, [open])

  function close() {
    setSecret(null)
    create.reset()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const address = url.trim()
    const parsed = CreateWebhookEndpointRequestSchema.safeParse({
      url: address,
      eventTypes: orderedTypes(types),
    })
    if (!parsed.success) {
      create.reset()
      setProblems(endpointProblems(parsed.error.issues, address))
      return
    }
    setProblems({})
    create.mutate(
      { data: parsed.data },
      {
        onSuccess: async (created) => {
          setSecret(created.secret)
          create.reset()
          await refreshWebhooks(queryClient)
        },
      }
    )
  }

  if (secret !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title='Copy the signing secret now'
        description='This is the only time the secret is shown. Your receiver verifies every delivery with it.'
        footer={<ActionButton onClick={close}>I have copied it</ActionButton>}
      >
        <SecretOnce secret={secret}>
          <p className='text-sm'>
            Store it in your secret manager. If it is lost, rotate the endpoint’s secret: that makes
            a new one.
          </p>
        </SecretOnce>
      </Modal>
    )
  }

  const shown = { ...serverProblems(create.error, 'create'), ...problems }
  return (
    <Modal
      open={open}
      onClose={close}
      title='Add a webhook endpoint'
      description='Events that happen from now on are posted to it, signed. Events from before are not sent.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <AddressField value={url} onChange={setUrl} error={shown.url} />
        <EventTypesField value={types} onChange={setTypes} error={shown.eventTypes} />
        {shown.general ? (
          <p role='alert' className='text-sm text-destructive'>
            {shown.general}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={close}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={create.isPending}>
            Add endpoint
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
