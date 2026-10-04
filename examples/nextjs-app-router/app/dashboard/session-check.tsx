'use client'

import { useActionState } from 'react'
import { checkSession, type SessionCheck } from './actions'

/** A button that runs a server action and shows what the server answered. */
export function SessionCheckForm() {
  const [result, run, pending] = useActionState<SessionCheck | null>(checkSession, null)
  return (
    <form action={run}>
      <p className='row'>
        <button type='submit' className='button-link quiet' aria-disabled={pending}>
          Ask the server who I am
        </button>
      </p>
      <p role='status' data-testid='action-result'>
        {result
          ? result.email
            ? `The server action ran as ${result.email}.`
            : 'The server action found nobody signed in.'
          : ''}
      </p>
    </form>
  )
}
