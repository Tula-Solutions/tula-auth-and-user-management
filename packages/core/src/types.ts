import type { Schemas } from './generated/api.gen'

/**
 * The next step of a sign-up, sign-in or password reset, decided by the server and
 * discriminated by `status`. Draw one screen per status; the SDK holds no flow logic.
 *
 * @example
 * ```ts
 * if (flow.step.status === 'needs_email_verification') {
 *   showCodeForm(flow.step.destination)
 * }
 * ```
 */
export type FlowStep = Schemas['FlowStep']

/**
 * Whether a flow signs a user in, creates one, or resets a password.
 *
 * @example
 * ```ts
 * const kind: FlowKind = flow.kind // 'sign_in' | 'sign_up' | 'password_reset'
 * ```
 */
export type FlowKind = Schemas['FlowKind']

/**
 * A way to prove who you are as the first step of a sign-in.
 *
 * @example
 * ```ts
 * if (flow.step.status === 'needs_first_factor' && flow.step.strategies.includes('password')) {
 *   showPasswordForm()
 * }
 * ```
 */
export type FirstFactorStrategy = Schemas['FirstFactorStrategy']

/**
 * A second-factor method a `needs_second_factor` step can ask for.
 *
 * @example
 * ```ts
 * if (flow.step.status === 'needs_second_factor') {
 *   const methods: SecondFactorMethod[] = flow.step.options
 * }
 * ```
 */
export type SecondFactorMethod = Schemas['SecondFactorMethod']

/**
 * The signed-in user. Never contains credentials.
 *
 * @example
 * ```ts
 * const user: User = await tula.user.get()
 * ```
 */
export type User = Schemas['CurrentUser']

/**
 * One of the signed-in user's devices. `current` marks the one making the request.
 *
 * @example
 * ```ts
 * const sessions: Session[] = await tula.session.list()
 * ```
 */
export type Session = Schemas['Session']

/**
 * What a client needs to draw a sign-in screen: the app's name, the enabled sign-in methods and
 * the password policy.
 *
 * @example
 * ```ts
 * const config: ClientConfig = await tula.config.get()
 * ```
 */
export type ClientConfig = Schemas['ClientConfig']

/**
 * The environment's password rules. Pass it to `evaluatePassword` for a live checklist that
 * agrees with the server.
 *
 * @example
 * ```ts
 * const { password } = await tula.config.get()
 * evaluatePassword(password, 'correct horse battery staple').ok
 * ```
 */
export type PasswordPolicy = Schemas['PasswordPolicy']

/**
 * The kind of client, which decides where the refresh token lives: `web` keeps it in an
 * httpOnly cookie the SDK never sees; the others hold it in the `storage` adapter.
 *
 * @example
 * ```ts
 * createTulaClient({ publishableKey, baseUrl, client: 'server' })
 * ```
 */
export type ClientKind = Schemas['SessionClient']

/**
 * The client's authentication state: small, immutable and serialisable.
 *
 * - `loading`: not known yet. Call `load()` (or `session.getToken()`) to find out.
 * - `signed-out`: nobody is signed in.
 * - `signed-in`: a session exists. `user` is `null` only until it has been fetched, or if
 *   fetching it failed; `user.get()` fetches it again. `organizationId` is the organization
 *   the session acts in (ADR 0065), `null` for the personal account. For a session with an
 *   access token it is read from the token's `org_id` claim (unverified: for showing, never
 *   for authorizing) and so follows every refresh; a browser's `stateful` session has no
 *   token, so it is known after `organizations.list()` or `organizations.setActive()`.
 *
 * @example
 * ```ts
 * tula.onChange((state: AuthState) => {
 *   if (state.status === 'signed-in') {
 *     greet(state.user?.firstName)
 *   }
 * })
 * ```
 */
export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | {
      readonly status: 'signed-in'
      readonly sessionId: string
      readonly user: User | null
      readonly organizationId: string | null
    }

/**
 * A `fetch` the client sends every request through. The global `fetch` fits; so does a
 * function that hands the `Request` to an in-process server.
 *
 * @example
 * ```ts
 * createTulaClient({ publishableKey, baseUrl, fetch: (request) => app.request(request) })
 * ```
 */
