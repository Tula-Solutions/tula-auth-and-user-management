import { useQueryClient } from '@tanstack/react-query'
import {
  DOMAIN_REMINDER_DAYS,
  ORGANIZATION_DOMAIN_MODES,
} from '@tula-tech/contract/organization-domain-rules'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import {
  type OrganizationDomain,
  useListOrganizationDomains,
  useRemoveOrganizationDomain,
  useStartOrganizationDomain,
  useUpdateOrganizationDomain,
  useVerifyOrganizationDomain,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { DataTable } from '~/components/data-table'
import { SelectField, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { Badge } from '~/components/ui/badge'
import { WeakeningQuestion } from '~/features/hooks/hook-form'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { refreshOrganizations } from './queries'
import { autoJoinSentences, domainModeLabel, organizationMessageFor } from './words'

type Mode = OrganizationDomain['mode']

function ClaimDialog({
  organizationId,
  organizationName,
  claim,
  open,
  onClose,
  onClaimed,
}: {
  organizationId: string
  organizationName: string
  /**
   * A claim to send a new code for; its domain and mode are the starting point. When it is
   * verified already (current or lapsed) this proves it again: its mode and standing stay as
   * they are until the code is entered, so the mode is not asked.
   */
  claim: OrganizationDomain | null
  open: boolean
  onClose: () => void
  onClaimed: (claimed: OrganizationDomain) => void
}) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const start = useStartOrganizationDomain({ request: useEnvironmentRequest() })
  const [domain, setDomain] = useState('')
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState<Mode>('suggest')
  const [asking, setAsking] = useState(false)
  const [problems, setProblems] = useState<Record<string, string>>({})
  // Held from the submit until the list was read again, because the mutation is no longer
  // pending by then and a second click would send a second code.
  const [saving, setSaving] = useState(false)
  const { reset } = start
  const reverifying = claim?.verifiedAt != null

  useEffect(() => {
    if (open) {
      setDomain(claim?.domain ?? '')
      setMode(claim?.mode ?? 'suggest')
    } else {
      setDomain('')
      setEmail('')
      setMode('suggest')
      setAsking(false)
      setProblems({})
      setSaving(false)
      reset()
    }
  }, [open, claim, reset])

  function send() {
    setSaving(true)
    start.mutate(
      { id: organizationId, data: { domain: domain.trim(), email: email.trim(), mode } },
      {
        onError: () => {
          setSaving(false)
          setAsking(false)
        },
        onSuccess: async (claimed) => {
          await refreshOrganizations(queryClient)
          notify('Code sent')
          onClaimed(claimed)
        },
      }
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    const found: Record<string, string> = {}
    if (domain.trim() === '') {
      found.domain = 'Enter the domain to claim, such as acme.com.'
    }
    if (email.trim() === '' || !email.includes('@')) {
      found.email = 'Enter an address on that domain; the code is sent there.'
    }
    setProblems(found)
    if (Object.keys(found).length > 0) {
      return
    }
    // Joining automatically is a weakening: it is asked about before the code is sent. A
    // re-verification changes no mode, so there is nothing to ask.
    if (mode === 'auto_join' && !reverifying && claim?.mode !== 'auto_join') {
      setAsking(true)
      return
    }
    send()
  }

  if (asking) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title='Join people automatically?'
        description={`Once ${printable(domain)} is verified, this applies to ${organizationName}.`}
      >
        <WeakeningQuestion
          sentences={autoJoinSentences(domain.trim(), organizationName)}
          requireText={environment.kind === 'production' ? domain.trim() : undefined}
          pending={saving}
          confirmLabel='Send the code'
          onConfirm={send}
          onCancel={() => setAsking(false)}
        />
      </Modal>
    )
  }

  const errors = { ...fieldErrorMap(start.error), ...problems }
  const general = start.error && !errors.domain && !errors.email && !errors.mode
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={claim ? 'Send a new code' : 'Claim a domain'}
      description={
        reverifying
          ? `We email a six-digit code to an address on the domain. Enter it to keep the domain verified for another year. ${claim?.mode === 'auto_join' ? 'People who sign up on it will join automatically again once it is verified.' : 'The organization will be suggested to people who sign up on it, as before.'}`
          : 'We email a six-digit code to an address on the domain. Until you enter it the claim grants nothing.'
      }
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Domain'
          autoComplete='off'
          autoCapitalize='none'
          spellCheck={false}
          placeholder='acme.com'
          value={domain}
          readOnly={claim !== null}
          onChange={(event) => setDomain(event.target.value)}
          error={errors.domain}
          hint='Lower case, in punycode for a non-English name. A public mail domain cannot be claimed.'
        />
        <TextField
          label='Address on that domain'
          type='email'
          autoComplete='off'
          placeholder='admin@acme.com'
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
          hint='It must be on exactly that domain. The address is not kept.'
        />
        {reverifying ? null : (
          <SelectField
            label='When someone verified signs up on it'
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
            error={errors.mode}
          >
            {ORGANIZATION_DOMAIN_MODES.map((entry) => (
              <option key={entry} value={entry}>
                {domainModeLabel(entry)}
              </option>
            ))}
          </SelectField>
        )}
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {organizationMessageFor(start.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Send code
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

function VerifyDialog({
  organizationId,
  claim,
  onClose,
  onResend,
}: {
  organizationId: string
  claim: OrganizationDomain | null
  onClose: () => void
  onResend: (claim: OrganizationDomain) => void
}) {
  const queryClient = useQueryClient()
  const verify = useVerifyOrganizationDomain({ request: useEnvironmentRequest() })
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string>()
  const [saving, setSaving] = useState(false)
  const { reset } = verify
  const open = claim !== null

  useEffect(() => {
    if (!open) {
      setCode('')
      setProblem(undefined)
      setSaving(false)
      reset()
    }
  }, [open, reset])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || claim === null) {
      return
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setProblem('Enter the six digits from the email.')
      return
    }
    setProblem(undefined)
    setSaving(true)
    verify.mutate(
      { id: organizationId, domainId: claim.id, data: { code: code.trim() } },
      {
        onError: () => setSaving(false),
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Domain verified')
          onClose()
        },
      }
    )
  }

  const fields = fieldErrorMap(verify.error)
  const error = problem ?? fields.code
  const general = verify.error && !error ? organizationMessageFor(verify.error) : undefined
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={claim ? `Verify ${printable(claim.domain)}` : 'Verify a domain'}
      description='Enter the six-digit code we emailed. It stops working after a while, and after too many wrong tries.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Code'
          inputMode='numeric'
          autoComplete='one-time-code'
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={error}
        />
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {general}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-between gap-2'>
          <ActionButton variant='outline' onClick={() => claim && onResend(claim)}>
            Send a new code
          </ActionButton>
          <div className='flex flex-wrap gap-2'>
            <ActionButton variant='outline' onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton type='submit' pending={saving}>
              Verify domain
            </ActionButton>
          </div>
        </div>
      </form>
    </Modal>
  )
}

