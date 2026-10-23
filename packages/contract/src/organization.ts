import { z } from 'zod'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PaginationMetaSchema } from './user'

// Organizations (ADR 0065): the companies, teams and workspaces an operator's users belong to.
// An organization is a tenant row of an environment; a user holds one role in each
// organization they belong to; a role is a set of permission keys. Everything an app or a
// Tula route asks about access is a permission key, so the grammar of a key, the system
// permissions and the two built-in roles are defined once, here, for the API, the dashboard,
// `@tula-tech/config` and the SDKs.

/** Shortest organization slug. */
export const MIN_ORGANIZATION_SLUG_LENGTH = 2

/** Longest organization slug. */
export const MAX_ORGANIZATION_SLUG_LENGTH = 48

/** Longest organization name, in characters. */
export const MAX_ORGANIZATION_NAME_LENGTH = 100

/**
 * The grammar of an organization's slug: lower-case letters and digits in groups joined by
 * single hyphens (`acme`, `acme-corp-2`), at least {@link MIN_ORGANIZATION_SLUG_LENGTH} and at
 * most {@link MAX_ORGANIZATION_SLUG_LENGTH} characters. No leading, trailing or doubled hyphen,
 * no other character: a slug goes into URLs and is compared exactly. A slug is unique in its
 * environment.
 *
 * @example
 * ```ts
 * ORGANIZATION_SLUG_PATTERN.test('acme-corp') // true
 * ORGANIZATION_SLUG_PATTERN.test('Acme Corp') // false
 * ```
 */
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * How many permissions one role can hold. The permissions of the active organization's role are
 * a claim of every access token (ADR 0065, "Token claims"), so the number is capped.
 */
export const MAX_PERMISSIONS_PER_ROLE = 32

/** How many custom roles an environment can define, beside the built-in ones. */
export const MAX_CUSTOM_ROLES = 50

/**
 * The grammar of a role's key: a lower-case letter, then lower-case letters, digits and
 * underscores, up to 32 characters (`admin`, `billing_manager`). Unique in its environment.
 *
 * @example
 * ```ts
 * ROLE_KEY_PATTERN.test('billing_manager') // true
 * ```
 */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/**
 * The grammar of a permission key (ADR 0065): `org:<feature>:<action>`, each of the last two
 * a lower-case letter followed by lower-case letters, digits and underscores (at most 32
 * characters); or, for the permissions Tula's own routes check, `org:sys:<feature>:<action>`.
 * No dot, no other separator: a key is safe in a token and in a URL. The feature `sys` is
 * reserved: a custom key never has it, and a system key is one of
 * {@link SYSTEM_PERMISSIONS}.
 *
 * @example
 * ```ts
 * PERMISSION_KEY_PATTERN.test('org:billing:read') // true
 * PERMISSION_KEY_PATTERN.test('org:sys:memberships:manage') // true
 * PERMISSION_KEY_PATTERN.test('billing.read') // false
 * ```
 */
export const PERMISSION_KEY_PATTERN =
  /^org:(?:sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31}$/

/**
 * The permissions Tula's own organization routes check (ADR 0065). The same keys an app's
 * server checks with `has({ permission })`, so Tula's routes hold no privilege an app cannot
 * also give a role.
 */
export const SYSTEM_PERMISSIONS = [
  'org:sys:organization:manage',
  'org:sys:organization:delete',
  'org:sys:memberships:read',
  'org:sys:memberships:manage',
  'org:sys:invitations:manage',
  'org:sys:domains:manage',
] as const

/** One of {@link SYSTEM_PERMISSIONS}. */
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number]

/**
 * The permission that makes a member a manager of the organization's members. **Every
 * organization keeps at least one member who holds it**: the last such member cannot be
 * removed or moved to a role without it (`organization.last_manager`).
 */
export const MEMBERSHIPS_MANAGE_PERMISSION: SystemPermission = 'org:sys:memberships:manage'

/** A built-in role: its key, its name and the permissions it holds. */
export interface BuiltInRole {
  readonly key: string
  readonly name: string
  readonly permissions: readonly SystemPermission[]
}

/**
 * The two roles every environment has (ADR 0065): `admin` holds every system permission,
 * `member` may read the member list. They cannot be deleted, renamed or given other
 * permissions. They exist as rows of every environment (`ensureBuiltInRoles`) so that a
 * membership refers to a role the way it does to a custom one.
 */
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { key: 'admin', name: 'Admin', permissions: SYSTEM_PERMISSIONS },
  { key: 'member', name: 'Member', permissions: ['org:sys:memberships:read'] },
]

/** The key of a role: see {@link ROLE_KEY_PATTERN}. */
export const RoleKeySchema = z
  .string()
  .regex(ROLE_KEY_PATTERN, 'a role key is lower-case letters, digits and underscores')
  .meta({ ref: 'OrganizationRoleKey' })

/** A permission key: see {@link PERMISSION_KEY_PATTERN}. */
export const PermissionKeySchema = z
  .string()
  .max(100)
  .regex(PERMISSION_KEY_PATTERN, 'a permission key is org:<feature>:<action>')
  .meta({ ref: 'PermissionKey' })

/** An organization's slug: see {@link ORGANIZATION_SLUG_PATTERN}. */
export const OrganizationSlugSchema = z
  .string()
  .min(MIN_ORGANIZATION_SLUG_LENGTH)
  .max(MAX_ORGANIZATION_SLUG_LENGTH)
  .regex(ORGANIZATION_SLUG_PATTERN, 'a slug is lower-case letters and digits joined by hyphens')
  .meta({ ref: 'OrganizationSlug' })

