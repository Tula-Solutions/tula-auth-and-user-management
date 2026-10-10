import { EnvironmentSettingsSchema, settingsWeakenings } from '@tula/contract'
import { toApiError } from '~/api/errors'
import type { EnvironmentSettingsState } from '~/api/generated/api.gen'

/** An environment's settings document, as `GET /v1/admin/settings` answers it. */
export type SettingsDocument = EnvironmentSettingsState['settings']

/** What a save would do, decided before anything is sent. */
export interface SavePlan {
  /** Whether the draft differs from what was loaded. */
  dirty: boolean
  /** The paths that would get weaker, by the contract's `settingsWeakenings`. */
  weakenings: string[]
  /** The tool that manages these settings from a config file, if any. */
  managedBy: string | null
  /** Whether the operator must confirm before the save is sent. */
  needsConfirmation: boolean
}

/**
 * The `If-Match` value for a revision: the settings are replaced only if nobody else replaced
 * them since they were read.
 *
 * @param revision - The revision the draft was made from.
 * @returns The quoted entity tag.
 */
export function etag(revision: number): string {
  return `"${revision}"`
}

/**
 * Decide what saving a draft means: is there anything to save, does it weaken security, and
 * are the settings managed by a config file (so the change will be reported as drift).
 *
 * "Weakened" is the contract's one definition, shared with the server's audit entry and
 * `tula diff`. A draft the contract's schema cannot read lists none: the server refuses it
 * with field errors instead.
 *
 * @param original - The settings as loaded.
 * @param draft - The settings as edited.
 * @param managedBy - The loaded state's `managedBy`.
 * @returns The plan.
 */
export function planSave(
  original: SettingsDocument,
  draft: SettingsDocument,
  managedBy: { tool: string } | null
): SavePlan {
  const dirty = JSON.stringify(original) !== JSON.stringify(draft)
  const before = EnvironmentSettingsSchema.safeParse(original)
  const after = EnvironmentSettingsSchema.safeParse(draft)
  const weakenings =
    dirty && before.success && after.success ? settingsWeakenings(before.data, after.data) : []
  const tool = managedBy?.tool ?? null
  return {
    dirty,
    weakenings,
    managedBy: tool,
    needsConfirmation: dirty && (weakenings.length > 0 || tool !== null),
  }
}

/** The one weakening that destroys something when it is saved. */
const AUDIT_RETENTION = 'audit.retentionDays'

const WEAKENINGS: Record<string, string> = {
  [AUDIT_RETENTION]:
    'Audit entries older than the new period are deleted for good, starting with the next retention run',
  'password.minLength': 'Passwords may be shorter',
  'password.breachCheck': 'Breached passwords are checked less strictly',
  'password.requireLowercase': 'A lowercase letter is no longer required',
  'password.requireUppercase': 'An uppercase letter is no longer required',
  'password.requireNumber': 'A number is no longer required',
  'password.requireSpecial': 'A special character is no longer required',
  'password.minCharacterClasses': 'Fewer kinds of character are required',
  'password.disallowUserInfo': 'Passwords may contain the user’s own name or email',
  'password.disallowCommon': 'Common passwords are allowed',
  'password.blockSequences': 'Sequences such as “abcd” are allowed',
  'password.maxRepeatedChars': 'Longer runs of one character are allowed',
  'password.history': 'Fewer previous passwords are remembered',
  'notifications.passwordChanged': 'Users are no longer told when their password changes',
  'notifications.newSignIn': 'Users are no longer told about a sign-in from a new device',
  'notifications.mfaChanged': 'Users are no longer told when two-step verification changes',
  'notifications.identityChanged': 'Users are no longer told when a sign-in method is linked',
  'mfa.policy': 'Two-step verification is asked of fewer users',
  'mfa.smsCode':
    'The second step this environment requires may be a texted code: whoever receives the messages of a user’s number passes it. A text message cannot be taken back once it is sent',
  'sessions.maxPerUser': 'A user may have more sessions at once',
  'sms.dailyMessageLimit':
    'More text messages may be sent in a day. The limit is what a day can cost at most (in messages: your provider’s prices turn that into money), so abuse of this environment’s SMS can cost more, and a message that was sent cannot be un-sent',
  'signIn.methods.smsCode':
    'A texted code can sign people in: whoever receives the messages of a number an account has proven can enter that account, with no password and no inbox',
  'sms.allowedCountries':
    'Text messages go to the countries added, where a texted code signs people in or may be the second step this environment requires: accounts with phone numbers there can now be entered, or pass that step, by whoever receives their messages. More destinations can also be texted at your cost, and a message that was sent cannot be un-sent',
  'urls.allowedRedirectUrls':
    'A provider sign-in may be returned to a custom scheme (such as com.example.app:/oauth): any app on a device can claim one, so the app that receives the redirect may not be yours. An https link is handed to the app your domain’s association file names, which Tula builds and cannot check your domain serves',
}

/**
 * A weakening in the operator's words.
 *
 * @param path - A path from {@link SavePlan.weakenings}.
 * @returns A sentence for a path this version knows; the path itself otherwise.
 */
export function describeWeakening(path: string): string {
  const template = /^sessions\.profiles\.(.+)\.jwtTemplate$/.exec(path)
  if (template) {
    return `Sessions of the “${template[1]}” profile lose custom claims, or get different ones: an application that reads them may refuse those users`
  }
  const binding = /^sessions\.profiles\.(.+)\.deviceBinding$/.exec(path)
  if (binding) {
    return `Native apps that sign in under the “${binding[1]}” profile are asked less for a device key: a refresh token copied from a device can then be used elsewhere. Sessions that exist are not changed`
  }
  const profile = /^sessions\.profiles\.(.+)$/.exec(path)
  if (profile) {
    return `Sessions of the “${profile[1]}” profile last longer or are easier to get`
  }
  return WEAKENINGS[path] ?? path
}

/**
 * The question the editor asks before a save that needs a confirmation.
 *
 * A shorter audit retention period is said as what it is, a deletion that cannot be undone,
 * and not only as "weaker": the operator must not learn it from the list underneath.
 *
 * @param weakenings - The paths from {@link SavePlan.weakenings}.
 * @returns The dialog's title; with nothing weaker, the question about managed settings.
 */
export function confirmationTitle(weakenings: readonly string[]): string {
  if (weakenings.length === 0) {
    return 'Change settings managed by a config file?'
  }
  const deletes = weakenings.includes(AUDIT_RETENTION)
  if (deletes && weakenings.length === 1) {
    return 'This deletes older audit entries for good. Save anyway?'
  }
  return deletes
    ? 'This weakens security and deletes older audit entries for good. Save anyway?'
    : 'This weakens security. Save anyway?'
}

/**
 * What a failed save was.
 *
 * @param error - What the replace threw.
 * @returns `conflict` when the settings changed elsewhere (412), `invalid` when the document
 *   was refused with field errors, else `failed`.
 */
export function classifyFailure(error: unknown): 'conflict' | 'invalid' | 'failed' {
  const failure = toApiError(error)
  if (failure.status === 412 || failure.code === 'precondition.failed') {
    return 'conflict'
  }
  return failure.fieldErrors.length > 0 ? 'invalid' : 'failed'
}
