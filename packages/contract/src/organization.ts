import { z } from 'zod'
import {
  MAX_PERMISSION_KEY_LENGTH,
  MAX_PERMISSIONS_PER_ROLE,
  PERMISSION_KEY_PATTERN,
  ROLE_KEY_PATTERN,
  rolePermissionRefusal,
} from './organization-permissions'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PaginationMetaSchema } from './user'

// Organizations (ADR 0065): the companies, teams and workspaces an operator's users belong to.
// An organization is a tenant row of an environment; a user holds one role in each
// organization they belong to; a role is a set of permission keys. Everything an app or a
// Tula route asks about access is a permission key, so the grammar of a key, the system
// permissions and the two built-in roles are defined once, in `./organization-permissions`
// (no Zod there), for the API, the dashboard, `@tula-tech/config` and the SDKs; this module is
// the schemas built from them.

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

/** The key of a role: see {@link ROLE_KEY_PATTERN}. */
export const RoleKeySchema = z
  .string()
  .regex(ROLE_KEY_PATTERN, 'a role key is lower-case letters, digits and underscores')
  .meta({ ref: 'OrganizationRoleKey' })

/** A permission key: see {@link PERMISSION_KEY_PATTERN}. */
export const PermissionKeySchema = z
  .string()
  .max(MAX_PERMISSION_KEY_LENGTH)
  .regex(PERMISSION_KEY_PATTERN, 'a permission key is org:<feature>:<action>')
  .meta({ ref: 'PermissionKey' })

/**
 * The permissions a **custom** role holds: at most {@link MAX_PERMISSIONS_PER_ROLE} keys, each
 * of the grammar, none twice, and none of the reserved `sys` feature that Tula does not define
 * (`rolePermissionRefusal`, ADR 0065). A role may hold any of Tula's own system permissions.
 */
export const RolePermissionsSchema = z
  .array(z.string())
  .max(MAX_PERMISSIONS_PER_ROLE)
  .superRefine((permissions, context) => {
    const seen = new Set<string>()
    permissions.forEach((key, index) => {
      const refusal = rolePermissionRefusal(key)
      if (refusal === 'grammar') {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'a permission key is org:<feature>:<action>',
        })
      } else if (refusal === 'reserved') {
        context.addIssue({
          code: 'custom',
          path: [index],
          message:
            'the feature sys is reserved: only the system permissions Tula defines are allowed',
        })
      }
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: [index], message: 'a permission is listed once' })
      }
      seen.add(key)
    })
  })
  .meta({ ref: 'OrganizationRolePermissions' })

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

/**
 * The query of the administrator's list of organizations: a page, and an optional search.
 *
 * `q` is matched against the start of the name (ignoring case) and of the slug; a blank one
 * is no search. It is bounded to the longest name an organization can have.
 */
export const OrganizationSearchQuerySchema = OrganizationPageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
}).meta({ ref: 'OrganizationSearchQuery' })

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

/**
 * A member of an organization as another member sees them (ADR 0065, Orgs 07): who they are
 * and the key of their role. The name and the address are shown so that a member list can be
 * read at all; they go to members whose role holds `org:sys:memberships:read` or `:manage` and
 * to nobody else, and never into an event or an audit entry.
 */
export const OrganizationMemberSchema = z
  .object({
    userId: z.string(),
    /** First and last name as the user gave them, or `null` when they gave neither. */
    name: z.string().nullable(),
    /** The user's address as typed, or `null` for an account that has none. */
    email: z.string().nullable(),
    /** The key of the member's role. */
    role: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'OrganizationMember' })

/** One page of an organization's members, oldest first, as a member sees them. */
export const OrganizationMemberListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(OrganizationMemberSchema) })
  .meta({ ref: 'OrganizationMemberList' })

/** A role a member may give to someone: its key and its name, never its permissions. */
export const AssignableRoleSchema = z
  .object({ key: z.string(), name: z.string() })
  .meta({ ref: 'AssignableRole' })

