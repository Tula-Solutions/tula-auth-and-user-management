import { type FormEvent, useState } from 'react'
import { messageFor } from '~/api/errors'
import type { CreatedScimToken } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { CopyButton } from '~/components/copy-button'
import { TextField } from '~/components/field'
import { Section } from '~/components/page'
import { setupRequest } from './setup-api'

/**
 * Create the organization's SCIM token so provisioning is set up in the same sitting. The secret
 * lives in this component's state only: the portal cannot list or read a token, so a reload
 * (or leaving the page) ends the only view of it.
 */
export function ScimToken() {
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedScimToken | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      setCreated(
        await setupRequest<CreatedScimToken>('/scim-tokens', { method: 'POST', body: { name } })
      )
      setName('')
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <Section
      title='5. Provision people with SCIM (optional)'
      description='A token lets your identity provider create, update and remove the people and groups of this organization. Use the SCIM address of this server and the token as a bearer token.'
    >
      <form onSubmit={submit} className='flex flex-col gap-3' noValidate>
        <TextField
          label='Token name'
          hint='Which identity provider the token is for.'
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div>
          <ActionButton type='submit' pending={pending}>
            Create a SCIM token
          </ActionButton>
        </div>
      </form>
      {created ? (
        <div role='status' className='flex flex-col gap-2'>
          <p className='text-sm font-medium'>
            Copy this token now. It is shown once and cannot be read again; create another if you
            lose it.
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <code className='break-all rounded bg-muted px-2 py-1 text-xs'>{created.token}</code>
            <CopyButton value={created.token} label='Copy SCIM token' />
          </div>
          <p className='text-sm text-muted-foreground'>
            SCIM base address: <code>{created.scimBaseUrl}</code>
          </p>
        </div>
      ) : null}
      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </Section>
  )
}
