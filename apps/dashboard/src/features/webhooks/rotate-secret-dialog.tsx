import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useRotateWebhookSecret, type WebhookEndpoint } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Modal } from '~/components/modal'
import { SecretRequestActions } from '~/components/secret-request-actions'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { Address } from './address'
import { refreshWebhooks } from './queries'
import { SecretOnce } from './secret-once'
import { webhookMessageFor } from './words'

/**
 * A time from the server, in the operator's locale, with the exact instant for machines.
 *
 * @param props - `iso`: the time as the API gave it.
 * @returns A `<time>` element.
 */
export function Moment({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatDateTime(iso)}</time>
}

/**
 * Replace an endpoint's signing secret: ask first, then show the new secret exactly once,
 * with when the previous one stops signing.
 *
 * The new secret is held as this dialog's state while it is open and nowhere else: the
 * mutation that carried it is not kept (`gcTime: 0`, `reset()` once the secret is in state and
 * again on close).
 *
 * @param props - `endpoint`: the endpoint; `open` and `onClose`.
 * @returns The dialog.
 */
export function RotateSecretDialog({
  endpoint,
  open,
  onClose,
}: {
  endpoint: Pick<WebhookEndpoint, 'id' | 'url'>
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const rotate = useRotateWebhookSecret({
    // The refresh belongs to the mutation, not to this component: the card must show the
    // overlap even when the dialog has gone before the answer came.
    mutation: { gcTime: 0, onSuccess: () => refreshWebhooks(queryClient) },
    request: useEnvironmentRequest(),
  })
  const [rotated, setRotated] = useState<{ secret: string; overlapEndsAt: string } | null>(null)

  useEffect(() => {
    if (!open) {
      setRotated(null)
    }
  }, [open])

  function close() {
    // A rotation in flight cannot be walked away from: the server has already replaced the
    // secret, and the answer is the only place the new one is.
    if (rotate.isPending) {
      return
    }
    setRotated(null)
    rotate.reset()
    onClose()
  }

  function confirm() {
    rotate.mutate(
      { id: endpoint.id },
      {
        onSuccess: (answer) => {
          setRotated({ secret: answer.secret, overlapEndsAt: answer.rotationOverlapEndsAt })
          rotate.reset()
        },
      }
    )
  }

  if (rotated !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title='Copy the new secret now'
        description='This is the only time the new secret is shown. Nothing has broken: the secret your receiver has still signs.'
        footer={<ActionButton onClick={close}>I have copied it</ActionButton>}
      >
        <SecretOnce secret={rotated.secret}>
          <p data-testid='overlap-ends' className='text-sm'>
            The previous secret keeps signing beside it until <Moment iso={rotated.overlapEndsAt} />
            . Give your receiver the new secret before then; after it, only the new one signs.
          </p>
        </SecretOnce>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title='Rotate the signing secret?'
      busy={rotate.isPending}
      description={
        <>
          The server makes a new secret for <Address url={endpoint.url} /> and shows it once. The
          current secret is not dropped: for 24 hours every delivery is signed with both, so your
          receiver keeps verifying while you deploy the new one.
        </>
      }
    >
      {rotate.error ? (
        <p role='alert' className='text-sm text-destructive'>
          {webhookMessageFor(rotate.error)}
        </p>
      ) : null}
      <SecretRequestActions
        pending={rotate.isPending}
        onCancel={close}
        onSubmit={confirm}
        submitLabel='Rotate secret'
        pendingLabel='Rotating…'
      />
    </Modal>
  )
}
