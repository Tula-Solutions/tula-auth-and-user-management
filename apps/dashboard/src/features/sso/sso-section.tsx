import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  type SsoConnection,
  useDeleteSsoConnection,
  useListSsoConnections,
  useUpdateSsoConnection,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { Badge } from '~/components/ui/badge'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { EnvironmentLink } from '~/features/shell/environment-link'
import { formatDateTime, isHttpsUrl } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { ConnectionDialog } from './connection-dialog'
import { refreshSso } from './queries'
import { certificateStanding, isSsoDisabled, ssoMessageFor } from './words'

const STATUS_WORDS = { draft: 'Draft', active: 'Active', disabled: 'Disabled' } as const

function CopyRow({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      notify(`${label} copied`)
    } catch {
      notify('Copying was refused. Select the value and copy it by hand.')
    }
  }
  return (
    <div className='flex flex-wrap items-center justify-between gap-2'>
      <div className='min-w-0'>
        <dt className='text-xs font-medium text-muted-foreground'>{label}</dt>
        <dd className='text-sm break-all'>
          <bdi dir='ltr'>{printable(value)}</bdi>
        </dd>
      </div>
      <ActionButton variant='outline' size='sm' aria-label={`Copy ${label}`} onClick={copy}>
        Copy
      </ActionButton>
    </div>
  )
}

/** The values to give the identity provider, and the metadata download. */
function ProviderValues({ saml }: { saml: NonNullable<SsoConnection['saml']> }) {
  return (
    <div className='flex flex-col gap-2'>
      <h4 className='text-sm font-medium'>Values for your identity provider</h4>
      <dl className='flex flex-col gap-2'>
        <CopyRow label='Entity id' value={saml.spEntityId} />
        <CopyRow label='Reply URL (ACS)' value={saml.acsUrl} />
        <CopyRow label='Metadata URL' value={saml.spMetadataUrl} />
      </dl>
      {isHttpsUrl(saml.spMetadataUrl) ? (
        <a
          href={saml.spMetadataUrl}
          download='tula-sp-metadata.xml'
          className='w-fit text-sm text-link underline underline-offset-4'
        >
          Download the metadata
        </a>
      ) : (
        <p className='text-sm text-muted-foreground'>
          The metadata address is not https, so it is not offered as a download link here.
        </p>
      )}
    </div>
  )
}

