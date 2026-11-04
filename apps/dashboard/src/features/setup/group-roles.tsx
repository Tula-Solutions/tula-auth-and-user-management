import { useEffect, useState } from 'react'
import { messageFor } from '~/api/errors'
import type { SsoConnection, SsoGroupRoles } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { TextField } from '~/components/field'
import { Section } from '~/components/page'
import { setupRequest } from './setup-api'

export function GroupRoles({ connection }: { connection: SsoConnection }) {
  const [rows, setRows] = useState<{ group: string; role: string }[] | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setupRequest<SsoGroupRoles>(`/connections/${connection.id}/group-roles`)
      .then((result) => live && setRows(result.mappings))
      .catch((failure) => live && setError(messageFor(failure)))
    return () => {
      live = false
    }
  }, [connection.id])

  async function save() {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      await setupRequest(`/connections/${connection.id}/group-roles`, {
        method: 'PUT',
        body: { mappings: (rows ?? []).filter((r) => r.group !== '' && r.role !== '') },
      })
      setMessage('Group roles saved.')
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <Section
      title='3. Map groups to roles (optional)'
      description='A person in a listed group gets that role in the organization. The first match wins, so list the most powerful role first.'
    >
      {(rows ?? []).map((row, index) => (
        // The rows have no identity of their own; an index is their order, which is the precedence.
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered, editable list without ids
        <div key={index} className='flex flex-wrap items-end gap-2'>
          <TextField
            label={`Group ${index + 1}`}
            value={row.group}
            onChange={(e) =>
              setRows((current) =>
                (current ?? []).map((r, i) => (i === index ? { ...r, group: e.target.value } : r))
              )
            }
          />
          <TextField
            label={`Role for group ${index + 1}`}
            value={row.role}
            onChange={(e) =>
              setRows((current) =>
                (current ?? []).map((r, i) => (i === index ? { ...r, role: e.target.value } : r))
              )
            }
          />
          <ActionButton
            variant='outline'
            size='sm'
            onClick={() => setRows((current) => (current ?? []).filter((_, i) => i !== index))}
          >
            Remove
          </ActionButton>
        </div>
      ))}
      <div className='flex flex-wrap gap-2'>
        <ActionButton
          variant='outline'
          onClick={() => setRows((current) => [...(current ?? []), { group: '', role: '' }])}
        >
          Add a group
        </ActionButton>
        <ActionButton onClick={save} pending={pending}>
          Save group roles
        </ActionButton>
      </div>
      {message ? (
        <p role='status' className='text-sm'>
          {message}
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
