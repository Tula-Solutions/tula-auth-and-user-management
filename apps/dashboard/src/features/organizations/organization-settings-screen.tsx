import {
  DEFAULT_MAX_ORGANIZATIONS_CREATED_PER_USER,
  MAX_ORGANIZATIONS_CREATED_PER_USER,
} from '@tula-tech/contract'
import { SelectField, SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { numberOrNull } from '~/features/settings/inputs'
import type { SettingsDocument } from '~/features/settings/model'
import { type SettingsEditor, SettingsFrame } from '~/features/settings/settings-editor'
import { EnvironmentLink } from '~/features/shell/environment-link'
import { printable } from '~/lib/printable'
import { useRoles } from './use-roles'

type Organizations = NonNullable<SettingsDocument['organizations']>

function RoleSelect({
  label,
  hint,
  value,
  error,
  onChange,
}: {
  label: string
  hint: string
  value: string
  error?: string
  onChange: (key: string) => void
}) {
  const roles = useRoles()
  const list = roles.data?.data ?? []
  return (
    <SelectField
      label={label}
      hint={
        roles.data
          ? hint
          : `${hint} The roles could not be listed (organizations may be switched off); the current key is kept.`
      }
      error={error}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {list.map((role) => (
        <option key={role.key} value={role.key}>
          {role.name}
          {role.builtIn ? ' (built in)' : ''}
        </option>
      ))}
      {list.some((role) => role.key === value) ? null : (
        <option value={value}>{printable(value)}</option>
      )}
    </SelectField>
  )
}

function OrganizationFields({ draft, update, errors }: SettingsEditor) {
  const organizations: Organizations = draft.organizations ?? {}
  const enabled = organizations.enabled ?? false
  // A document from before the setting existed has no cap field: the default applies.
  const cap =
    organizations.maxCreatedPerUser === undefined
      ? DEFAULT_MAX_ORGANIZATIONS_CREATED_PER_USER
      : organizations.maxCreatedPerUser
  const change = (patch: Partial<Organizations>) =>
    update((current) => ({
      ...current,
      organizations: { ...current.organizations, ...patch },
    }))
  return (
    <>
      <Section
        title='Organizations'
        description='Companies, teams and workspaces your users belong to, each member holding a role.'
      >
        <div>
          <SwitchRow
            label='Organizations are on'
            description='Off, every organization route answers that organizations are off and access tokens carry no organization claims. Nothing stored is deleted: switching them on again restores every organization and membership. Switching them off is asked about first.'
            checked={enabled}
            onChange={(checked) => change({ enabled: checked })}
          />
          <SwitchRow
            label='Users may create organizations'
            description='Off, only your backend and this dashboard create organizations. On, any signed-in user may, and becomes its first member with the creator’s role below. Switching it on is asked about first.'
            checked={organizations.allowUserCreated ?? false}
            onChange={(checked) => change({ allowUserCreated: checked })}
          />
          <SwitchRow
            label='A session may have no organization'
            description='On, a user can work in their personal account, with no active organization. Off, a client has to choose an organization before it can work.'
            checked={organizations.personalAccount ?? true}
            onChange={(checked) => change({ personalAccount: checked })}
          />
        </div>
      </Section>
      <Section
        title='What users create'
        description={
          <>
            Applies to organizations users create themselves. The roles are listed in{' '}
            <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/roles'>
              Roles
            </EnvironmentLink>
            .
          </>
        }
      >
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='Organizations one user may create'
            type='number'
            inputMode='numeric'
            min={1}
            max={MAX_ORGANIZATIONS_CREATED_PER_USER}
            value={cap ?? ''}
            onChange={(event) => change({ maxCreatedPerUser: numberOrNull(event.target.value) })}
            error={errors['organizations.maxCreatedPerUser']}
            hint={`1 to ${MAX_ORGANIZATIONS_CREATED_PER_USER}. Empty: no limit. Raising it, or removing it, is asked about first.`}
          />
          <RoleSelect
            label='Role of the creator'
            hint='The role a user gets in the organization they create.'
            value={organizations.creatorRole ?? 'admin'}
            error={errors['organizations.creatorRole']}
            onChange={(creatorRole) => change({ creatorRole })}
          />
          <RoleSelect
            label='Default role'
            hint='The role a member gets when no other is chosen: an invitation, a domain.'
            value={organizations.defaultRole ?? 'member'}
            error={errors['organizations.defaultRole']}
            onChange={(defaultRole) => change({ defaultRole })}
          />
        </div>
      </Section>
    </>
  )
}

/**
 * The organizations settings of an environment (`organizations` in its settings document):
 * whether organizations are on, who may create them and how many, the creator's role, the
 * default role and whether a session may have no organization.
 *
 * It is a {@link SettingsFrame}, so it has no save path of its own: switching organizations
 * off, letting users create them and raising the cap are the contract's weakenings
 * (`settingsWeakenings`) and are asked about before the save.
 *
 * @returns The screen.
 */
export function OrganizationSettingsScreen() {
  return (
    <SettingsFrame
      title='Organization settings'
      description='Whether this environment has organizations, and how users get them.'
    >
      {(editor) => <OrganizationFields {...editor} />}
    </SettingsFrame>
  )
}
