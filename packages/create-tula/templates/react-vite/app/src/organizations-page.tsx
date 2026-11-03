import {
  CreateOrganization,
  OrganizationProfile,
  OrganizationSwitcher,
  readInvitationLink,
} from '@tula-tech/react'
import { useState } from 'react'

/** Where `<OrganizationProfile>` and `<CreateOrganization>` live in this app. */
export const ORGANIZATION_PROFILE_PATH = '/organization'
export const CREATE_ORGANIZATION_PATH = '/organization/new'

/**
 * The page the switcher lives on, and the page an emailed invitation leads to: the token is read
 * from the address once (it is in the fragment, so it never reaches a server), taken out of the
 * address bar and handed to the switcher, which shows what the invitation offers.
 */
export function OrganizationsPage(props: { navigate(url: string): void }) {
  const [token] = useState(() => {
    const link = readInvitationLink(window.location.href)
    if (link) {
      window.history.replaceState(null, '', link.cleanUrl)
    }
    return link?.token
  })
  const [handled, setHandled] = useState(false)
  return (
    <section className='panel' aria-labelledby='organizations-title'>
      <h1 id='organizations-title'>Your organizations</h1>
      <OrganizationSwitcher
        invitationToken={handled ? undefined : token}
        onInvitationHandled={() => setHandled(true)}
        organizationProfileUrl={ORGANIZATION_PROFILE_PATH}
        createOrganizationUrl={CREATE_ORGANIZATION_PATH}
      />
      <p>
        <a
          href='/'
          className='button-link quiet'
          onClick={(event) => {
            event.preventDefault()
            props.navigate('/')
          }}
        >
          Back home
        </a>
      </p>
    </section>
  )
}

/** The organization's settings: General, Members, Invitations and Domains. */
export function OrganizationProfilePage() {
  return (
    <OrganizationProfile
      invitationUrl='/organizations'
      afterLeaveUrl='/organizations'
      afterDeleteUrl='/organizations'
    />
  )
}

/** A form that makes an organization and returns to the switcher. */
export function CreateOrganizationPage() {
  return <CreateOrganization afterCreateUrl='/organizations' />
}
