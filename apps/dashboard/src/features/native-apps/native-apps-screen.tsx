import { MAX_NATIVE_APPS } from '@tula/contract'
import { useEffect, useRef, useState } from 'react'
import { useListNativeApps } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { CopyButton } from '~/components/copy-button'
import { PageHeader, Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { NativeAppCard } from './native-app-card'
import { AddNativeAppDialog } from './native-app-dialogs'
import { associationUrls } from './words'

/**
 * Where the environment's two association files are served, as text to copy. Shown and not
 * linked: the address is for a proxy's configuration, and the files are fetched by Apple and
 * Android from the root of the app's own domain.
 *
 * @param props - `origin`: the API's origin; `environmentId`.
 * @returns The section.
 */
export function AssociationFiles({
  origin,
  environmentId,
}: {
  origin: string
  environmentId: string
}) {
  const urls = associationUrls(origin, environmentId)
  const files = [
    {
      name: 'Apple (apple-app-site-association)',
      url: urls.apple,
      root: '/.well-known/apple-app-site-association',
    },
    { name: 'Android (assetlinks.json)', url: urls.android, root: '/.well-known/assetlinks.json' },
  ]
  return (
    <Section
      title='The files the platforms fetch'
      description='The server builds both files from the apps below. Apple and Android fetch them from the root of the domain your app claims, over https and without a redirect: have that domain answer each path with the content of the address shown here (a proxy rule that passes the request on, not a redirect).'
    >
      <dl className='grid gap-4 text-sm'>
        {files.map((file) => (
          <div key={file.url} data-testid='association-file' className='flex flex-col gap-1'>
            <dt className='font-medium'>{file.name}</dt>
            <dd className='flex flex-col items-start gap-2'>
              <span className='text-muted-foreground'>Served for this environment at</span>
              <code className='font-mono text-xs break-all'>{file.url}</code>
              <span className='text-muted-foreground'>
                Publish it on your domain at <code className='font-mono'>{file.root}</code>
              </span>
              <CopyButton value={file.url} label='Copy address' />
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

/**
 * The native apps of an environment: the iOS and Android apps the server names in the files
 * their platforms fetch to believe that an app belongs to a domain.
 *
 * @returns The screen.
 */
export function NativeAppsScreen() {
  const environment = useEnvironment()
  const apps = useListNativeApps({ request: useEnvironmentRequest() })
  const [adding, setAdding] = useState(false)
  // Read after mount, never while rendering: the dashboard is served by the API, so the
  // page's origin is the API's.
  const [origin, setOrigin] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const removed = useRef(false)
  const listed = apps.data?.data.map((app) => app.id).join(' ')

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  // A removed app's card goes, and with it the dialog that had the focus: it would fall to
  // the document. Once the list no longer holds the card, the page's heading takes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list changed, which is what `listed` says
  useEffect(() => {
    if (removed.current) {
      removed.current = false
      heading.current?.focus()
    }
  }, [listed])

  return (
    <>
      <PageHeader
        headingRef={heading}
        title='Native apps'
        description='Register your iOS and Android apps so that Apple and Android can check that an app is yours: the server names each registered app in the file its platform fetches.'
        actions={<ActionButton onClick={() => setAdding(true)}>Register app</ActionButton>}
      />
      <QueryState query={apps} label='Loading native apps'>
        {(list) => (
          <>
            <p className='text-sm text-muted-foreground'>
              {list.data.length} of {MAX_NATIVE_APPS} apps
            </p>
            {list.data.length === 0 ? (
              <EmptyState title='No native apps yet'>
                Register an iOS app by its team and bundle ID, or an Android app by its package name
                and the fingerprints of its signing certificates. Until then both files name no app.
              </EmptyState>
            ) : (
              <ul className='grid gap-4'>
                {list.data.map((app) => (
                  // The environment is part of the key: a card holds open dialogs and a form.
                  <li key={`${environment.id}:${app.id}`}>
                    <NativeAppCard
                      app={app}
                      onRemoved={() => {
                        removed.current = true
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </QueryState>
      {origin === '' ? null : <AssociationFiles origin={origin} environmentId={environment.id} />}
      <AddNativeAppDialog open={adding} onClose={() => setAdding(false)} />
    </>
  )
}
