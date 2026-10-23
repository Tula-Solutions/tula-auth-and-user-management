// The grammar of an organization's permissions and roles (ADR 0065), with no dependency:
// the entry point an SDK loads at run time for `has({ permission })` and a form validates a
// role with, without pulling Zod into an application's bundle. The Zod schemas of a role's
// requests are in `./organization`, built from these.

/**
 * How many permissions one role can hold. The permissions of the active organization's role are
 * a claim of every access token (ADR 0065, "Token claims"), so the number is capped.
 */
export const MAX_PERMISSIONS_PER_ROLE = 32

/** How many custom roles an environment can define, beside the built-in ones. */
export const MAX_CUSTOM_ROLES = 50

/** The longest a permission key can be, in characters. */
export const MAX_PERMISSION_KEY_LENGTH = 100

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
 * The pattern is the grammar alone. Whether a role may hold a key is
 * {@link rolePermissionRefusal}.
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
 * removed or moved to a role without it (`organization.last_manager`), and a role's
 * permissions cannot be changed so that an organization would be left with none.
 */
export const MEMBERSHIPS_MANAGE_PERMISSION: SystemPermission = 'org:sys:memberships:manage'

/**
 * The permission that lets a member claim, verify, change and remove the organization's
 * domains through the client routes (ADR 0065, "Verified domains"). Read from the member's
 * role at the time of the request, never from a token.
 */
export const DOMAINS_MANAGE_PERMISSION: SystemPermission = 'org:sys:domains:manage'

/**
 * The permission that lets a member invite people to the organization and withdraw
 * invitations (ADR 0065, Orgs 04). Checked on the server from the membership as it is now,
 * never from a token's claims alone.
 */
export const INVITATIONS_MANAGE_PERMISSION: SystemPermission = 'org:sys:invitations:manage'

/**
 * The permission that lets a member rename the organization through the client routes
 * (ADR 0065, Orgs 07). Read from the membership now, never from a token's claims alone.
 */
export const ORGANIZATION_MANAGE_PERMISSION: SystemPermission = 'org:sys:organization:manage'

/**
 * The permission that lets a member delete the organization through the client routes (ADR
 * 0065, Orgs 07). Read from the membership now, never from a token's claims alone.
 */
export const ORGANIZATION_DELETE_PERMISSION: SystemPermission = 'org:sys:organization:delete'

/**
 * The permission that lets a member read the organization's member list through the client
 * routes (ADR 0065, Orgs 07). `org:sys:memberships:manage` also reads it.
 */
export const MEMBERSHIPS_READ_PERMISSION: SystemPermission = 'org:sys:memberships:read'

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

/**
 * Whether a string is one of {@link SYSTEM_PERMISSIONS}.
 *
 * @param key - A permission key.
 * @returns `true` for one of Tula's own permissions.
 *
 * @example
 * ```ts
 * isSystemPermission('org:sys:memberships:read') // true
 * isSystemPermission('org:billing:read') // false
 * ```
 */
export function isSystemPermission(key: string): key is SystemPermission {
  return (SYSTEM_PERMISSIONS as readonly string[]).includes(key)
}

/**
 * Whether a string is the key of a built-in role (`admin`, `member`). A custom role never
 * takes one of these keys.
 *
 * @param key - A role key.
 * @returns `true` for a built-in role's key.
 *
 * @example
 * ```ts
 * isBuiltInRoleKey('admin') // true
 * isBuiltInRoleKey('billing_manager') // false
 * ```
 */
export function isBuiltInRoleKey(key: string): boolean {
  return BUILT_IN_ROLES.some((role) => role.key === key)
}

/** Why a custom role may not hold a permission key. */
export type RolePermissionRefusal = 'grammar' | 'reserved'

/**
 * Whether a **custom** role may hold a permission key (ADR 0065, "Permissions").
 *
 * A custom role holds the operator's own permissions (`org:billing:read`) and may also hold
 * any of Tula's {@link SYSTEM_PERMISSIONS}, so that a role such as `owner` can manage members.
 * It can never hold a key of the reserved `sys` feature that is not on that list: a key Tula
 * does not check would mean nothing today and silently grant a privilege tomorrow, when a
 * later version gives that key a meaning.
 *
 * @param key - A permission key.
 * @returns `null` when the role may hold it, `'grammar'` when it is not a permission key at
 *   all, `'reserved'` when it is a `sys` key Tula does not define.
 *
 * @example
 * ```ts
 * rolePermissionRefusal('org:billing:read') // null
 * rolePermissionRefusal('org:sys:memberships:manage') // null
 * rolePermissionRefusal('org:sys:billing:read') // 'reserved'
 * rolePermissionRefusal('billing.read') // 'grammar'
 * ```
 */
export function rolePermissionRefusal(key: string): RolePermissionRefusal | null {
  if (key.length > MAX_PERMISSION_KEY_LENGTH || !PERMISSION_KEY_PATTERN.test(key)) {
    return 'grammar'
  }
  return key.startsWith('org:sys:') && !isSystemPermission(key) ? 'reserved' : null
}

/**
 * The permissions of a role as a set: each key once, sorted. How a role is stored, compared
 * and returned, so that the order a caller listed them in is never a difference.
 *
 * @param permissions - Permission keys, in any order, possibly with repeats.
 * @returns The distinct keys, sorted.
 *
 * @example
 * ```ts
 * normalizePermissions(['org:b:read', 'org:a:read', 'org:b:read']) // ['org:a:read', 'org:b:read']
 * ```
 */
export function normalizePermissions(permissions: readonly string[]): string[] {
  return [...new Set(permissions)].sort()
}

/**
 * What a change to a custom role's permissions widens, the one rule the server records
 * `weakened` with, `tula apply` asks `--allow-weaker` with and the dashboard asks first with.
 *
 * **Adding a permission to a role is a weakening** (members who hold the role gain access at
 * their next refresh); taking one away is not. **Creating a role is not one**: no member holds
 * it until someone assigns it, and that assignment is a membership change of its own. Deleting
 * a role is not one: only a role no member holds can be deleted.
 *
 * @param before - The permissions the role has, or `null` for a role that does not exist yet.
 * @param after - The permissions it would have.
 * @returns `['permissions']` when `after` holds a key `before` does not, otherwise `[]`.
 *
 * @example
 * ```ts
 * organizationRoleWeakenings(['org:billing:read'], ['org:billing:read', 'org:billing:write'])
 * // ['permissions']
 * organizationRoleWeakenings(['org:billing:read'], []) // []
 * organizationRoleWeakenings(null, ['org:billing:read']) // []
 * ```
 */
export function organizationRoleWeakenings(
  before: readonly string[] | null,
  after: readonly string[]
): 'permissions'[] {
  if (before === null) {
    return []
  }
  const had = new Set(before)
  return after.some((key) => !had.has(key)) ? ['permissions'] : []
}
