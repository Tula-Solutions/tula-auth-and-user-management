import { OrganizationProfile } from '@tula-tech/nextjs'

/** The settings of the active organization: General, Members, Invitations and Domains. */
export default function TeamProfile() {
  return <OrganizationProfile invitationUrl='/team' afterLeaveUrl='/team' afterDeleteUrl='/team' />
}