function Certificates({ saml }: { saml: NonNullable<SsoConnection['saml']> }) {
  const now = Date.now()
  return (
    <ul className='flex flex-col gap-1 text-sm'>
      {saml.certificates.map((certificate) => {
        const standing = certificateStanding(certificate, now)
        return (
          <li key={certificate.fingerprint} className='flex flex-wrap items-center gap-2'>
            <span>
              Certificate <code className='text-xs'>{printable(certificate.fingerprint)}</code>{' '}
              {standing === 'expired' ? 'ended' : 'ends'} {formatDateTime(certificate.notAfter)}
            </span>
            {standing === 'expired' ? (
              <Badge variant='destructive'>Expired</Badge>
            ) : standing === 'soon' ? (
              <Badge variant='outline'>Expires within 30 days</Badge>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function Card({
  connection,
  onEdit,
  onStatus,
  onDelete,
}: {
  connection: SsoConnection
  onEdit: () => void
  onStatus: (status: 'active' | 'disabled') => void
  onDelete: () => void
}) {
  const name = printableName(connection.name)
  const now = Date.now()
  const standings = (connection.saml?.certificates ?? []).map((entry) =>
    certificateStanding(entry, now)
  )
  return (
    <li className='flex flex-col gap-3 rounded-lg border p-4' aria-label={`Connection ${name}`}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <h3 className='text-base font-medium'>{name}</h3>
          <Badge variant='outline'>{connection.protocol === 'saml' ? 'SAML' : 'OIDC'}</Badge>
          <Badge variant='outline'>{STATUS_WORDS[connection.status]}</Badge>
        </div>
        <div className='flex flex-wrap gap-2'>
          <ActionButton variant='outline' size='sm' aria-label={`Edit ${name}`} onClick={onEdit}>
            Edit
          </ActionButton>
          {connection.status === 'active' ? (
            <ActionButton
              variant='outline'
              size='sm'
              aria-label={`Disable ${name}`}
              onClick={() => onStatus('disabled')}
            >
              Disable
            </ActionButton>
          ) : (
            <ActionButton
              variant='outline'
              size='sm'
              aria-label={`Activate ${name}`}
              onClick={() => onStatus('active')}
            >
              Activate
            </ActionButton>
          )}
          <ActionButton
            variant='outline'
            size='sm'
            aria-label={`Delete ${name}`}
            onClick={onDelete}
          >
            Delete
          </ActionButton>
        </div>
      </div>
      {standings.includes('expired') ? (
        <p role='alert' className='text-sm font-medium text-destructive'>
          Warning: a signing certificate of this connection has expired. Sign-ins signed with it are
          refused until it is replaced.
        </p>
      ) : standings.includes('soon') ? (
        <p role='status' className='text-sm font-medium'>
          Warning: a signing certificate of this connection expires within 30 days. Add the next one
          before then.
        </p>
      ) : null}
      <dl className='grid gap-3 text-sm sm:grid-cols-2'>
        <div>
          <dt className='text-xs font-medium text-muted-foreground'>Domains</dt>
          <dd>
            {connection.domains.length === 0
              ? 'None bound yet'
              : connection.domains.map((domain) => (
                  <bdi key={domain} dir='ltr' className='mr-2 inline-block'>
                    {printable(domain)}
                  </bdi>
                ))}
          </dd>
        </div>
        <div>
          <dt className='text-xs font-medium text-muted-foreground'>Role of people who sign in</dt>
          <dd>{printable(connection.defaultRole)}</dd>
        </div>
        {connection.protocol === 'oidc' ? (
          <>
            <div>
              <dt className='text-xs font-medium text-muted-foreground'>Issuer</dt>
              <dd className='break-all'>
                <bdi dir='ltr'>{printable(connection.issuer)}</bdi>
              </dd>
            </div>
            <div>
              <dt className='text-xs font-medium text-muted-foreground'>Client secret</dt>
              <dd>{connection.clientSecretSet ? 'Saved, never shown again' : 'Not set'}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {connection.saml ? (
        <>
          <Certificates saml={connection.saml} />
          <ProviderValues saml={connection.saml} />
        </>
      ) : null}
    </li>
  )
}

/** Props of {@link SsoSection}. */
export interface SsoSectionProps {
  organizationId: string
  organizationName: string
}

/**
 * An organization's single sign-on connections (ADR 0067): list, create (OIDC and SAML),
 * edit, activate, disable and delete, the service provider values with copy buttons and the
 * SAML metadata download, and a warning for a certificate that ends within 30 days or has
 * ended. The client secret is never shown after it is saved.
 *
 * @param props - See {@link SsoSectionProps}.
 * @returns The section.
 */
export function SsoSection({ organizationId, organizationName: typed }: SsoSectionProps) {
  const organizationName = printableName(typed)
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const connections = useListSsoConnections({ organizationId }, { request })
  const update = useUpdateSsoConnection({ request })
  const remove = useDeleteSsoConnection({ request })
  const [editing, setEditing] = useState<{ connection: SsoConnection | null } | null>(null)
  const [switching, setSwitching] = useState<{
    connection: SsoConnection
    status: 'active' | 'disabled'
  } | null>(null)
  const [deleting, setDeleting] = useState<SsoConnection | null>(null)

  function closeSwitch() {
    update.reset()
    setSwitching(null)
  }

  function closeDeletion() {
    remove.reset()
    setDeleting(null)
  }

  function runSwitch() {
    if (switching === null) {
      return
    }
    update.mutate(
      { id: switching.connection.id, data: { status: switching.status } },
      {
        onSuccess: async () => {
          await refreshSso(queryClient)
          notify(switching.status === 'active' ? 'Connection activated' : 'Connection disabled')
          closeSwitch()
        },
      }
    )
  }

  function runDeletion() {
    if (deleting === null) {
      return
    }
    remove.mutate(
      { id: deleting.id },
      {
        onSuccess: async () => {
          await refreshSso(queryClient)
          notify('Connection deleted')
          closeDeletion()
        },
      }
    )
  }

  const off =
    connections.data === undefined && !connections.isPending && isSsoDisabled(connections.error)

  return (
    <Section
      title='Single sign-on'
      description='Let people on this organization’s verified domains sign in with the company’s identity provider.'
      actions={
        off ? null : (
          <ActionButton onClick={() => setEditing({ connection: null })}>
            New connection
          </ActionButton>
        )
      }
    >
      {off ? (
        <EmptyState title='Single sign-on is switched off in this environment'>
          Nothing is lost: switching it on in{' '}
          <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/organization-settings'>
            Organization settings
          </EnvironmentLink>{' '}
          brings the connections back.
        </EmptyState>
      ) : (
        <QueryState query={connections} label='Loading connections'>
          {(list) =>
            list.connections.length === 0 ? (
              <EmptyState title='No connections'>
                Bind a connection to a domain this organization has verified. It starts as a draft
                and signs nobody in until you activate it.
              </EmptyState>
            ) : (
              <ul className='flex flex-col gap-3'>
                {list.connections.map((connection) => (
                  <Card
                    key={`${environment.id}:${connection.id}`}
                    connection={connection}
                    onEdit={() => setEditing({ connection })}
                    onStatus={(status) => setSwitching({ connection, status })}
                    onDelete={() => setDeleting(connection)}
                  />
                ))}
              </ul>
            )
          }
        </QueryState>
      )}
      <ConnectionDialog
        organizationId={organizationId}
        connection={editing?.connection ?? null}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={switching !== null}
        title={`${switching?.status === 'active' ? 'Activate' : 'Disable'} ${
          switching ? printableName(switching.connection.name) : ''
        }?`}
        confirmLabel={switching?.status === 'active' ? 'Activate' : 'Disable'}
        destructive={switching?.status === 'disabled'}
        pending={update.isPending}
        error={update.error}
        errorText={ssoMessageFor}
        onConfirm={runSwitch}
        onCancel={closeSwitch}
      >
        {switching?.status === 'active'
          ? `People of ${organizationName} on the bound domains can then sign in through this connection. This is recorded in the audit log as a weakening.`
          : 'Nobody is offered this connection while it is disabled. The identities it created are kept.'}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting ? printableName(deleting.name) : ''}?`}
        confirmLabel='Delete connection'
        destructive
        requireText={
          environment.kind === 'production' && deleting ? printableName(deleting.name) : undefined
        }
        pending={remove.isPending}
        error={remove.error}
        errorText={ssoMessageFor}
        onConfirm={runDeletion}
        onCancel={closeDeletion}
      >
        The connection and its saved secret are deleted for good. People who signed in through it
        keep their accounts but can no longer use it. This cannot be undone.
      </ConfirmDialog>
    </Section>
  )
}
