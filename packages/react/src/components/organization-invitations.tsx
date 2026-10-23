import type { AssignableRole, OrganizationInvitation, TulaError } from '@tula-tech/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useRetryCountdown } from '../hooks/use-countdown'
import { formatText } from '../localization'
import { safeUrl } from '../navigation'
import { placeErrors, rateLimitedAlert } from './form-errors'
import type { OrganizationSectionProps } from './organization-general'
import {
  Confirmation,
  formatDate,
  isAccessChanged,
  organizationFieldResolver,
  SelectField,
  useActions,
  useGuard,
} from './organization-shared'
import { Button, EmailField, Form, FormError, Heading, Status, useUi } from './ui'

const FIELDS = ['email', 'role'] as const

/**
 * The "Invitations" tab of `<OrganizationProfile>`: the invitations waiting for an answer, a
 * form that invites an address with a role, and "Revoke" after a confirmation. Drawn only for a
 * role that holds `org:sys:invitations:manage`; the server checks again, and the roles on offer
 * are the ones the user may give (their own permissions, no more).
 *
 * The link in the email leads to the provider's `invitationUrl` (or the prop of the same name
 * on `<OrganizationProfile>`), which has to be on the environment's allowed redirect URLs. When
 * the app named no such page the form says invitations cannot be sent from here yet and sends
 * nothing.
 *
 * @param props.invitationUrl - The page the email's link leads to; the provider's when absent.
 * @returns The section.
 */