/**
 * The roles the signed-in member may offer (to an invitation, or to a member): those whose
 * permissions they hold themselves. Built-in roles first, then the custom ones by key.
 */
export const AssignableRoleListSchema = z
  .object({ data: z.array(AssignableRoleSchema) })
  .meta({ ref: 'AssignableRoleList' })

/** A member of an organization, as another member sees them. */
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>
/** A page of members. */
export type OrganizationMemberList = z.infer<typeof OrganizationMemberListSchema>
/** A role a member may give to someone. */
export type AssignableRole = z.infer<typeof AssignableRoleSchema>
/** The roles a member may give. */
export type AssignableRoleList = z.infer<typeof AssignableRoleListSchema>

/**
 * One organization a user belongs to, as an administrator reads it on the user's page: the
 * organization, the key of the user's role in it and when they joined. No permission list and
 * no session: those are the user's own view (`UserOrganization`).
 */
export const UserMembershipSchema = z
  .object({
    organizationId: z.string(),
    name: z.string(),
    slug: z.string(),
    /** The key of the user's role in it. */
    role: z.string(),
    joinedAt: z.iso.datetime(),
  })
  .meta({ ref: 'UserMembership' })

/** One page of a user's memberships, the one they joined first at the top. */
export const UserMembershipListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(UserMembershipSchema) })
  .meta({ ref: 'UserMembershipList' })

/** A user's membership of an organization, with the organization's name. */
export type UserMembership = z.infer<typeof UserMembershipSchema>
/** A page of a user's memberships. */
export type UserMembershipList = z.infer<typeof UserMembershipListSchema>

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

/** The name of a role, as people read it (`Billing manager`). */
export const RoleNameSchema = OrganizationName

/**
 * A role as the admin API returns it. `version` counts the changes made to the role, from 1;
 * it is also the `ETag` of the role, and the value `If-Match` carries to change or delete it.
 */
export const OrganizationRoleSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    /** The permission keys, each once, sorted. */
    permissions: z.array(z.string()),
    /** `true` for `admin` and `member`: they cannot be changed or deleted. */
    builtIn: z.boolean(),
    version: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'OrganizationRole' })

/** The environment's roles: the two built-in ones first, then the custom ones by key. */
export const OrganizationRoleListSchema = z
  .object({ data: z.array(OrganizationRoleSchema) })
  .meta({ ref: 'OrganizationRoleList' })

/**
 * Define a custom role. The key is the role's identity and cannot be changed later; the keys
 * of the built-in roles are taken.
 */
export const CreateOrganizationRoleRequestSchema = z
  .strictObject({ key: RoleKeySchema, name: RoleNameSchema, permissions: RolePermissionsSchema })
  .meta({ ref: 'CreateOrganizationRoleRequest' })

/**
 * Rename a custom role or replace its permissions (the set given is the whole set). At least
 * one field.
 */
export const UpdateOrganizationRoleRequestSchema = z
  .strictObject({ name: RoleNameSchema.optional(), permissions: RolePermissionsSchema.optional() })
  .refine((body) => body.name !== undefined || body.permissions !== undefined, {
    message: 'send a name, permissions or both',
  })
  .meta({ ref: 'UpdateOrganizationRoleRequest' })

/** A role. */
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>
/** The list of roles. */
export type OrganizationRoleList = z.infer<typeof OrganizationRoleListSchema>
/** The body that defines a custom role. */
export type CreateOrganizationRoleRequest = z.infer<typeof CreateOrganizationRoleRequestSchema>
/** The body that changes a custom role. */
export type UpdateOrganizationRoleRequest = z.infer<typeof UpdateOrganizationRoleRequestSchema>

/**
 * The fields of a role an update can change, as `organization_role.updated` names them.
 * Names only: a value is never in an event.
 */
export const ORGANIZATION_ROLE_FIELDS = ['name', 'permissions'] as const

/** One of {@link ORGANIZATION_ROLE_FIELDS}. */
export type OrganizationRoleField = (typeof ORGANIZATION_ROLE_FIELDS)[number]
