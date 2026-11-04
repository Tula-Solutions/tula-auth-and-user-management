import type {
  CreatedOrganizationSetupLink,
  OrganizationSetupLink,
  TulaError,
} from '@tula-tech/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { formatText } from '../localization'
import type { OrganizationSectionProps } from './organization-general'
import { Confirmation, isAccessChanged, useActions, useGuard } from './organization-shared'
import { Button, Form, FormError, Heading, Status, TextField, useUi } from './ui'

/**
 * The setup links of the "Single sign-on" tab: an address an administrator of the identity
 * provider opens, with no account, to set up an OpenID Connect connection (SAML is set up here
 * or in the dashboard). The address holds the token in its fragment and is shown once, in the
 * answer of its creation: it is component state only, dropped by "Done", and never put in
 * storage or the page's own address. The list never has a token, only a name and an end.
 *
 * @param props - The organization, and what to do when the user's access changed.
 * @returns The section.
 */
export function SetupLinks(props: OrganizationSectionProps) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const organizationId = props.organization.id
  const guard = useGuard()
  const actions = useActions(props.onAccessChanged)
  const titleId = useId()
  const [links, setLinks] = useState<OrganizationSetupLink[] | null>(null)
  const [loadError, setLoadError] = useState<TulaError | null>(null)
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedOrganizationSetupLink | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const changed = useRef(props.onAccessChanged)
  changed.current = props.onAccessChanged

  const load = useCallback(async () => {
    const current = guard()
    try {
      const list = await client.organizations.sso.setupLinks(organizationId)
      if (current()) {
        setLinks(list.links)
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
  }, [client, organizationId, guard])
  useEffect(() => {
    void load()
  }, [load])

  const create = () =>
    actions.run('setup-link:create', async (current) => {
      const link = await client.organizations.sso.createSetupLink(
        organizationId,
        name.trim() === '' ? {} : { name: name.trim() }
      )
      if (current()) {
        setCreated(link)
        setName('')
      }
      await load()
    })
  const revoke = (link: OrganizationSetupLink) =>
    actions.run(`setup-link:revoke:${link.id}`, async (current) => {
      await client.organizations.sso.revokeSetupLink(organizationId, link.id)
      await load()
      if (current()) {
        setRevoking(null)
      }
      return formatText(t.organizationProfile.setupLinkRevoked, { name: link.name })
    })

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.organizationProfile.setupLinkTitle}
      </Heading>
      <p className='tula-text'>{t.organizationProfile.setupLinkIntro}</p>
      <FormError message={loadError?.message ?? actions.error?.message ?? null} />
      {links === null || links.length === 0 ? null : (
        <ul {...el('setupLinkList')}>
          {links.map((link) => (
            <li key={link.id} {...el('setupLinkItem')}>
              <div className='tula-session-text'>
                <p className='tula-session-device'>{link.name}</p>
                <p className='tula-session-meta'>
                  {link.revokedAt
                    ? t.organizationProfile.setupLinkRevokedState
                    : formatText(t.organizationProfile.setupLinkExpires, {
                        date: new Date(link.expiresAt).toLocaleDateString(),
                      })}
                </p>
              </div>
              {link.revokedAt ? null : (
                <div className='tula-button-row tula-is-compact'>
                  <Button
                    kind='danger'
                    disabled={actions.busy !== null || revoking === link.id}
                    onClick={() => {
                      actions.setError(null)
                      setRevoking(link.id)
                    }}
                  >
                    {formatText(t.organizationProfile.setupLinkRevoke, { name: link.name })}
                  </Button>
                </div>
              )}
              {revoking === link.id ? (
                <Confirmation
                  question={formatText(t.organizationProfile.setupLinkRevokeConfirm, {
                    name: link.name,
                  })}
                  confirmLabel={t.organizationProfile.setupLinkRevokeConfirmButton}
                  cancelLabel={t.organizations.cancel}
                  pending={actions.busy === `setup-link:revoke:${link.id}`}
                  onConfirm={() => void revoke(link)}
                  onCancel={() => setRevoking(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {created ? (
        <div {...el('setupLinkCreated')}>
          <p className='tula-text'>{t.organizationProfile.setupLinkShownOnce}</p>
          <TextField
            label={t.organizationProfile.setupLinkAddressLabel}
            name='setup-link-address'
            readOnly
            autoComplete='off'
            spellCheck={false}
            value={created.url}
            onValue={() => undefined}
          />
          <div className='tula-button-row tula-is-compact'>
            <Button kind='secondary' onClick={() => setCreated(null)}>
              {t.organizationProfile.setupLinkDone}
            </Button>
          </div>
        </div>
      ) : (
        <Form onSubmit={create} failure={actions.error} blocked={actions.busy !== null}>
          <TextField
            label={t.organizationProfile.setupLinkNameLabel}
            name='setup-link-name'
            autoComplete='off'
            value={name}
            onValue={setName}
          />
          <div className='tula-button-row tula-is-compact'>
            <Button type='submit' pending={actions.busy === 'setup-link:create'}>
              {t.organizationProfile.setupLinkCreate}
            </Button>
          </div>
        </Form>
      )}
      <Status message={actions.message} />
    </section>
  )
}