/** Days before its date at which a verified domain is said to need a new code soon. */
const EXPIRING_SOON_DAYS = Math.max(...DOMAIN_REMINDER_DAYS)

/**
 * What a domain's standing is, in words: verified (and until when), needing re-verification
 * (lapsed: it suggests and joins nobody), or waiting for its first code.
 *
 * @param props - The claim.
 * @returns The status cell.
 */
function DomainStatus({ claim }: { claim: OrganizationDomain }) {
  if (claim.status === 'needs_reverification') {
    return (
      <div className='flex flex-col gap-1'>
        <Badge variant='outline' className='border-destructive text-destructive'>
          Needs re-verification
        </Badge>
        <span>
          {claim.expiresAt ? `Lapsed ${formatDateTime(claim.expiresAt)}. ` : ''}It suggests the
          organization to nobody and joins nobody until you enter a new code.
        </span>
      </div>
    )
  }
  if (claim.status === 'verified') {
    const soon =
      claim.expiresAt !== null &&
      Date.parse(claim.expiresAt) - Date.now() <= EXPIRING_SOON_DAYS * 86_400_000
    return (
      <div className='flex flex-col gap-1'>
        <Badge variant='outline'>Verified</Badge>
        <span>
          Verified {claim.verifiedAt ? formatDateTime(claim.verifiedAt) : ''}
          {claim.expiresAt ? `. Valid until ${formatDateTime(claim.expiresAt)}` : ''}.
          {soon ? ' Send a new code before then to keep it.' : ''}
        </span>
      </div>
    )
  }
  return (
    <div className='flex flex-col gap-1'>
      <Badge variant='outline'>Waiting for the code</Badge>
      <span>
        {claim.codeExpiresAt ? `The code works until ${formatDateTime(claim.codeExpiresAt)}. ` : ''}
        It grants nothing yet.
      </span>
    </div>
  )
}