// Operator or user text: trimmed, never empty, no control character (a name reaches emails and
// the dashboard as untrusted text, ADR 0065).
const OrganizationName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ORGANIZATION_NAME_LENGTH)
  .refine((name) => !Array.from(name).some((char) => isControl(char.codePointAt(0) ?? 0)), {
    message: 'must not contain control characters',
  })

/** Whether a code point is a C0 or C1 control character. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/** An organization, as the admin API returns it. */
export const OrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** The user who created it; `null` for one an administrator created. */
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'Organization' })

/** One page of organizations, newest first. */
export const OrganizationListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(OrganizationSchema) })
  .meta({ ref: 'OrganizationList' })

/** Create an organization from a server or the dashboard. */
export const CreateOrganizationRequestSchema = z
  .strictObject({ name: OrganizationName, slug: OrganizationSlugSchema })
  .meta({ ref: 'CreateOrganizationRequest' })

/** Rename an organization, or change its slug. At least one field. */
export const UpdateOrganizationRequestSchema = z
  .strictObject({ name: OrganizationName.optional(), slug: OrganizationSlugSchema.optional() })
  .refine((body) => body.name !== undefined || body.slug !== undefined, {
    message: 'send a name, a slug or both',
  })
  .meta({ ref: 'UpdateOrganizationRequest' })

/** The query of a list of organizations or of an organization's members. */
export const OrganizationPageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .meta({ ref: 'OrganizationPageQuery' })

/** A user's membership of an organization. */
export const OrganizationMembershipSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    userId: z.string(),
    /** The key of the member's role. */
    role: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'OrganizationMembership' })

/** One page of an organization's members, oldest first. */
export const OrganizationMembershipListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(OrganizationMembershipSchema) })
  .meta({ ref: 'OrganizationMembershipList' })

/** Add an existing user to an organization with a role. */
export const AddOrganizationMemberRequestSchema = z
  .strictObject({ userId: z.uuid(), role: RoleKeySchema })
  .meta({ ref: 'AddOrganizationMemberRequest' })

/** Change a member's role. */
export const UpdateOrganizationMemberRequestSchema = z
  .strictObject({ role: RoleKeySchema })
  .meta({ ref: 'UpdateOrganizationMemberRequest' })

/**
 * An organization the signed-in user belongs to, with their role in it (ADR 0065, Orgs 02).
 * What `GET /v1/client/me/organizations` lists and `POST` creates. No creator and no other
 * member: a user is told about their own membership and nothing of anyone else's.
 */
export const UserOrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** The key of the user's role in it. */
    role: z.string(),
    /** The permission keys of that role, as they are now. */
    permissions: z.array(z.string()),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'UserOrganization' })

/**
 * One page of the signed-in user's organizations, the one they joined first at the top. The
 * `activeOrganizationId` is the session's own: `null` for the personal account, and for an
 * organization the user is no longer a member of.
 */
export const UserOrganizationListSchema = z
  .object({
    activeOrganizationId: z.string().nullable(),
    meta: PaginationMetaSchema,
    data: z.array(UserOrganizationSchema),
  })
  .meta({ ref: 'UserOrganizationList' })

/**
 * Make an organization the session's active one, or clear it (`null`: the personal
 * account, where the environment allows one).
 */
export const SetActiveOrganizationRequestSchema = z
  .strictObject({ organizationId: z.uuid().nullable() })
  .meta({ ref: 'SetActiveOrganizationRequest' })

/**
 * The session after the active organization changed. A `hybrid` session gets a **new access
 * token** that already carries `org_id`, `org_role` and `org_perms` (or none of them, once
 * cleared); the refresh token is untouched. A `stateful` session gets no token: its next
 * request is read from the stored session.
 */
export const ActiveOrganizationSchema = z
  .object({
    sessionId: z.string(),
    /** The session's active organization now: `null` for the personal account. */
    organizationId: z.string().nullable(),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.iso.datetime().optional(),
  })
  .meta({ ref: 'ActiveOrganization' })

/** An organization. */
export type Organization = z.infer<typeof OrganizationSchema>
/** A page of organizations. */
export type OrganizationList = z.infer<typeof OrganizationListSchema>
/** The body that creates an organization. */
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>
/** The body that changes an organization. */
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>
/** A membership. */
export type OrganizationMembership = z.infer<typeof OrganizationMembershipSchema>
/** A page of memberships. */
export type OrganizationMembershipList = z.infer<typeof OrganizationMembershipListSchema>
/** The body that adds a member. */
export type AddOrganizationMemberRequest = z.infer<typeof AddOrganizationMemberRequestSchema>
/** The body that changes a member's role. */
export type UpdateOrganizationMemberRequest = z.infer<typeof UpdateOrganizationMemberRequestSchema>

/** An organization the signed-in user belongs to. */
export type UserOrganization = z.infer<typeof UserOrganizationSchema>
/** A page of the signed-in user's organizations. */
export type UserOrganizationList = z.infer<typeof UserOrganizationListSchema>
/** The body that sets or clears the active organization. */
export type SetActiveOrganizationRequest = z.infer<typeof SetActiveOrganizationRequestSchema>
/** The session after its active organization changed. */
export type ActiveOrganization = z.infer<typeof ActiveOrganizationSchema>

/**
 * The fields of an organization an update can change, as `organization.updated` names them.
 * Names only: a value is never in an event.
 */
export const ORGANIZATION_FIELDS = ['name', 'slug'] as const

/** One of {@link ORGANIZATION_FIELDS}. */
export type OrganizationField = (typeof ORGANIZATION_FIELDS)[number]
