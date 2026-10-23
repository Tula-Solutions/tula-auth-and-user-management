import type { OrganizationCheck } from '@tula-tech/contract/custom-claims'
import {
  ORGANIZATION_DELETE_PERMISSION,
  ORGANIZATION_MANAGE_PERMISSION,
} from '@tula-tech/contract/organization-permissions'
import type { UserOrganization } from '@tula-tech/core'
import { type RefObject, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { formatText } from '../localization'
import { placeErrors } from './form-errors'
import {
  Confirmation,
  formatDate,
  organizationFieldResolver,
  useActions,
} from './organization-shared'
import { Button, Form, FormError, Heading, Status, TextField, useUi } from './ui'

/** What every section of the organization profile is given. */
export interface OrganizationSectionProps {
  /** The organization, with the user's role and its permissions in it. */
  organization: UserOrganization
  /** Whether the user's role grants a permission. */
  has(check: OrganizationCheck): boolean
  /** Read the user's organizations again: their role and permissions come with them. */
  reload(): Promise<void>
  /**
   * Called when the server says the user's access is not what the page assumed: the profile
   * reads the organizations again and tells the user.
   */
  onAccessChanged(): void
}

const FIELDS = ['name', 'slug'] as const

/**
 * The "General" tab of `<OrganizationProfile>`: the organization's details, rename and short
 * name where the role holds `org:sys:organization:manage`, "Leave" for every member, and
 * "Delete" where the role holds `org:sys:organization:delete`.
 *
 * Leaving and deleting ask first; deleting asks for the organization's name to be typed,
 * because it is permanent. The server decides again on every call: a refusal
 * (`organization.last_manager` for the last manager who leaves, `organization.permission_required`
 * for a role that changed since the page was drawn) is shown, and the second one reads the
 * user's organizations again so the control goes away.
 *
 * @param props.onGone - Called after the user left or deleted the organization.
 * @returns The section.
 */
export function GeneralSection(
  props: OrganizationSectionProps & { onGone(kind: 'left' | 'deleted'): void }
) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const { organization, has } = props
  const titleId = useId()
  const actions = useActions(props.onAccessChanged)
  const canRename = has({ permission: ORGANIZATION_MANAGE_PERMISSION })
  const canDelete = has({ permission: ORGANIZATION_DELETE_PERMISSION })
  const [name, setName] = useState(organization.name)
  const [slug, setSlug] = useState(organization.slug)
  const [missing, setMissing] = useState({ name: false, slug: false })
  const [asking, setAsking] = useState<'leave' | 'delete' | null>(null)
  const [typed, setTyped] = useState('')
  const leaveRow = useRef<HTMLDivElement>(null)
  const deleteRow = useRef<HTMLDivElement>(null)
  const saveError = actions.failed === 'save' ? actions.error : null
  const placed = placeErrors(saveError, organizationFieldResolver(FIELDS))

  const save = () => {
    const next = { name: name.trim(), slug: slug.trim() }
    const absent = { name: next.name === '', slug: next.slug === '' }
    setMissing(absent)
    if (absent.name || absent.slug) {
      return
    }
    void actions.run('save', async () => {
      await client.organizations.update(organization.id, next)
      await props.reload()
      return t.organizationProfile.saved
    })
  }
  const cancel = (opener: RefObject<HTMLDivElement | null>) => {
    setAsking(null)
    setTyped('')
    actions.setError(null)
    opener.current?.querySelector('button')?.focus()
  }
  const leave = () =>
    void actions.run('leave', async (current) => {
      await client.organizations.leave(organization.id)
      if (current()) {
        props.onGone('left')
      }
    })
  const remove = () =>
    void actions.run('delete', async (current) => {
      await client.organizations.remove(organization.id)
      if (current()) {
        props.onGone('deleted')
      }
    })

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.organizationProfile.detailsTitle}
      </Heading>
      {canRename ? (
        <Form
          onSubmit={save}
          failure={missing.name || missing.slug ? missing : saveError}
          blocked={actions.busy !== null}
        >
          <FormError message={placed.form} />
          <TextField
            label={t.organizations.nameLabel}
            name='organization-name'
            autoComplete='off'
            value={name}
            onValue={(value) => {
              setName(value)
              setMissing((current) => ({ ...current, name: false }))
            }}
            errors={[
              ...(missing.name ? [t.createOrganization.nameRequired] : []),
              ...(placed.fields.name ?? []),
            ]}
            required
          />
          <TextField
            label={t.organizations.slugLabel}
            name='organization-slug'
            autoComplete='off'
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
            hint={t.organizations.slugHint}
            value={slug}
            onValue={(value) => {
              setSlug(value)
              setMissing((current) => ({ ...current, slug: false }))
            }}
            errors={[
              ...(missing.slug ? [t.createOrganization.slugRequired] : []),
              ...(placed.fields.slug ?? []),
            ]}
            required
          />
          <div className='tula-button-row tula-is-compact'>
            <Button type='submit' pending={actions.busy === 'save'}>
              {t.organizationProfile.save}
            </Button>
          </div>
        </Form>
      ) : (
        <>
          <p className='tula-text'>{t.organizationProfile.renameReadOnly}</p>
          <dl className='tula-details'>
            <dt>{t.organizations.nameLabel}</dt>
            <dd>{organization.name}</dd>
            <dt>{t.organizations.slugRow}</dt>
            <dd>{organization.slug}</dd>
          </dl>
        </>
      )}
      <dl className='tula-details'>
        <dt>{t.organizations.roleRow}</dt>
        <dd>{organization.role}</dd>
        <dt>{t.organizations.createdRow}</dt>
        <dd>{formatDate(organization.createdAt, t.locale)}</dd>
      </dl>
      <Status message={actions.message} />

      <div {...el('dangerZone')}>
        <Heading offset={1} {...el('sectionTitle')}>
          {t.organizationProfile.leaveTitle}
        </Heading>
        <p className='tula-text'>
          {formatText(t.organizationProfile.leaveText, { name: organization.name })}
        </p>
        <div className='tula-button-row tula-is-compact' ref={leaveRow}>
          <Button
            kind='danger'
            disabled={asking !== null || actions.busy !== null}
            onClick={() => {
              actions.setError(null)
              setAsking('leave')
            }}
          >
            {t.organizationProfile.leave}
          </Button>
        </div>
        {asking === 'leave' ? (
          <Confirmation
            question={formatText(t.organizationProfile.leaveConfirm, { name: organization.name })}
            confirmLabel={t.organizationProfile.leaveConfirmButton}
            cancelLabel={t.organizations.cancel}
            pending={actions.busy === 'leave'}
            onConfirm={leave}
            onCancel={() => cancel(leaveRow)}
          />
        ) : null}
        <FormError message={actions.failed === 'leave' ? (actions.error?.message ?? null) : null} />
      </div>

      {canDelete ? (
        <div {...el('dangerZone')}>
          <Heading offset={1} {...el('sectionTitle')}>
            {t.organizationProfile.deleteTitle}
          </Heading>
          <p className='tula-text'>
            {formatText(t.organizationProfile.deleteText, { name: organization.name })}
          </p>
          <div className='tula-button-row tula-is-compact' ref={deleteRow}>
            <Button
              kind='danger'
              disabled={asking !== null || actions.busy !== null}
              onClick={() => {
                actions.setError(null)
                setTyped('')
                setAsking('delete')
              }}
            >
              {t.organizationProfile.delete}
            </Button>
          </div>
          {asking === 'delete' ? (
            <Confirmation
              question={formatText(t.organizationProfile.deleteConfirmLabel, {
                name: organization.name,
              })}
              confirmLabel={t.organizationProfile.deleteConfirmButton}
              cancelLabel={t.organizations.cancel}
              pending={actions.busy === 'delete'}
              disabled={typed !== organization.name}
              onConfirm={remove}
              onCancel={() => cancel(deleteRow)}
            >
              <TextField
                label={t.organizations.nameLabel}
                name='confirm-organization-name'
                autoComplete='off'
                autoCapitalize='none'
                autoCorrect='off'
                spellCheck={false}
                value={typed}
                onValue={setTyped}
              />
            </Confirmation>
          ) : null}
          <FormError
            message={actions.failed === 'delete' ? (actions.error?.message ?? null) : null}
          />
        </div>
      ) : null}
    </section>
  )
}
