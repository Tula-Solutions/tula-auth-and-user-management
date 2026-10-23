import {
  isBuiltInRoleKey,
  isSystemPermission,
  MAX_CUSTOM_ROLES,
  type SystemPermission,
} from '@tula-tech/contract/organization-permissions'
import { messageFor, toApiError } from '~/api/errors'
import { own } from '~/lib/own'
import { printable } from '~/lib/printable'

// Every sentence the organizations screens say about a refusal, a role, a permission or an
// invitation. The rules themselves (the grammar of a key, the caps, which change is a
// weakening) are the contract's; only the words are the dashboard's.

/** The code the server answers while an environment has organizations switched off. */
export const DISABLED_CODE = 'organization.disabled'

/**
 * Whether a failure is the environment having organizations switched off.
 *
 * @param error - What a query or mutation threw.
 * @returns True for `organization.disabled`.
 */
export function isDisabled(error: unknown): boolean {
  return toApiError(error).code === DISABLED_CODE
}

/**
 * Whether a failure is a stale version: the role changed since it was opened.
 *
 * @param error - What a mutation threw.
 * @returns True for a 412 or `precondition.failed`.
 */
export function isStaleVersion(error: unknown): boolean {
  const failure = toApiError(error)
  return failure.status === 412 || failure.code === 'precondition.failed'
}

/** What the role dialogs say when the version they hold is no longer the role's. */
export const ROLE_CHANGED_SINCE_OPENED =
  'This role has changed since you opened it, so nothing was saved. Load the current version, then make your change again.'

const SENTENCES: Record<string, string> = {
  [DISABLED_CODE]:
    'Organizations are switched off in this environment. Switch them on in Organization settings first.',
  'organization.slug_taken': 'Another organization in this environment already uses that slug.',
  'organization.member_exists': 'That user is already a member of this organization.',
  'organization.last_manager':
    'An organization must keep at least one member who can manage its members. Give another member a role that can, then try again.',
  'organization.role_unknown': 'That role does not exist in this environment.',
  'organization.role_exists': 'A role with that key already exists, built-in roles included.',
  'organization.role_in_use':
    'Members still hold this role, in at least one organization. Give them another role first.',
  'organization.role_built_in': 'The built-in roles cannot be changed or deleted.',
  'organization.invitation_exists': 'That address already has a pending invitation here.',
  'organization.invitation_not_found': 'That invitation no longer exists.',
  'organization.invitation_role_gone': 'The role this invitation offers no longer exists.',
  'user.last_organization_manager':
    'This user is the only manager of an organization. Give the organization another manager, or delete it, then try again.',
}

/**
 * The sentence for a failed organization or role call.
 *
 * @param error - What the call threw.
 * @returns The dashboard's own sentence for the codes of this area, with the limit when the
 *   code carries one; the generic message for any other.
 */
export function organizationMessageFor(error: unknown): string {
  const failure = toApiError(error)
  if (failure.code === 'organization.role_limit') {
    const max = failure.params.max
    return `This environment has the most custom roles it can have (${typeof max === 'number' ? max : MAX_CUSTOM_ROLES}). Delete one first.`
  }
  if (failure.code === 'user.last_organization_manager') {
    const count = failure.params.count
    return typeof count === 'number' && count > 1
      ? `This user is the only manager of ${count} organizations. Give each another manager, or delete it, then try again.`
      : (own(SENTENCES, failure.code) ?? messageFor(failure))
  }
  if (isStaleVersion(failure)) {
    return ROLE_CHANGED_SINCE_OPENED
  }
  return own(SENTENCES, failure.code) ?? messageFor(failure)
}

/**
 * The ids of the organizations a refused user deletion names.
 *
 * @param error - What the deletion threw.
 * @returns The ids from `params.organizationIds`, at most the server's 20; none for any
 *   other failure.
 */
export function lastManagerOrganizationIds(error: unknown): string[] {
  const failure = toApiError(error)
  if (failure.code !== 'user.last_organization_manager') {
    return []
  }
  const ids = failure.params.organizationIds
  return typeof ids === 'string' ? ids.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)) : []
}

const SYSTEM_WORDS: Record<SystemPermission, { label: string; description: string }> = {
  'org:sys:organization:manage': {
    label: 'Manage the organization',
    description: 'Rename the organization and change its slug.',
  },
  'org:sys:organization:delete': {
    label: 'Delete the organization',
    description: 'Delete the organization and every membership in it.',
  },
  'org:sys:memberships:read': {
    label: 'See the members',
    description: 'List who belongs to the organization and the role each holds.',
  },
  'org:sys:memberships:manage': {
    label: 'Manage the members',
    description:
      'Add and remove members and change their roles. Every organization keeps at least one member who holds this.',
  },
  'org:sys:invitations:manage': {
    label: 'Manage invitations',
    description: 'Invite people by email and withdraw invitations.',
  },
  'org:sys:domains:manage': {
    label: 'Manage domains',
    description: 'Add and verify the organization’s email domains.',
  },
}

/**
 * Tula's own words for one of its system permissions.
 *
 * @param key - A permission key.
 * @returns The label and description of a system permission; `null` for any other key,
 *   which is the operator's own and has no words but the key.
 */
export function systemPermissionWords(key: string): { label: string; description: string } | null {
  return isSystemPermission(key) ? SYSTEM_WORDS[key] : null
}

/**
 * What a role is called in a sentence: its key, written out so that all of it is seen.
 *
 * @param key - A role key from the server.
 * @returns The key as shown.
 */
export function roleKeyLabel(key: string): string {
  return printable(key)
}

/**
 * The kind of a role in words.
 *
 * @param key - A role key.
 * @returns `Built in` for `admin` and `member`; `Custom` for any other.
 */
export function roleKind(key: string): 'Built in' | 'Custom' {
  return isBuiltInRoleKey(key) ? 'Built in' : 'Custom'
}

/**
 * The question asked before a role gains permissions.
 *
 * @param added - The permission keys the role did not hold.
 * @returns The sentences of the confirmation, one for the effect and one per permission.
 */
export function roleGainSentences(added: readonly string[]): string[] {
  const names = added.map((key) => systemPermissionWords(key)?.label ?? printable(key))
  return [
    `Every member who holds this role gains ${names.length === 1 ? 'a permission' : `${names.length} permissions`} at their next refresh, within the access token’s lifetime, in every organization: ${names.join(', ')}.`,
    'An application that reads these permissions from the token starts allowing them as soon as that token is issued.',
  ]
}

const INVITATION_STATUS: Record<string, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  declined: 'Declined',
  revoked: 'Withdrawn',
  expired: 'Expired',
}

/**
 * An invitation's state in words.
 *
 * @param status - The server's status.
 * @returns The label; the status written out for one this version does not know.
 */
export function invitationStatusLabel(status: string): string {
  return own(INVITATION_STATUS, status) ?? printable(status)
}

/**
 * Derive a slug from an organization's name while the operator has not typed one.
 *
 * @param name - The name as typed.
 * @returns Lower-case letters and digits joined by single hyphens; empty when the name has
 *   none. The contract's schema still decides whether the result is acceptable.
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}
