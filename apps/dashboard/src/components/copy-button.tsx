import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { ActionButton } from './action-button'

/**
 * Copy a value to the clipboard and say that it happened.
 *
 * The value goes to the clipboard and nowhere else: not to storage, the address or a log.
 *
 * @param props - `value`: what to copy; `label`: what it is ("Copy key").
 * @returns The button, with a polite status once copied.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return (
    <span className='inline-flex items-center gap-2'>
      <ActionButton variant='outline' size='sm' onClick={copy}>
        {state === 'copied' ? <Check aria-hidden='true' /> : <Copy aria-hidden='true' />}
        {label}
      </ActionButton>
      <span role='status' className='text-xs text-muted-foreground'>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy it by hand' : ''}
      </span>
    </span>
  )
}
