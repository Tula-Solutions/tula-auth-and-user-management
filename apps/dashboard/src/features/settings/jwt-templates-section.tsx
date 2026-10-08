import {
  isCustomClaimKey,
  JWT_TEMPLATE_SOURCES,
  type JwtTemplateSource,
  jwtTemplateMaxBytes,
  MAX_CUSTOM_CLAIM_CONSTANT_LENGTH,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_JWT_TEMPLATE_CLAIMS,
  MAX_JWT_TEMPLATES,
  RESERVED_CLAIM_NAMES,
} from '@tula/contract'
import { type KeyboardEvent, useState } from 'react'
import type { JwtTemplate, JwtTemplateClaim, SessionProfile } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { SelectField, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { NativeSelectOption } from '~/components/ui/native-select'
import { wholeNumber } from './inputs'
import type { SettingsEditor } from './settings-editor'

const TEMPLATE_NAME = /^[a-z][a-z0-9_-]{0,31}$/

/** What a claim's value is, as the select offers it: a source, or a kind of constant. */
type ClaimKind = JwtTemplateSource | 'text' | 'number' | 'boolean'

const SOURCE_LABELS: Record<JwtTemplateSource, string> = {
  'user.email': 'The user’s email address',
  'user.email_verified': 'Whether the email address is verified',
  'user.created_at': 'When the account was created',
  'session.client': 'The kind of client (web, ios, android, server)',
  'session.created_at': 'When the session was signed in to',
}

/** A claim as the settings document holds it: exactly one of a source and a constant. */
type Claim = { from: JwtTemplateSource } | { value: string | number | boolean }

function kindOf(claim: Claim): ClaimKind {
  if ('from' in claim) {
    return claim.from
  }
  if (typeof claim.value === 'number') {
    return 'number'
  }
  return typeof claim.value === 'boolean' ? 'boolean' : 'text'
}

function claimOf(kind: ClaimKind): Claim {
  switch (kind) {
    case 'text':
      return { value: '' }
    case 'number':
      return { value: 0 }
    case 'boolean':
      return { value: false }
    default:
      return { from: kind }
  }
}

/**
 * The server's error for a field or for anything inside it: a claim that is refused is
 * reported at the claim or at its `from` / `value`.
 */
function errorUnder(errors: Record<string, string>, path: string): string | undefined {
  if (errors[path]) {
    return errors[path]
  }
  const inside = Object.keys(errors).find((field) => field.startsWith(`${path}.`))
  return inside ? errors[inside] : undefined
}

/** Run an action on Enter instead of submitting the whole settings form. */
function onEnter(action: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      action()
    }
  }
}

function claimKeyProblem(key: string, claims: Record<string, Claim>): string | undefined {
  if ((RESERVED_CLAIM_NAMES as readonly string[]).includes(key)) {
    return `“${key}” is a reserved claim name: Tula sets it itself.`
  }
  if (!isCustomClaimKey(key)) {
    return 'Use letters, digits and “_”, not starting with a digit (up to 32).'
  }
  if (Object.hasOwn(claims, key)) {
    return 'A claim with that name exists.'
  }
  if (Object.keys(claims).length >= MAX_JWT_TEMPLATE_CLAIMS) {
    return `A template has at most ${MAX_JWT_TEMPLATE_CLAIMS} claims.`
  }
  return undefined
}