export type FetchLike = (request: Request) => Promise<Response>

/**
 * Whether the environment offers two-step verification: `off` (hide it), `optional` (a user
 * may turn it on) or `required` (everyone enrols, at sign-in if they have not).
 *
 * @example
 * ```ts
 * const policy: MfaPolicy = (await tula.config.get()).mfa?.policy ?? 'off'
 * ```
 */
export type MfaPolicy = Schemas['MfaPolicy']

/**
 * What a `needs_factor_enrolment` step lets the user enrol.
 *
 * @example
 * ```ts
 * if (flow.step.status === 'needs_factor_enrolment') {
 *   const methods: FactorEnrolmentMethod[] = flow.step.methods // ['totp']
 * }
 * ```
 */
export type FactorEnrolmentMethod = Schemas['FactorEnrolmentMethod']

/**
 * What the signed-in user has enrolled as a second factor. Never contains a secret.
 *
 * @example
 * ```ts
 * const factors: Factors = await tula.mfa.get()
 * factors.totp.enabled // true once an authenticator app was confirmed
 * factors.backupCodes.remaining // unused backup codes
 * ```
 */
export type Factors = Schemas['Factors']

/**
 * A started authenticator enrolment: the Base32 `secret` for typing by hand and the same
 * secret as an `otpauth://` `uri` for a QR code. Both are secrets, returned once: show them
 * and keep them nowhere. The client keeps no copy.
 *
 * @example
 * ```ts
 * const { secret, uri }: TotpEnrolment = await tula.mfa.startTotp()
 * drawQrCode(uri)
 * ```
 */
export type TotpEnrolment = Schemas['TotpEnrolment']

/**
 * A passkey of the signed-in user: its name, whether the authenticator reports it as synced
 * to the user's other devices, when it was added and when it was last used. Never key material.
 *
 * @example
 * ```ts
 * const [passkey]: Passkey[] = await tula.user.passkeys.list()
 * label.textContent = passkey.synced ? `${passkey.name} (synced)` : passkey.name
 * ```
 */
export type Passkey = Schemas['Passkey']

/**
 * A fresh set of backup codes, returned once. The client keeps no copy: show them to the user
 * and let them go.
 *
 * @example
 * ```ts
 * const { codes }: BackupCodes = await tula.mfa.regenerateBackupCodes()
 * ```
 */
export type BackupCodes = Schemas['BackupCodes']

/**
 * The proof of a second factor: the 6-digit code an authenticator app shows now, or an unused
 * backup code.
 *
 * @example
 * ```ts
 * const proof: SecondFactorProof = { method: 'totp', code: '123456' }
 * await flow.submitSecondFactor(proof)
 * ```
 */
export type SecondFactorProof = Schemas['SecondFactorRequest']

/**
 * The proof of a step-up: for a user without two-step verification their password or a code
 * emailed with `session.prepareStepUp`, otherwise an authenticator code or a backup code.
 *
 * @example
 * ```ts
 * const proof: StepUpProof = { method: 'totp', code: '123456' }
 * await tula.session.stepUp(proof)
 * ```
 */
export type StepUpProof = Schemas['StepUpRequest']

/**
 * The receipt of an emailed or a texted step-up code: where it went (masked) and when it stops
 * working. Never the code.
 *
 * @example
 * ```ts
 * const sent: StepUpPrepared = await tula.session.prepareStepUp({ method: 'email_code' })
 * show(`We emailed a code to ${sent.destination}`)
 * ```
 */
export type StepUpPrepared = Schemas['StepUpEmailCode'] | Schemas['SmsFactorCode']

/**
 * The receipt of the code texted to enrol a texted code as the second step: the masked number
 * and when the code stops working. Never the code.
 *
 * @example
 * ```ts
 * const sent: SmsFactorCode = await tula.mfa.startSms()
 * show(`We texted a code to ${sent.destination}`)
 * ```
 */
export type SmsFactorCode = Schemas['SmsFactorCode']

/**
 * The receipt of a code texted to a phone number: where it went (masked) and when it stops
 * working. Never the code, and never the whole number.
 *
 * @example
 * ```ts
 * const sent: PhoneCodeSent = await tula.user.phone.request({ phoneNumber: '+14155550142' })
 * show(`We texted a code to the number ending ${sent.destination.slice(-2)}`)
 * ```
 */
