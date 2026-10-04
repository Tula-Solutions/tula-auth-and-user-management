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
 *   fetching it failed; `user.get()` fetches it again.
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
  | { readonly status: 'signed-in'; readonly sessionId: string; readonly user: User | null }

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
 * The receipt of an emailed step-up code: where it went (masked) and when it stops working.
 * Never the code.
 *
 * @example
 * ```ts
 * const sent: StepUpPrepared = await tula.session.prepareStepUp({ method: 'email_code' })
 * show(`We emailed a code to ${sent.destination}`)
 * ```
 */
export type StepUpPrepared = Schemas['StepUpEmailCode']

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
