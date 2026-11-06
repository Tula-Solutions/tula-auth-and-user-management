import { useQueryClient } from '@tanstack/react-query'
import {
  CreateOrganizationRoleRequestSchema,
  MAX_PERMISSIONS_PER_ROLE,
  normalizePermissions,
  organizationRoleWeakenings,
  ROLE_KEY_PATTERN,
  rolePermissionRefusal,
  SYSTEM_PERMISSIONS,
  UpdateOrganizationRoleRequestSchema,
} from '@tula-tech/contract'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import {
  type OrganizationRole,
  useCreateOrganizationRole,
  useUpdateOrganizationRole,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Field, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import { Textarea } from '~/components/ui/textarea'
import { WeakeningQuestion } from '~/features/hooks/hook-form'
import { etag } from '~/features/settings/model'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { printable, printableName } from '~/lib/printable'
import { refreshRoles } from './queries'
import {
  isStaleVersion,
  organizationMessageFor,
  roleGainSentences,
  systemPermissionWords,
} from './words'

/** What is wrong with the role form, by field. */
export interface RoleProblems {
  name?: string
  key?: string
  permissions?: string
  /** A failure that belongs to no field. */
  general?: string
}

/**
 * The permission keys typed in the "your own permissions" field: one per line, or separated
 * by spaces or commas.
 *
 * @param typed - The field's text.
 * @returns The entries as typed, in order, without blanks.
 */
export function customPermissionsOf(typed: string): string[] {
  return typed
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * What the role form can say about its permissions before anything is sent, with the
 * contract's own function: never a second copy of the grammar.
 *
 * @param keys - Every permission the form holds, system and custom.
 * @returns The first problem in words; `undefined` when the set is acceptable.
 */
export function permissionProblem(keys: readonly string[]): string | undefined {
  if (keys.length > MAX_PERMISSIONS_PER_ROLE) {
    return `A role holds at most ${MAX_PERMISSIONS_PER_ROLE} permissions; this one has ${keys.length}.`
  }
  for (const key of keys) {
    const refusal = rolePermissionRefusal(key)
    if (refusal === 'grammar') {
      return `“${printable(key)}” is not a permission key. Write org:<feature>:<action> in lower case, such as org:billing:read.`
    }
    if (refusal === 'reserved') {
      return `“${printable(key)}” is in the reserved sys feature, and Tula defines no such permission. Choose one of the system permissions above, or a key of your own.`
    }
  }
  return undefined
}

function PermissionBoxes({
  selected,
  onToggle,
}: {
  selected: ReadonlySet<string>
  onToggle: (key: string, on: boolean) => void
}) {
  const base = useId()
  return (
    <fieldset className='flex flex-col gap-2'>
      <legend className='text-sm font-medium'>Tula’s own permissions</legend>
      <p className='text-xs text-muted-foreground'>
        What Tula’s organization routes check. A member whose role holds one can do that through the
        client API too.
      </p>
      <ul className='flex flex-col gap-2'>
        {SYSTEM_PERMISSIONS.map((key) => {
          const words = systemPermissionWords(key)
          const id = `${base}-${key}`
          return (
            <li key={key} className='flex items-start gap-2'>
              <Checkbox
                id={id}
                checked={selected.has(key)}
                onCheckedChange={(checked) => onToggle(key, checked === true)}
                aria-describedby={`${id}-hint`}
              />
              <div className='flex flex-col'>
                <Label htmlFor={id}>{words?.label ?? key}</Label>
                <span id={`${id}-hint`} className='text-xs text-muted-foreground'>
                  <code>{key}</code>. {words?.description}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

/** Props of {@link RoleDialog}. */
export interface RoleDialogProps {
  /** The role being changed, as listed when the dialog was opened; `null` to create one. */
  role: OrganizationRole | null
  open: boolean
  onClose: () => void
  /** Read the roles again; resolves with the current role of this key, or `null` if gone. */
  reload: (key: string) => Promise<OrganizationRole | null>
}

/**
 * Create a custom role, or change one: its name and its permissions (the set sent is the whole
 * set).
 *
 * A change needs the version it read (`If-Match`): when the role was changed since the
 * dialog was opened the server refuses it, the dialog says the role has changed since it was
 * opened and offers to load the current version, and nothing is ever retried over the other
 * change. Giving a role a permission it did not have is the contract's weakening
 * (`organizationRoleWeakenings`), so it is asked about first, in a stage of the dialog, and
 * in a production environment the role's key is typed.
 *
 * @param props - See {@link RoleDialogProps}.
 * @returns The dialog.
 */
export function RoleDialog({ role, open, onClose, reload }: RoleDialogProps) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  // The role the form was made from: its version is the `If-Match` of the save.
  const [base, setBase] = useState<OrganizationRole | null>(role)
  const create = useCreateOrganizationRole({ request: useEnvironmentRequest() })
  const update = useUpdateOrganizationRole({
    request: useEnvironmentRequest({ headers: { 'If-Match': etag(base?.version ?? 0) } }),
  })
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [system, setSystem] = useState<ReadonlySet<string>>(new Set())
  const [custom, setCustom] = useState('')
  const [problems, setProblems] = useState<RoleProblems>({})
  // The permissions as they will be sent, held while the operator is asked about them.
  const [asking, setAsking] = useState<string[] | null>(null)
  const [gone, setGone] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Stable (it only calls state setters), so that the effect below runs on `open` and `role`.
  const fill = useCallback((from: OrganizationRole | null) => {
    setName(from?.name ?? '')
    setKey(from?.key ?? '')
    setSystem(new Set((from?.permissions ?? []).filter((entry) => systemPermissionWords(entry))))
    setCustom((from?.permissions ?? []).filter((entry) => !systemPermissionWords(entry)).join('\n'))
  }, [])

  // Opening the dialog starts from the role as it is listed; closing it forgets everything.
  useEffect(() => {
    if (open) {
      setBase(role)
      fill(role)
    } else {
      setProblems({})
      setAsking(null)
      setGone(false)
      setSaving(false)
      setReloading(false)
      resetCreate()
      resetUpdate()
    }
  }, [open, role, fill, resetCreate, resetUpdate])

  const stale = update.error !== null && isStaleVersion(update.error)
  const editing = base !== null

  function permissionsNow(): string[] {
    return normalizePermissions([...system, ...customPermissionsOf(custom)])
  }

  function send(permissions: string[]) {
    setSaving(true)
    const done = async (message: string) => {
      await refreshRoles(queryClient)
      notify(message)
      onClose()
    }
    if (base === null) {
      create.mutate(
        { data: { key, name, permissions } },
        {
          onError: () => {
            setSaving(false)
            setAsking(null)
          },
          onSuccess: () => done('Role created'),
        }
      )
      return
    }
    const body = {
      ...(name !== base.name ? { name } : {}),
      ...(permissions.join() !== base.permissions.join() ? { permissions } : {}),
    }
    update.mutate(
      { key: base.key, data: body },
      {
        onError: () => {
          setSaving(false)
          setAsking(null)
        },
        onSuccess: () => done('Role saved'),
      }
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    const permissions = permissionsNow()
    const problem = permissionProblem(permissions)
    create.reset()
    update.reset()
    if (base === null) {
      const parsed = CreateOrganizationRoleRequestSchema.safeParse({ key, name, permissions })
      const found: RoleProblems = {}
      if (!ROLE_KEY_PATTERN.test(key)) {
        found.key =
          'A key starts with a lower-case letter, then lower-case letters, digits and underscores, up to 32 characters.'
      }
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (issue.path[0] === 'name') {
            found.name ??= name.trim() === '' ? 'Enter a name.' : issue.message
          }
        }
      }
      if (problem) {
        found.permissions = problem
      }
      setProblems(found)
      if (Object.keys(found).length > 0) {
        return
      }
      send(permissions)
      return
    }
    const body = {
      ...(name !== base.name ? { name } : {}),
      ...(permissions.join() !== base.permissions.join() ? { permissions } : {}),
    }
    if (Object.keys(body).length === 0) {
      onClose()
      return
    }
    const parsed = UpdateOrganizationRoleRequestSchema.safeParse(body)
    const found: RoleProblems = {}
    if (!parsed.success && 'name' in body) {
      found.name = name.trim() === '' ? 'Enter a name.' : 'This name cannot be used.'
    }
    if (problem) {
      found.permissions = problem
    }
    setProblems(found)
    if (Object.keys(found).length > 0) {
      return
    }
    // Giving a role a permission is the weakening: the contract says whether this is one.
    if (organizationRoleWeakenings(base.permissions, permissions).length > 0) {
      setAsking(permissions)
      return
    }
    send(permissions)
  }

  async function loadCurrent() {
    if (base === null) {
      return
    }
    setReloading(true)
    const fresh = await reload(base.key)
    setReloading(false)
    resetUpdate()
    setSaving(false)
    setProblems({})
    if (fresh === null) {
      setGone(true)
      return
    }
    setBase(fresh)
    fill(fresh)
  }

  if (asking !== null && base !== null) {
    const added = asking.filter((entry) => !base.permissions.includes(entry))
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={`Give the role ${printableName(base.name)} more access?`}
        description='You are adding permissions to a role that members already hold.'
      >
        <WeakeningQuestion
          sentences={roleGainSentences(added)}
          requireText={environment.kind === 'production' ? base.key : undefined}
          pending={saving}
          confirmLabel='Give more access'
          onConfirm={() => send(asking)}
          onCancel={() => setAsking(null)}
        />
      </Modal>
    )
  }

  const fields = fieldErrorMap(editing ? update.error : create.error)
  const shown: RoleProblems = {
    name: fields.name,
    key: fields.key,
    permissions: Object.entries(fields).find(([field]) => field.startsWith('permissions'))?.[1],
    ...problems,
  }
  const failure = editing ? update.error : create.error
  const general =
    failure && !stale && !shown.name && !shown.key && !shown.permissions
      ? organizationMessageFor(failure)
      : undefined
  const count = permissionsNow().length

  return (
    <Modal
      open={open}
      onClose={onClose}
      className='max-w-2xl'
      title={editing ? `Edit the role ${printableName(base.name)}` : 'Create a role'}
      description={
        editing
          ? 'Members who hold the role carry the new permissions from their next token refresh.'
          : 'A custom role is a named set of permissions. Assign it to a member of an organization or offer it in an invitation.'
      }
    >
      {gone ? (
        <div className='flex flex-col gap-4'>
          <p role='alert' className='text-sm text-destructive'>
            This role no longer exists: it was deleted since you opened it.
          </p>
          <div className='flex justify-end'>
            <ActionButton variant='outline' onClick={onClose}>
              Close
            </ActionButton>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
          {stale ? (
            <div
              role='alert'
              className='flex flex-col items-start gap-2 rounded-lg border border-destructive bg-destructive-surface p-3 text-sm'
            >
              <p>
                <span className='font-semibold'>Changed since you opened it.</span> This role was
                changed by someone else after you opened it, so nothing was saved.
              </p>
              <ActionButton
                variant='outline'
                size='sm'
                pending={reloading}
                onClick={() => void loadCurrent()}
              >
                Load the current version
              </ActionButton>
            </div>
          ) : null}
          <div className='grid gap-4 sm:grid-cols-2'>
            <TextField
              label='Name'
              autoComplete='off'
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={shown.name}
            />
            <TextField
              label='Key'
              autoComplete='off'
              autoCapitalize='off'
              spellCheck={false}
              value={key}
              readOnly={editing}
              onChange={(event) => setKey(event.target.value)}
              error={shown.key}
              hint={
                editing
                  ? 'A role’s key is its identity and cannot be changed.'
                  : 'Lower-case letters, digits and underscores, such as billing_manager. It cannot be changed later.'
              }
            />
          </div>
          <PermissionBoxes
            selected={system}
            onToggle={(permission, on) => {
              const next = new Set(system)
              if (on) {
                next.add(permission)
              } else {
                next.delete(permission)
              }
              setSystem(next)
            }}
          />
          <Field
            label='Your own permissions'
            error={shown.permissions}
            hint={`One per line, as org:<feature>:<action> in lower case, such as org:billing:read. Your application checks these with has({ permission }). ${count} of ${MAX_PERMISSIONS_PER_ROLE} permissions.`}
          >
            {(control) => (
              <Textarea
                {...control}
                className='bg-field font-mono text-xs'
                rows={4}
                autoComplete='off'
                autoCapitalize='off'
                spellCheck={false}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            )}
          </Field>
          {general ? (
            <p role='alert' className='text-sm text-destructive'>
              {general}
            </p>
          ) : null}
          <div className='flex flex-wrap justify-end gap-2'>
            <ActionButton variant='outline' onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton type='submit' pending={saving}>
              {editing ? 'Save changes' : 'Create role'}
            </ActionButton>
          </div>
        </form>
      )}
    </Modal>
  )
}
