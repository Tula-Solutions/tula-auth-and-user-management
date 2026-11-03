'use client'

import { useLocalization, useOrganization } from '@tula-tech/react'
import { useId } from 'react'
import { FormAlert } from '@/components/tula/status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** The level of the profile's title: 2 or 3 inside a page that has an h1 of its own. */
export type OrganizationProfileLevel = 1 | 2 | 3

export interface OrganizationProfileProps {
  /** The heading level of the organization's name. Defaults to 2. */
  headingLevel?: OrganizationProfileLevel
  className?: string
}

/**
 * The permission `has()` is asked about the members: Tula's own keys, which every environment
 * defines (`org:sys:memberships:manage` and `:read`). They are keys, not words.
 */
const MANAGE_MEMBERS = 'org:sys:memberships:manage'
const READ_MEMBERS = 'org:sys:memberships:read'

/**
 * The organization the session acts in: its name, short name and creation date, the user's
 * role in it, what that role allows and whether they can see or manage the members.
 *
 * Everything shown is `useOrganization()` of `@tula-tech/react`, whose `has()` only decides
 * what to show: your server decides what to allow, from the access token's claims. This file is
 * presentation. Edit the markup and the classes freely.
 */
export function OrganizationProfile(props: OrganizationProfileProps) {
  const t = useLocalization()
  const { organization, organizationId, isLoaded, isLoading, error, has, reload } =
    useOrganization()
  const titleId = useId()
  const level = props.headingLevel ?? 2
  const Heading = `h${level}` as const

  if (error !== null) {
    return (
      <div className={cn('grid w-full max-w-md gap-3', props.className)}>
        <FormAlert message={error.message || t.organizations.loadFailed} />
        <Button type='button' variant='outline' onClick={() => void reload()}>
          {t.organizations.retry}
        </Button>
      </div>
    )
  }
  if (!isLoaded) {
    return isLoading ? (
      <p role='status' className='text-sm text-muted-foreground'>
        {t.organizations.loading}
      </p>
    ) : null
  }
  if (organizationId === null) {
    return <p className='text-sm text-muted-foreground'>{t.organizations.profileNone}</p>
  }
  if (organization === null) {
    return <FormAlert message={t.organizations.profileNotAMember} />
  }

  const members = has({ permission: MANAGE_MEMBERS })
    ? t.organizations.membersManage
    : has({ permission: READ_MEMBERS })
      ? t.organizations.membersRead
      : t.organizations.membersNone
  const created = new Intl.DateTimeFormat(t.locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(organization.createdAt))

  return (
    <Card
      role='group'
      aria-labelledby={titleId}
      className={cn(
        'w-full max-w-md gap-0 overflow-hidden rounded-lg border border-border bg-card py-0 text-card-foreground ring-0',
        'shadow-[0_1px_2px_rgb(26_26_24/0.05),0_8px_24px_rgb(26_26_24/0.08)] dark:shadow-none dark:ring-1 dark:ring-foreground/5',
        props.className
      )}
    >
      <CardHeader className='gap-1 px-5 pt-6 pb-0'>
        <p className='text-xs font-medium tracking-wide text-muted-foreground uppercase'>
          {t.organizations.profileTitle}
        </p>
        <Heading
          id={titleId}
          className='text-balance text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] break-words'
        >
          {organization.name}
        </Heading>
      </CardHeader>
      <CardContent className='grid gap-5 px-5 pt-5 pb-6'>
        <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm'>
          <dt className='text-muted-foreground'>{t.organizations.slugRow}</dt>
          <dd className='min-w-0 font-medium break-words'>{organization.slug}</dd>
          <dt className='text-muted-foreground'>{t.organizations.roleRow}</dt>
          <dd className='min-w-0 font-medium break-words'>{organization.role}</dd>
          <dt className='text-muted-foreground'>{t.organizations.createdRow}</dt>
          <dd className='font-medium'>{created}</dd>
          <dt className='text-muted-foreground'>{t.organizations.membersRow}</dt>
          <dd className='font-medium'>{members}</dd>
        </dl>
        <section aria-labelledby={`${titleId}-permissions`} className='grid gap-2'>
          <h3 id={`${titleId}-permissions`} className='text-sm font-medium'>
            {t.organizations.permissionsTitle}
          </h3>
          {organization.permissions.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{t.organizations.permissionsEmpty}</p>
          ) : (
            <ul className='flex flex-wrap gap-1.5'>
              {organization.permissions.map((permission) => (
                <li
                  key={permission}
                  className='rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs break-all'
                >
                  {permission}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