/** Props of {@link DomainsSection}. */
export interface DomainsSectionProps {
  organizationId: string
  organizationName: string
}

/**
 * An organization's domains: claimed with an emailed code, verified, switched between
 * suggesting the organization and joining people automatically, and removed.
 *
 * A pending claim grants nothing and is said to. Joining automatically is a weakening and is
 * asked about before the code is sent and before a verified domain is switched to it. A
 * removed domain keeps the members it brought in, and the confirmation says so.
 *
 * @param props - See {@link DomainsSectionProps}.
 * @returns The section.
 */
export function DomainsSection({ organizationId, organizationName: typed }: DomainsSectionProps) {
  // Written out once: what nobody can see in a name is shown in every sentence that says it.
  const organizationName = printableName(typed)
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const domains = useListOrganizationDomains(organizationId, { request })
  const update = useUpdateOrganizationDomain({ request })
  const remove = useRemoveOrganizationDomain({ request })
  const [claiming, setClaiming] = useState<{ claim: OrganizationDomain | null } | null>(null)
  const [verifying, setVerifying] = useState<OrganizationDomain | null>(null)
  const [switching, setSwitching] = useState<OrganizationDomain | null>(null)
  const [removing, setRemoving] = useState<OrganizationDomain | null>(null)

  function closeSwitch() {
    update.reset()
    setSwitching(null)
  }

  function closeRemoval() {
    remove.reset()
    setRemoving(null)
  }

  function setMode(claim: OrganizationDomain, mode: Mode, done: () => void, said = false) {
    update.mutate(
      { id: organizationId, domainId: claim.id, data: { mode } },
      {
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Domain changed')
          done()
        },
        // Switching to suggesting has no dialog of its own to say a refusal in.
        onError: (error) => {
          if (said) {
            notify(organizationMessageFor(error))
          }
        },
      }
    )
  }

  function runRemoval() {
    if (removing === null) {
      return
    }
    remove.mutate(
      { id: organizationId, domainId: removing.id },
      {
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Domain removed')
          closeRemoval()
        },
      }
    )
  }

  return (
    <Section
      title='Domains'
      description='Claim an email domain so that people who sign up with a verified address on it are suggested this organization, or join it.'
      actions={
        <ActionButton onClick={() => setClaiming({ claim: null })}>Claim a domain</ActionButton>
      }
    >
      <QueryState query={domains} label='Loading domains'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState title='No domains claimed'>
              Claim your company’s domain and prove it with a code emailed to an address there. A
              claim that is waiting for its code grants nothing.
            </EmptyState>
          ) : (
            <DataTable
              caption={`Domains of ${organizationName}`}
              rows={list.data}
              rowKey={(claim) => claim.id}
              columns={[
                {
                  header: 'Domain',
                  cell: (claim) => (
                    <bdi dir='ltr' className='font-medium'>
                      {printable(claim.domain)}
                    </bdi>
                  ),
                },
                {
                  header: 'Status',
                  cell: (claim) => <DomainStatus claim={claim} />,
                },
                { header: 'Verified sign-ups', cell: (claim) => domainModeLabel(claim.mode) },
                {
                  header: 'Actions',
                  cell: (claim) => (
                    <div className='flex flex-wrap gap-2'>
                      {claim.verifiedAt && claim.codeExpiresAt ? (
                        <ActionButton
                          variant='outline'
                          size='sm'
                          aria-label={`Enter the code for ${printable(claim.domain)}`}
                          onClick={() => setVerifying(claim)}
                        >
                          Enter code
                        </ActionButton>
                      ) : null}
                      {claim.verifiedAt ? (
                        <ActionButton
                          variant='outline'
                          size='sm'
                          aria-label={`Send a new code for ${printable(claim.domain)}`}
                          onClick={() => setClaiming({ claim })}
                        >
                          Send a new code
                        </ActionButton>
                      ) : null}
                      {claim.status === 'verified' ? (
                        <ActionButton
                          variant='outline'
                          size='sm'
                          aria-label={
                            claim.mode === 'auto_join'
                              ? `Only suggest the organization on ${printable(claim.domain)}`
                              : `Join people automatically on ${printable(claim.domain)}`
                          }
                          onClick={() =>
                            claim.mode === 'auto_join'
                              ? setMode(claim, 'suggest', () => undefined, true)
                              : setSwitching(claim)
                          }
                        >
                          {claim.mode === 'auto_join' ? 'Only suggest' : 'Join automatically'}
                        </ActionButton>
                      ) : null}
                      {claim.verifiedAt ? null : (
                        <ActionButton
                          variant='outline'
                          size='sm'
                          aria-label={`Enter the code for ${printable(claim.domain)}`}
                          onClick={() => setVerifying(claim)}
                        >
                          Enter code
                        </ActionButton>
                      )}
                      <ActionButton
                        variant='outline'
                        size='sm'
                        aria-label={`Remove the domain ${printable(claim.domain)}`}
                        onClick={() => setRemoving(claim)}
                      >
                        Remove
                      </ActionButton>
                    </div>
                  ),
                },
              ]}
            />
          )
        }
      </QueryState>
      <ClaimDialog
        organizationId={organizationId}
        organizationName={organizationName}
        claim={claiming?.claim ?? null}
        open={claiming !== null}
        onClose={() => setClaiming(null)}
        onClaimed={(claimed) => {
          setClaiming(null)
          setVerifying(claimed)
        }}
      />
      <VerifyDialog
        organizationId={organizationId}
        claim={verifying}
        onClose={() => setVerifying(null)}
        onResend={(claim) => {
          setVerifying(null)
          setClaiming({ claim })
        }}
      />
      <ConfirmDialog
        open={switching !== null}
        title={`Join people automatically on ${switching ? printable(switching.domain) : ''}?`}
        confirmLabel='Join automatically'
        destructive
        requireText={environment.kind === 'production' && switching ? switching.domain : undefined}
        pending={update.isPending}
        error={update.error}
        errorText={organizationMessageFor}
        onConfirm={() => switching && setMode(switching, 'auto_join', closeSwitch)}
        onCancel={closeSwitch}
      >
        {switching
          ? autoJoinSentences(switching.domain, organizationName).map((sentence) => (
              <span key={sentence} className='mt-2 block first:mt-0'>
                {sentence}
              </span>
            ))
          : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove the domain ${removing ? printable(removing.domain) : ''}?`}
        confirmLabel='Remove domain'
        destructive
        requireText={environment.kind === 'production' && removing ? removing.domain : undefined}
        pending={remove.isPending}
        error={remove.error}
        errorText={organizationMessageFor}
        onConfirm={runRemoval}
        onCancel={closeRemoval}
      >
        {organizationName} stops suggesting itself, or joining people, on this domain. Members who
        already joined stay members. You can claim it again, which needs a new code.
      </ConfirmDialog>
    </Section>
  )
}
