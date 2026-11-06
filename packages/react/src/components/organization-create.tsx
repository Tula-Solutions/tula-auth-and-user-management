import type { TulaError, UserOrganization } from '@tula-tech/core'
import { useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { useRetryCountdown } from '../hooks/use-countdown'
import { useOrganizationList } from '../hooks/use-organization'
import { useClientConfig } from '../hooks/use-password-checklist'
import { formatText } from '../localization'
import { go } from '../navigation'
import { placeErrors, rateLimitedAlert } from './form-errors'
import { Notice, organizationFieldResolver, slugFrom, useGuard } from './organization-shared'
import { Button, Card, Form, FormError, type HeadingLevel, Root, TextField, useUi } from './ui'

/**
 * Props of {@link CreateOrganization}.
 *
 * @example
 * ```tsx
 * <CreateOrganization afterCreateUrl='/dashboard' />
 * ```
 */
export interface CreateOrganizationProps {
  /** Where to go once the organization exists (and, by default, is the active one). */
  afterCreateUrl?: string
  /** Called once the organization exists, before any navigation. */
  onCreated?: (organization: UserOrganization) => void
  /**
   * Make the new organization the one the session acts in. Defaults to `true`. When switching
   * fails the organization still exists, and the component says so.
   */
  switchToNew?: boolean
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
  /** The level of the title. Defaults to 1. */
  headingLevel?: HeadingLevel
}

/** The fields, by the names the server and the form's error placement use. */
const FIELDS = ['name', 'slug'] as const

/**
 * The form of {@link CreateOrganization}, without a root: `<OrganizationSwitcher>` draws it in
 * a dialog.
 *
 * @param props.onCancel - Draws a "Cancel" button that calls it (the dialog's way out).
 * @returns The card, or nothing while nobody is signed in.
 */
export function CreateOrganizationForm(
  props: Omit<CreateOrganizationProps, 'appearance' | 'headingLevel'> & { onCancel?: () => void }
) {
  const { t } = useUi()
  const { client, navigation } = useTulaContext()
  const state = useAuthState(client)
  const config = useClientConfig()
  const list = useOrganizationList()
  const guard = useGuard()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  // The short name follows the name until the user types one of their own.
  const [slugEdited, setSlugEdited] = useState(false)
  const [missing, setMissing] = useState({ name: false, slug: false })
  const [error, setError] = useState<TulaError | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState<{ name: string; switched: boolean | null } | null>(null)
  const wait = useRetryCountdown(error)
  const placed = placeErrors(error, organizationFieldResolver(FIELDS))

  if (state.status !== 'signed-in') {
    return null
  }
  if (config === null) {
    return (
      <Card title={t.createOrganization.title}>
        <p className='tula-text'>{t.common.loading}</p>
      </Card>
    )
  }
  if (done) {
    return (
      <Notice
        title={t.createOrganization.doneTitle}
        focusTitle
        message={formatText(
          done.switched === null
            ? t.createOrganization.created
            : done.switched
              ? t.organizations.created
              : t.organizations.createdNotSwitched,
          { name: done.name }
        )}
      />
    )
  }
  if (config.organizations?.enabled !== true || config.organizations.allowUserCreated !== true) {
    return <Notice title={t.createOrganization.title} message={t.createOrganization.unavailable} />
  }

  const submit = async () => {
    const trimmed = { name: name.trim(), slug: slug.trim() }
    const absent = { name: trimmed.name === '', slug: trimmed.slug === '' }
    setMissing(absent)
    if (absent.name || absent.slug) {
      return
    }
    const current = guard()
    setPending(true)
    setError(null)
    try {
      const created = await list.create(trimmed)
      if (!current()) {
        return
      }
      let switched: boolean | null = null
      if (props.switchToNew !== false) {
        // The organization exists from here on: a failure to switch is said, and the form is
        // not offered again (a second submit would answer "short name taken" for the user's own).
        try {
          await list.setActive(created.id)
          switched = true
        } catch {
          switched = false
        }
        if (!current()) {
          return
        }
      }
      props.onCreated?.(created)
      if (!go(props.afterCreateUrl, navigation.navigate)) {
        setDone({ name: created.name, switched })
      }
    } catch (caught) {
      if (current()) {
        setError(toTulaError(caught))
      }
    } finally {
      if (current()) {
        setPending(false)
      }
    }
  }

  return (
    <Card title={t.createOrganization.title} subtitle={t.createOrganization.subtitle}>
      <Form
        onSubmit={() => void submit()}
        failure={missing.name || missing.slug ? missing : error}
        blocked={pending}
      >
        <FormError {...rateLimitedAlert(placed.form, wait, t)} />
        <TextField
          label={t.organizations.nameLabel}
          name='organization-name'
          autoComplete='organization'
          value={name}
          onValue={(value) => {
            setName(value)
            setMissing((current) => ({ ...current, name: false }))
            if (!slugEdited) {
              setSlug(slugFrom(value))
            }
          }}
          errors={[
            ...(missing.name ? [t.createOrganization.nameRequired] : []),
            ...(placed.fields.name ?? []),
          ]}
          required
        />
        <TextField
          label={t.organizations.slugLabel}
          name='organization-slug'
          autoComplete='off'
          autoCapitalize='none'
          autoCorrect='off'
          spellCheck={false}
          hint={t.organizations.slugHint}
          value={slug}
          onValue={(value) => {
            setSlug(value)
            setSlugEdited(true)
            setMissing((current) => ({ ...current, slug: false }))
          }}
          errors={[
            ...(missing.slug ? [t.createOrganization.slugRequired] : []),
            ...(placed.fields.slug ?? []),
          ]}
          required
        />
        <div className='tula-button-row'>
          <Button type='submit' pending={pending}>
            {t.organizations.createSubmit}
          </Button>
          {props.onCancel ? (
            <Button kind='secondary' onClick={props.onCancel}>
              {t.organizations.cancel}
            </Button>
          ) : null}
        </div>
      </Form>
    </Card>
  )
}

/**
 * A form that creates an organization the signed-in user owns, and makes it the one the
 * session acts in. The name suggests the short name until the user types their own.
 *
 * It is drawn only where the environment lets users create organizations
 * (`organizations.allowUserCreated` of the public configuration); anywhere else it says so.
 * What the server refuses (the short name is taken, the user's limit) is shown under the field
 * or above the form. When the organization was created but switching to it failed, it says
 * that, and the new organization is in the list.
 *
 * @param props - Where to go afterwards, a callback and appearance; all optional.
 * @returns The component; nothing while signed out.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <SignedIn>
 *   <CreateOrganization afterCreateUrl='/dashboard' />
 * </SignedIn>
 * ```
 */
export function CreateOrganization(props: CreateOrganizationProps) {
  const { appearance, headingLevel, ...rest } = props
  return (
    <Root appearance={appearance} headingLevel={headingLevel}>
      <CreateOrganizationForm {...rest} />
    </Root>
  )
}
