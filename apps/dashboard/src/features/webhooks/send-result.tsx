import type { ReactNode } from 'react'
import type { WebhookSendResult } from '~/api/generated/api.gen'
import { cn } from '~/lib/utils'
import { sendResultText } from './words'

/**
 * What became of a request made on demand (a test event, a delivery sent again): the outcome,
 * the receiver's status code and how long it took, announced when it arrives.
 *
 * It is everything the server keeps of the receiver's answer: no header and no body.
 *
 * @param props - `result`: the server's answer; `children`: what follows the sentence (a link).
 * @returns A status region.
 */
export function SendResult({
  result,
  children,
}: {
  result: WebhookSendResult
  children?: ReactNode
}) {
  const delivered = result.outcome === 'delivered'
  return (
    <div
      role='status'
      className={cn(
        'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-sm',
        delivered ? 'border-input' : 'border-destructive'
      )}
    >
      {/* The outcome leads the sentence as a word: never the border's colour alone. */}
      <p data-testid='send-result' data-outcome={result.outcome}>
        {sendResultText(result)}
      </p>
      {children}
    </div>
  )
}
