import { MEMBERSHIPS_MANAGE_PERMISSION } from '@tula-tech/contract/organization-permissions'
import type { AssignableRole, OrganizationMember, TulaError } from '@tula-tech/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useUser } from '../hooks/use-user'
import { formatText } from '../localization'
import type { OrganizationSectionProps } from './organization-general'
import {
  Confirmation,
  isAccessChanged,
  SelectField,
  useActions,
  useGuard,
} from './organization-shared'
import { Button, FormError, Heading, Status, useUi } from './ui'

/** What a member is called: their name, else their address, else a fixed word. */
function memberName(member: OrganizationMember, unnamed: string): string {
  return member.name ?? member.email ?? unnamed
}

/**
 * The "Members" tab of `<OrganizationProfile>`: who belongs to the organization and in which
 * role. A role that holds `org:sys:memberships:manage` can change a member's role (among the
 * roles it may give) and remove a member after a confirmation; a role that only reads sees the
 * list. The user's own row has no "Remove": leaving is on the general tab.
 *
 * The server checks every call again. `organization.last_manager` (the last member who can
 * manage members cannot be removed or demoted) is shown as it is; an error that says the
 * user's access changed makes the profile read their organizations again, so a user who was
 * removed meanwhile lands on "You are no longer a member" and not on a list that fails.
 *
 * @returns The section.
 */
export function MembersSection(props: OrganizationSectionProps) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const me = useUser().user?.id ?? null
  const { organization, has } = props
  const canManage = has({ permission: MEMBERSHIPS_MANAGE_PERMISSION })
  const guard = useGuard()
  const actions = useActions(props.onAccessChanged)
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const [members, setMembers] = useState<OrganizationMember[] | null>(null)
  const [roles, setRoles] = useState<AssignableRole[] | null>(null)
  const [loadError, setLoadError] = useState<TulaError | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const changed = useRef(props.onAccessChanged)
  changed.current = props.onAccessChanged
  const organizationId = organization.id

  const load = useCallback(async () => {
    const current = guard()
    try {
      const [list, assignable] = await Promise.all([
        client.organizations.members.list(organizationId),
        canManage ? client.organizations.roles(organizationId) : Promise.resolve(null),
      ])
      if (current()) {
        setMembers(list.data)
        setRoles(assignable?.data ?? null)
        setLoadError(null)
      }
    } catch (caught) {
      if (current()) {
        const failure = toTulaError(caught)
        setLoadError(failure)
        if (isAccessChanged(failure)) {
          changed.current()
        }
      }
    }
  }, [client, organizationId, canManage, guard])
  useEffect(() => {
    void load()
  }, [load])

  const roleName = (key: string) => roles?.find((role) => role.key === key)?.name ?? key
  const changeRole = (member: OrganizationMember, role: string) =>
    actions.run(`role:${member.userId}`, async () => {
      await client.organizations.members.changeRole(organizationId, member.userId, role)
      await load()
      if (member.userId === me) {
        // Their own permissions changed with it: the profile redraws what they may do.
        await props.reload()
      }
      return formatText(t.organizationProfile.memberRoleChanged, {
        name: memberName(member, t.organizationProfile.memberUnnamed),
        role: roleName(role),
      })
    })
  const remove = (member: OrganizationMember) =>
    actions.run(`remove:${member.userId}`, async (current) => {
      await client.organizations.members.remove(organizationId, member.userId)
      await load()
      if (current()) {
        setRemoving(null)
        // The row and its buttons are gone: the section's title is where reading resumes.
        title.current?.focus()
      }
      return formatText(t.organizationProfile.memberRemoved, {
        name: memberName(member, t.organizationProfile.memberUnnamed),
      })
    })

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId} headingRef={title}>
        {t.organizationProfile.membersTitle}
      </Heading>
      <p className='tula-text'>{t.organizationProfile.membersIntro}</p>
      <FormError message={loadError?.message ?? actions.error?.message ?? null} />
      {members === null ? (
        <p className='tula-text'>{loadError ? null : t.organizationProfile.membersLoading}</p>
      ) : members.length === 0 ? (
        <p className='tula-text'>{t.organizationProfile.membersEmpty}</p>
      ) : (
        <ul {...el('memberList')}>
          {members.map((member) => {
            const name = memberName(member, t.organizationProfile.memberUnnamed)
            const isMe = member.userId === me
            const options = (roles ?? []).map((role) => ({ value: role.key, label: role.name }))
            if (!options.some((option) => option.value === member.role)) {
              // A role the user may not give still is the member's: the select must show it.
              options.unshift({ value: member.role, label: member.role })
            }
            return (
              <li key={member.userId} {...el('memberItem')}>
                <div className='tula-session-text'>
                  <p className='tula-session-device'>
                    <span>{name}</span>{' '}
                    {isMe ? <span {...el('badge')}>{t.organizationProfile.memberYou}</span> : null}
                  </p>
                  {member.email !== null && member.name !== null ? (
                    <p className='tula-session-meta'>{member.email}</p>
                  ) : null}
                  {canManage ? null : (
                    <p className='tula-session-meta'>
                      {formatText(t.organizationProfile.memberRole, { role: member.role })}
                    </p>
                  )}
                </div>
                {canManage ? (
                  <SelectField
                    hideLabel
                    label={formatText(t.organizationProfile.memberRoleLabel, { name })}
                    value={member.role}
                    options={options}
                    busy={actions.busy !== null}
                    onValue={(role) => void changeRole(member, role)}
                  />
                ) : null}
                {canManage && !isMe ? (
                  <Button
                    kind='danger'
                    disabled={actions.busy !== null || removing !== null}
                    aria-label={formatText(t.organizationProfile.memberRemoveLabel, { name })}
                    onClick={() => {
                      actions.setError(null)
                      setRemoving(member.userId)
                    }}
                  >
                    {t.organizationProfile.memberRemove}
                  </Button>
                ) : null}
                {removing === member.userId ? (
                  <Confirmation
                    question={formatText(t.organizationProfile.memberRemoveConfirm, {
                      name,
                      organization: organization.name,
                    })}
                    confirmLabel={t.organizationProfile.memberRemoveConfirmButton}
                    cancelLabel={t.organizations.cancel}
                    pending={actions.busy === `remove:${member.userId}`}
                    onConfirm={() => void remove(member)}
                    onCancel={() => {
                      setRemoving(null)
                      actions.setError(null)
                    }}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {loadError && members === null ? (
        <Button kind='secondary' onClick={() => void load()}>
          {t.organizations.retry}
        </Button>
      ) : null}
      <Status message={actions.message} />
    </section>
  )
}
