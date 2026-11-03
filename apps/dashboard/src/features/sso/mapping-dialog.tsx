import { useQueryClient } from '@tanstack/react-query'
import {
  effectiveAttributeNames,
  SSO_IDP_PRESETS,
  type SsoAttributeMapping,
  type SsoIdpPreset,
} from '@tula-tech/contract'
import { useEffect, useState } from 'react'
import {
  type SsoConnection,
  useGetSsoGroupRoles,
  useReplaceSsoGroupRoles,
  useUpdateSsoConnection,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { SelectField, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'
import { WeakeningQuestion } from '~/features/hooks/hook-form'
import { useRoles } from '~/features/organizations/use-roles'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { printableName } from '~/lib/printable'
import { refreshSso } from './queries'
import { ssoMessageFor, weakeningSentences } from './words'

const PRESET_LABELS: Record<SsoIdpPreset, string> = {
  okta: 'Okta',
  entra: 'Microsoft Entra ID',
  google_workspace: 'Google Workspace',
  jumpcloud: 'JumpCloud',
  onelogin: 'OneLogin',
  ping: 'PingIdentity',
  generic: 'Another provider',
}

const KEYS = [
  ['email', 'Email'],
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['groups', 'Groups'],
] as const

interface Row {
  group: string
  role: string
}

/**
 * The attribute names of a connection and its group-to-role mapping (ADR 0067). An empty
 * attribute field uses the preset's usual name, shown as the placeholder. Groups are checked
 * in order and the first match wins; the server refuses a system role for a group
 * (`sso.role_not_allowed`), so only the organization's own roles are offered.
 *
 * @param props - The connection, and the dialog's state.
 * @returns The dialog.
 */
export function MappingDialog({
  connection,
  open,
  onClose,
}: {
  connection: SsoConnection
  open: boolean
  onClose: () => void
}) {
  const name = printableName(connection.name)
  const queryClient = useQueryClient()
  const request = useEnvironmentRequest()
  const environment = useEnvironment()
  const update = useUpdateSsoConnection({ request, mutation: { gcTime: 0 } })
  const replace = useReplaceSsoGroupRoles({ request, mutation: { gcTime: 0 } })
  const roles = useRoles()
  const saved = useGetSsoGroupRoles(connection.id, { query: { enabled: open }, request })
  const [preset, setPreset] = useState<SsoIdpPreset>('generic')
  const [mapping, setMapping] = useState<SsoAttributeMapping>({})
  const [rows, setRows] = useState<Row[]>([])
  const [asking, setAsking] = useState(false)
  const [saving, setSaving] = useState(false)
  const updateReset = update.reset
  const replaceReset = replace.reset
  const loaded = saved.data

  useEffect(() => {
    if (open) {
      setPreset(connection.attributeMapping?.idp ?? 'generic')
      setMapping(connection.attributeMapping ?? {})
    } else {
      setAsking(false)
      setSaving(false)
      updateReset()
      replaceReset()
    }
  }, [open, connection, updateReset, replaceReset])

  useEffect(() => {
    if (open && loaded) {
      setRows(loaded.mappings.map((entry) => ({ group: entry.group, role: entry.role })))
    }
  }, [open, loaded])

  const names = effectiveAttributeNames(connection.protocol, { ...mapping, idp: preset })
  const attributeMapping = { ...mapping, idp: preset }
  const roleList = (roles.data?.data ?? []).filter((role) => !role.key.startsWith('org:sys:'))
  const error = update.error ?? replace.error
  const sentences = asking ? weakeningSentences(connection, { attributeMapping }) : []

  async function save() {
    setSaving(true)
    try {
      await update.mutateAsync({ id: connection.id, data: { attributeMapping } })
      await replace.mutateAsync({
        id: connection.id,
        data: { mappings: rows.filter((row) => row.group.trim() !== '' && row.role !== '') },
      })
      await refreshSso(queryClient)
      notify('Mapping saved')
      onClose()
    } catch {
      // The hooks hold the error and the form shows it.
      setSaving(false)
    }
  }

  function submit() {
    if (weakeningSentences(connection, { attributeMapping }).length > 0) {
      setAsking(true)
    } else {
      void save()
    }
  }

  if (asking) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title='Change who can sign in?'
        description={<>You are changing {name}.</>}
      >
        <WeakeningQuestion
          sentences={sentences}
          requireText={environment.kind === 'production' ? name : undefined}
          pending={saving}
          confirmLabel='Save mapping'
          onConfirm={() => void save()}
          onCancel={() => setAsking(false)}
        />
        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {ssoMessageFor(error)}
          </p>
        ) : null}
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Mapping for ${name}`}
      description='Which attributes of the identity provider’s answer are the email and the name, and which group gets which role.'
    >
      <form
        className='flex flex-col gap-4'
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <SelectField
          label='Identity provider'
          value={preset}
          onChange={(event) => setPreset(event.target.value as SsoIdpPreset)}
        >
          {SSO_IDP_PRESETS.map((entry) => (
            <option key={entry} value={entry}>
              {PRESET_LABELS[entry]}
            </option>
          ))}
        </SelectField>
        <fieldset className='flex flex-col gap-3'>
          <legend className='text-sm font-medium'>Attribute names</legend>
          {KEYS.map(([key, label]) => (
            <TextField
              key={key}
              label={label}
              placeholder={names[key].join(', ')}
              value={mapping[key] ?? ''}
              onChange={(event) => {
                const value = event.target.value
                setMapping((current) => ({ ...current, [key]: value || undefined }))
              }}
            />
          ))}
        </fieldset>
        <fieldset className='flex flex-col gap-3'>
          <legend className='text-sm font-medium'>Group roles</legend>
          <p className='text-sm text-muted-foreground'>
            A person in a listed group gets that role. The first match wins, so list the most
            powerful role first.
          </p>
          {rows.map((row, index) => (
            // Rows have no identity of their own; the index is their order, which is the precedence.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered, editable list without ids
            <div key={index} className='flex flex-wrap items-end gap-2'>
              <TextField
                label={`Group ${index + 1}`}
                value={row.group}
                onChange={(event) => {
                  const group = event.target.value
                  setRows((current) => current.map((r, i) => (i === index ? { ...r, group } : r)))
                }}
              />
              <SelectField
                label={`Role for group ${index + 1}`}
                value={row.role}
                onChange={(event) => {
                  const role = event.target.value
                  setRows((current) => current.map((r, i) => (i === index ? { ...r, role } : r)))
                }}
              >
                <option value=''>Choose a role</option>
                {roleList.map((role) => (
                  <option key={role.key} value={role.key}>
                    {printableName(role.name)}
                  </option>
                ))}
              </SelectField>
              <ActionButton
                variant='outline'
                size='sm'
                aria-label={`Remove group ${index + 1}`}
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </ActionButton>
            </div>
          ))}
          <div>
            <ActionButton
              variant='outline'
              size='sm'
              onClick={() => setRows((current) => [...current, { group: '', role: '' }])}
            >
              Add a group
            </ActionButton>
          </div>
        </fieldset>
        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {ssoMessageFor(error)}
          </p>
        ) : null}
        <div className='flex justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Save mapping
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