export type PhoneCodeSent = Schemas['PhoneCodeSent']

/**
 * The receipt of a code emailed to an address a user wants on their account: where it went
 * (masked) and when it stops working. Never the code, and never the whole address.
 *
 * @example
 * ```ts
 * const sent: EmailCodeSent = await tula.user.email.request({ email: 'ada@example.com' })
 * show(`We emailed a code to ${sent.destination}`)
 * ```
 */
export type EmailCodeSent = Schemas['EmailCodeSent']

/**
 * A way to step up. An `auth.step_up_required` error says which ones the user may use; see
 * `stepUpMethods`.
 *
 * @example
 * ```ts
 * const methods: StepUpMethod[] = stepUpMethods(error) // ['totp', 'backup_code']
 * ```
 */
export type StepUpMethod = StepUpProof['method']

/**
 * An organization the signed-in user belongs to, with their role in it and its permission
 * keys (ADR 0065).
 *
 * @example
 * ```ts
 * const { data } = await tula.organizations.list()
 * const admin = data.find((org) => org.role === 'admin')
 * ```
 */
export type UserOrganization = Schemas['UserOrganization']

/** A page of the user's organizations, with the session's active organization's id. */
export type UserOrganizationList = Schemas['UserOrganizationList']

/** An organization the user may join because of a verified address (`organizations.suggestions()`). */
export type OrganizationSuggestion = Schemas['OrganizationSuggestion']

/** What `organizations.suggestions()` answers: the organizations the user is offered. */
export type OrganizationSuggestionList = Schemas['OrganizationSuggestionList']
/**
 * An invitation to an organization as the inviting side sees it. The token the emailed link
 * carries is never part of it.
 *
 * @example
 * ```ts
 * const { data } = await tula.organizations.invitations.list(org.id)
 * const open = data.filter((invitation) => invitation.status === 'pending')
 * ```
 */
export type OrganizationInvitation = Schemas['OrganizationInvitation']

/** A page of an organization's invitations. */
export type OrganizationInvitationList = Schemas['OrganizationInvitationList']

/** The body of `organizations.invitations.invite()`: the address, a role's key and the page the link leads to. */
export type CreateOrganizationInvitationInput = Schemas['CreateOrganizationInvitationRequest']

/** What the holder of an invitation's token may see before signing in. */
export type InvitationPreview = Schemas['InvitationPreview']

/** What accepting an invitation answers: the organization joined, with the role and its permissions. */
export type AcceptedInvitation = Schemas['AcceptedInvitation']

/**
 * A member of an organization as another member sees them: the user's id, name and address
 * (each `null` when they have none) and the key of their role.
 *
 * @example
 * ```ts
 * const { data } = await tula.organizations.members.list(org.id)
 * const admins = data.filter((member) => member.role === 'admin')
 * ```
 */
export type OrganizationMember = Schemas['OrganizationMember']

/** A page of an organization's members. */
export type OrganizationMemberList = Schemas['OrganizationMemberList']

/** A role the signed-in member may give: its key and its name. */
export type AssignableRole = Schemas['AssignableRole']

/** What `organizations.roles()` answers: the roles the member may offer. */
export type AssignableRoleList = Schemas['AssignableRoleList']

/** The body of `organizations.update()`: a new name, a new slug, or both. */
export type UpdateOrganizationInput = Schemas['UpdateOrganizationRequest']

/** A domain an organization claimed, pending a code or verified. */
export type OrganizationDomain = Schemas['OrganizationDomain']

/** An organization's domains. */
export type OrganizationDomainList = Schemas['OrganizationDomainList']

/** The body of `organizations.domains.start()`: the domain, an address on it and the mode. */
export type StartOrganizationDomainInput = Schemas['StartOrganizationDomainRequest']

/** What `organizations.setActive()` answers: the session's active organization now. */
export type ActiveOrganization = Schemas['ActiveOrganization']

/** The body of `organizations.create()`: a name and a slug (lower-case letters, digits, hyphens). */
export type CreateOrganizationInput = Schemas['CreateOrganizationRequest']
