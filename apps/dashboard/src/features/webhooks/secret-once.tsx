import type { ReactNode } from 'react'
import { CopyButton } from '~/components/copy-button'

/**
 * A signing secret, shown the one time the server returns it.
 *
 * It is rendered from the state of the dialog that holds it and from nowhere else: when that
 * dialog closes, the secret is in no state, cache, storage or address, and the API cannot
 * show it again.
 *
 * @param props - `secret`: the `whsec_…` value; `children`: what to do with it; `testId`:
 *   the element's `data-testid`, for a screen that shows a signing secret of another kind.
 * @returns The secret, a way to copy it, and the notes.
 */
export function SecretOnce({
  secret,
  children,
  testId = 'webhook-secret',
}: {
  secret: string
  children?: ReactNode
  testId?: string
}) {
  return (
    <div className='flex flex-col gap-3'>
      <code
        data-testid={testId}
        className='rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all'
      >
        {secret}
      </code>
      <CopyButton value={secret} label='Copy secret' />
      {children}
    </div>
  )
}
