import { useQueryClient } from '@tanstack/react-query'
import {
  type CreateHookRequest,
  CreateHookRequestSchema,
  HOOK_DEFAULT_DEADLINE_MS,
} from '@tula/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { useCreateHook } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Modal } from '~/components/modal'
import { SecretRequestActions } from '~/components/secret-request-actions'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { SecretOnce } from '~/features/webhooks/secret-once'
import {
  deadlineOf,
  HookFields,
  type HookFormValues,
  type HookProblems,
  hookProblems,
  serverProblems,
  WeakeningQuestion,
} from './hook-form'
import { refreshHooks } from './queries'
import { pointWords, weakeningSentences } from './words'

const EMPTY: HookFormValues = {
  url: '',
  deadline: String(HOOK_DEFAULT_DEADLINE_MS),
  failureMode: 'deny',
}

/**
 * Add the hook of one point, then show its signing secret exactly once.
 *
 * A hook that lets through when a call fails is asked about first, before anything is sent:
 * the contract's `hookWeakenings` says whether, and in a production environment the point's
 * name is typed.
 *
 * The server makes the secret and returns it in the answer to the registration only. It
 * exists here as this dialog's state while the dialog is open: the mutation that carried it
 * is not kept by the query client (`gcTime: 0`, and `reset()` as soon as the secret is in
 * state and again when the dialog closes). While the registration is in flight the dialog
 * cannot be dismissed: the server has made the hook by the time it answers, and the answer
 * is the only place its secret is.
 *
 * @param props - `point`: the point the hook is for; `open`; `onClose`: called with whether
 *   a hook was added.
 * @returns The dialog.
 */
export function CreateHookDialog({
  point,
  open,
  onClose,
}: {
  point: CreateHookRequest['point']
  open: boolean
  onClose: (created: boolean) => void
}) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const create = useCreateHook({
    mutation: {
      gcTime: 0,
      // Started, never awaited: the query client waits for what this returns before it
      // hands over the answer, and the secret must not wait for a list.
      onSuccess: () => {
        void refreshHooks(queryClient)
      },
    },
    request: useEnvironmentRequest(),
  })
  const [values, setValues] = useState<HookFormValues>(EMPTY)
  const [problems, setProblems] = useState<HookProblems>({})
  // The request as it will be sent, held while the operator is asked about it.
  const [asking, setAsking] = useState<CreateHookRequest | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const words = pointWords(point)

  useEffect(() => {
    if (!open) {
      setSecret(null)
      setValues(EMPTY)
      setProblems({})
      setAsking(null)
    }
  }, [open])

  function close() {
    if (create.isPending) {
      return
    }
    const created = secret !== null
    setSecret(null)
    create.reset()
    onClose(created)
  }

  function send(data: CreateHookRequest) {
    create.mutate(
      { data },
      {
        // A refusal is about the form (an address, a point that has one by now): back to it.
        onError: () => setAsking(null),
        onSuccess: (created) => {
          setSecret(created.secret)
          setAsking(null)
          create.reset()
        },
      }
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const address = values.url.trim()
    const parsed = CreateHookRequestSchema.safeParse({
      point,
      url: address,
      deadlineMs: deadlineOf(values.deadline),
      failureMode: values.failureMode,
    })
    if (!parsed.success) {
      create.reset()
      setProblems(hookProblems(parsed.error.issues, address))
      return
    }
    setProblems({})
    if (weakeningSentences(point, null, parsed.data).length > 0) {
      create.reset()
      setAsking(parsed.data)
      return
    }
    send(parsed.data)
  }

  if (secret !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title='Copy the signing secret now'
        description='This is the only time the secret is shown. Your endpoint verifies every question with it.'
        footer={<ActionButton onClick={close}>I have copied it</ActionButton>}
      >
        <SecretOnce secret={secret} testId='hook-secret'>
          <p className='text-sm'>
            Store it in your secret manager. If it is lost, remove this hook and add it again: that
            makes a new one.
          </p>
        </SecretOnce>
      </Modal>
    )
  }

  if (asking !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title='Let it through when a call fails?'
        description={
          <>
            You are adding the hook for <code className='font-mono'>{point}</code> with “let it
            through”.
          </>
        }
        busy={create.isPending}
      >
        <WeakeningQuestion
          sentences={weakeningSentences(point, null, asking)}
          requireText={environment.kind === 'production' ? point : undefined}
          pending={create.isPending}
          confirmLabel='Add hook'
          pendingLabel='Creating…'
          carriesSecret
          onConfirm={() => send(asking)}
          onCancel={() => {
            if (!create.isPending) {
              setAsking(null)
            }
          }}
        />
      </Modal>
    )
  }

  const shown = { ...serverProblems(create.error, 'create'), ...problems }
  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <>
          Add the hook for <code className='font-mono'>{point}</code>
        </>
      }
      description={words.asked}
      busy={create.isPending}
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <HookFields values={values} onChange={setValues} problems={shown} />
        {shown.general ? (
          <p role='alert' className='text-sm text-destructive'>
            {shown.general}
          </p>
        ) : null}
        <SecretRequestActions
          pending={create.isPending}
          onCancel={close}
          submitLabel='Add hook'
          pendingLabel='Creating…'
        />
      </form>
    </Modal>
  )
}