function ClaimRow({
  name,
  claim,
  error,
  onChange,
  onRemove,
}: {
  name: string
  claim: Claim
  error: string | undefined
  onChange: (claim: Claim) => void
  onRemove: () => void
}) {
  const kind = kindOf(claim)
  return (
    <li className='flex flex-col gap-3 rounded-md border p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <code className='min-w-0 break-all text-sm font-semibold'>{name}</code>
        <ActionButton
          variant='ghost'
          size='sm'
          onClick={onRemove}
          aria-label={`Take out the ${name} claim`}
        >
          Take out
        </ActionButton>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <SelectField
          label={`Value of ${name}`}
          value={kind}
          onChange={(event) => onChange(claimOf(event.target.value as ClaimKind))}
          error={error}
        >
          {JWT_TEMPLATE_SOURCES.map((source) => (
            <NativeSelectOption key={source} value={source}>
              {SOURCE_LABELS[source]}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value='text'>A fixed text</NativeSelectOption>
          <NativeSelectOption value='number'>A fixed number</NativeSelectOption>
          <NativeSelectOption value='boolean'>Fixed: true or false</NativeSelectOption>
        </SelectField>
        {kind === 'text' ? (
          <TextField
            label={`Text of ${name}`}
            value={String((claim as { value: string }).value)}
            maxLength={MAX_CUSTOM_CLAIM_CONSTANT_LENGTH}
            autoComplete='off'
            spellCheck={false}
            onChange={(event) => onChange({ value: event.target.value })}
            hint='Every session of the profile gets this text. It is what you type, not something Tula checked.'
          />
        ) : null}
        {kind === 'number' ? (
          <TextField
            label={`Number of ${name}`}
            type='number'
            inputMode='numeric'
            value={String((claim as { value: number }).value)}
            onChange={(event) => onChange({ value: wholeNumber(event.target.value) })}
          />
        ) : null}
        {kind === 'boolean' ? (
          <SelectField
            label={`${name} is`}
            value={String((claim as { value: boolean }).value)}
            onChange={(event) => onChange({ value: event.target.value === 'true' })}
          >
            <NativeSelectOption value='true'>true</NativeSelectOption>
            <NativeSelectOption value='false'>false</NativeSelectOption>
          </SelectField>
        ) : null}
      </div>
    </li>
  )
}

function TemplateCard({
  name,
  claims,
  usedBy,
  errors,
  onChange,
  onRemove,
}: {
  name: string
  claims: Record<string, Claim>
  usedBy: string[]
  errors: Record<string, string>
  onChange: (claims: Record<string, Claim>) => void
  onRemove: () => void
}) {
  const path = `sessions.jwtTemplates.${name}`
  const [newKey, setNewKey] = useState('')
  const [keyProblem, setKeyProblem] = useState<string>()
  const [removeProblem, setRemoveProblem] = useState<string>()
  const bytes = jwtTemplateMaxBytes({ claims })
  const tooLarge = bytes > MAX_CUSTOM_CLAIMS_BYTES
  const size = `${bytes.toLocaleString('en-US')} of ${MAX_CUSTOM_CLAIMS_BYTES.toLocaleString('en-US')} bytes`
  const entries = Object.entries(claims)

  function addClaim() {
    const key = newKey.trim()
    const problem = claimKeyProblem(key, claims)
    setKeyProblem(problem)
    if (problem === undefined) {
      setNewKey('')
      // The kind of client: a value that says nothing about a person, until one is chosen.
      onChange({ ...claims, [key]: { from: 'session.client' } })
    }
  }

  function remove() {
    // The server refuses a profile that names a missing template; say why here, before a save.
    if (usedBy.length > 0) {
      setRemoveProblem(
        usedBy.length === 1
          ? `The ${usedBy[0]} profile uses this template. Choose another for it first.`
          : `The profiles ${usedBy.join(', ')} use this template. Choose another for them first.`
      )
      return
    }
    onRemove()
  }

  return (
    <li className='flex flex-col gap-4 rounded-lg border p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='font-semibold'>
          <code>{name}</code>
        </h3>
        <ActionButton
          variant='outline'
          size='sm'
          onClick={remove}
          aria-label={`Take out the ${name} template`}
        >
          Take out
        </ActionButton>
      </div>
      <p className='text-sm text-muted-foreground'>
        {usedBy.length === 0 ? 'Not used by a profile.' : `Used by: ${usedBy.join(', ')}.`}
      </p>
      <p className={tooLarge ? 'text-sm font-medium text-destructive' : 'text-sm'}>
        {tooLarge ? `Up to ${size}: too large. Take a claim out.` : `Up to ${size}.`}
      </p>
      {removeProblem && usedBy.length > 0 ? (
        <p role='alert' className='text-sm text-destructive'>
          {removeProblem}
        </p>
      ) : null}
      {errors[path] ? (
        <p role='alert' className='text-sm text-destructive'>
          {errors[path]}
        </p>
      ) : null}
      {errors[`${path}.claims`] ? (
        <p role='alert' className='text-sm text-destructive'>
          {errors[`${path}.claims`]}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className='text-sm text-muted-foreground'>No claims yet.</p>
      ) : (
        <ul className='flex flex-col gap-3' aria-label={`Claims of ${name}`}>
          {entries.map(([key, claim]) => (
            <ClaimRow
              key={key}
              name={key}
              claim={claim}
              error={errorUnder(errors, `${path}.claims.${key}`)}
              onChange={(next) => onChange({ ...claims, [key]: next })}
              onRemove={() =>
                onChange(Object.fromEntries(entries.filter(([entry]) => entry !== key)))
              }
            />
          ))}
        </ul>
      )}
      <div className='flex flex-wrap items-end gap-2'>
        <TextField
          label='New claim name'
          className='min-w-0 flex-1 sm:max-w-xs'
          autoComplete='off'
          spellCheck={false}
          placeholder='role'
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
          onKeyDown={onEnter(addClaim)}
          error={keyProblem}
        />
        <ActionButton variant='outline' onClick={addClaim}>
          Add claim
        </ActionButton>
      </div>
    </li>
  )
}

/**
 * The JWT templates of an environment (ADR 0036): named sets of custom claims, which a
 * session profile chooses by name. Part of the settings editor's one draft: nothing here
 * saves by itself.
 *
 * What the server would refuse is said before a save where the screen can know it: a name or
 * a key outside the grammar, a reserved claim name, more templates or claims than the caps,
 * a template that could be larger than the cap, and taking out a template a profile uses.
 *
 * @param props - The editor's draft, its `update` and the server's field errors.
 * @returns The section.
 */
export function JwtTemplatesSection({ draft, update, errors }: SettingsEditor) {
  const sessions = draft.sessions ?? {}
  const templates = (sessions.jwtTemplates ?? {}) as Record<string, JwtTemplate>
  const profiles = (sessions.profiles ?? {}) as Record<string, SessionProfile>
  const [newName, setNewName] = useState('')
  const [nameProblem, setNameProblem] = useState<string>()

  function setTemplates(next: Record<string, JwtTemplate>) {
    update((current) => ({ ...current, sessions: { ...current.sessions, jwtTemplates: next } }))
  }

  function addTemplate() {
    const name = newName.trim()
    const problem = !TEMPLATE_NAME.test(name)
      ? 'Use lowercase letters, digits, “-” or “_”, starting with a letter (up to 32).'
      : Object.hasOwn(templates, name)
        ? 'A template with that name exists.'
        : Object.keys(templates).length >= MAX_JWT_TEMPLATES
          ? `An environment has at most ${MAX_JWT_TEMPLATES} templates.`
          : undefined
    setNameProblem(problem)
    if (problem === undefined) {
      setNewName('')
      setTemplates({ ...templates, [name]: { claims: {} } })
    }
  }

  const names = Object.keys(templates)
  return (
    <Section
      title='JWT templates'
      description='A template is a named set of custom claims. The sessions of a profile that uses it carry them under the “ext” claim of the access token, read again every time a token is issued. A claim comes from the user, the session or a fixed value; it can never set a claim Tula sets itself.'
    >
      {names.length === 0 ? (
        <p className='text-sm text-muted-foreground'>No templates yet.</p>
      ) : (
        <ul className='flex flex-col gap-4'>
          {names.map((name) => (
            <TemplateCard
              key={name}
              name={name}
              claims={
                (templates[name]?.claims ?? {}) as Record<string, JwtTemplateClaim> as Record<
                  string,
                  Claim
                >
              }
              usedBy={Object.keys(profiles).filter(
                (profile) => profiles[profile]?.jwtTemplate === name
              )}
              errors={errors}
              onChange={(claims) => setTemplates({ ...templates, [name]: { claims } })}
              onRemove={() =>
                setTemplates(
                  Object.fromEntries(Object.entries(templates).filter(([entry]) => entry !== name))
                )
              }
            />
          ))}
        </ul>
      )}
      {errors['sessions.jwtTemplates'] ? (
        <p role='alert' className='text-sm text-destructive'>
          {errors['sessions.jwtTemplates']}
        </p>
      ) : null}
      <div className='flex flex-wrap items-end gap-2'>
        <TextField
          label='New template name'
          className='min-w-0 flex-1 sm:max-w-xs'
          autoComplete='off'
          spellCheck={false}
          placeholder='app'
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={onEnter(addTemplate)}
          error={nameProblem}
        />
        <ActionButton variant='outline' onClick={addTemplate}>
          Add template
        </ActionButton>
      </div>
    </Section>
  )
}