export function InvitationsSection(props: OrganizationSectionProps & { invitationUrl?: string }) {
  const { el, t } = useUi()
  const { client, navigation } = useTulaContext()
  const { organization } = props
  const organizationId = organization.id
  const guard = useGuard()
  const actions = useActions(props.onAccessChanged)
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const [invitations, setInvitations] = useState<OrganizationInvitation[] | null>(null)
  const [roles, setRoles] = useState<AssignableRole[] | null>(null)
  const [loadError, setLoadError] = useState<TulaError | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  const [missing, setMissing] = useState({ email: false, role: false })
  const [revoking, setRevoking] = useState<string | null>(null)
  const changed = useRef(props.onAccessChanged)
  changed.current = props.onAccessChanged
  const invitationUrl = props.invitationUrl ?? navigation.invitationUrl
  const wait = useRetryCountdown(actions.failed === 'invite' ? actions.error : null)
  const placed = placeErrors(
    actions.failed === 'invite' ? actions.error : null,
    organizationFieldResolver(FIELDS)
  )

  const load = useCallback(async () => {
    const current = guard()
    try {
      const [list, assignable] = await Promise.all([
        client.organizations.invitations.list(organizationId),
        client.organizations.roles(organizationId),
      ])
      if (current()) {
        setInvitations(list.data)
        setRoles(assignable.data)
        setLoadError(null)
        // The invited person joins as "member" unless the inviter picks another.
        setRole(
          (chosen) =>
            chosen ||
            (assignable.data.find((entry) => entry.key === 'member') ?? assignable.data[0])?.key ||
            ''
        )
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
  }, [client, organizationId, guard])
  useEffect(() => {
    void load()
  }, [load])

  const invite = () => {
    const address = email.trim()
    const absent = { email: address === '', role: role === '' }
    setMissing(absent)
    if (absent.email || absent.role) {
      return
    }
    void actions.run('invite', async () => {
      // Resolved here, when it is used: a render never reads the page's address.
      const redirectUrl = safeUrl(invitationUrl, window.location.href)
      if (redirectUrl === null) {
        throw new Error('invitationUrl')
      }
      await client.organizations.invitations.invite(organizationId, {
        email: address,
        role,
        redirectUrl,
      })
      setEmail('')
      await load()
      return formatText(t.organizationProfile.inviteSent, { email: address })
    })
  }
  const revoke = (invitation: OrganizationInvitation) =>
    actions.run(`revoke:${invitation.id}`, async (current) => {
      await client.organizations.invitations.revoke(organizationId, invitation.id)
      await load()
      if (current()) {
        setRevoking(null)
        title.current?.focus()
      }
      return formatText(t.organizationProfile.invitationRevoked, { email: invitation.email })
    })

  const roleName = (key: string) => roles?.find((entry) => entry.key === key)?.name ?? key
  const canInvite = safeUrl(invitationUrl, 'https://invalid.example/') !== null
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId} headingRef={title}>
        {t.organizationProfile.invitationsTitle}
      </Heading>
      <p className='tula-text'>{t.organizationProfile.invitationsIntro}</p>
      <FormError message={loadError?.message ?? null} />
      {invitations === null ? (
        <p className='tula-text'>{loadError ? null : t.organizationProfile.invitationsLoading}</p>
      ) : invitations.length === 0 ? (
        <p className='tula-text'>{t.organizationProfile.invitationsEmpty}</p>
      ) : (
        <ul {...el('invitationList')}>
          {invitations.map((invitation) => (
            <li key={invitation.id} {...el('invitationItem')}>
              <div className='tula-session-text'>
                <p className='tula-session-device'>{invitation.email}</p>
                <p className='tula-session-meta'>
                  {formatText(t.organizationProfile.memberRole, {
                    role: roleName(invitation.role),
                  })}
                  {' · '}
                  {formatText(t.organizationProfile.invitationExpires, {
                    date: formatDate(invitation.expiresAt, t.locale),
                  })}
                </p>
              </div>
              <Button
                kind='danger'
                disabled={actions.busy !== null || revoking !== null}
                aria-label={formatText(t.organizationProfile.invitationRevokeLabel, {
                  email: invitation.email,
                })}
                onClick={() => {
                  actions.setError(null)
                  setRevoking(invitation.id)
                }}
              >
                {t.organizationProfile.invitationRevoke}
              </Button>
              {revoking === invitation.id ? (
                <Confirmation
                  question={formatText(t.organizationProfile.invitationRevokeConfirm, {
                    email: invitation.email,
                  })}
                  confirmLabel={t.organizationProfile.invitationRevokeConfirmButton}
                  cancelLabel={t.organizations.cancel}
                  pending={actions.busy === `revoke:${invitation.id}`}
                  onConfirm={() => void revoke(invitation)}
                  onCancel={() => {
                    setRevoking(null)
                    actions.setError(null)
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {loadError && invitations === null ? (
        <Button kind='secondary' onClick={() => void load()}>
          {t.organizations.retry}
        </Button>
      ) : null}
      <FormError
        message={actions.failed?.startsWith('revoke:') ? (actions.error?.message ?? null) : null}
      />
      {canInvite ? (
        <Form
          onSubmit={invite}
          failure={
            missing.email || missing.role
              ? missing
              : actions.failed === 'invite'
                ? actions.error
                : null
          }
          blocked={actions.busy !== null || roles === null}
        >
          <FormError {...rateLimitedAlert(placed.form, wait, t)} />
          <EmailField
            label={t.organizationProfile.inviteEmailLabel}
            name='invite-email'
            autoComplete='off'
            value={email}
            onValue={(value) => {
              setEmail(value)
              setMissing((current) => ({ ...current, email: false }))
            }}
            errors={[
              ...(missing.email ? [t.organizationProfile.inviteEmailRequired] : []),
              ...(placed.fields.email ?? []),
            ]}
            required
          />
          <SelectField
            label={t.organizationProfile.inviteRoleLabel}
            value={role}
            options={(roles ?? []).map((entry) => ({ value: entry.key, label: entry.name }))}
            onValue={(value) => {
              setRole(value)
              setMissing((current) => ({ ...current, role: false }))
            }}
            errors={missing.role ? [t.organizationProfile.inviteRoleRequired] : []}
          />
          <div className='tula-button-row tula-is-compact'>
            <Button type='submit' pending={actions.busy === 'invite'}>
              {t.organizationProfile.inviteSubmit}
            </Button>
          </div>
        </Form>
      ) : (
        <p className='tula-text'>{t.organizationProfile.inviteUnavailable}</p>
      )}
      <Status message={actions.message} />
    </section>
  )
}
