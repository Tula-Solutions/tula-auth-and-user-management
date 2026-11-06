'use client'

import { OrganizationSwitcher, readInvitationLink } from '@tula-tech/nextjs'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * The prebuilt switcher, and the place an emailed invitation leads to: the token is read from
 * the address once (it is in the fragment, so no server ever sees it), taken out of the address
 * bar and handed to the switcher, which shows what the invitation offers.
 */
export function TeamSwitcher() {
  const router = useRouter()
  const [token, setToken] = useState<string | undefined>(undefined)
  useEffect(() => {
    // After mount: the server render has no address to read.
    const link = readInvitationLink(window.location.href)
    if (link) {
      window.history.replaceState(null, '', link.cleanUrl)
      setToken(link.token)
    }
  }, [])
  return (
    <OrganizationSwitcher
      invitationToken={token}
      onInvitationHandled={() => setToken(undefined)}
      // The server components read the active organization from the cookies the switch set.
      onSwitch={() => router.refresh()}
      organizationProfileUrl='/team/profile'
      createOrganizationUrl='/team/new'
    />
  )
}
