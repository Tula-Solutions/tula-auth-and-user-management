package dev.tula.auth

import dev.tula.auth.generated.OAuthProvider
import dev.tula.auth.generated.OrganizationDomainMode

// The Kotlin samples of the documentation (docs/kotlin.md, docs/methods/*.md). Each
// `// #region name` … `// #endregion` block is copied into the pages by
// `bun run docs:generate`, and `bun run docs:check` fails when a page and this file differ.
//
// This file is compiled with the module's tests (`bun run native:kotlin:test`) and nothing
// in it is run: it shows that the calls the pages name exist with these arguments, not what
// they do. What they do is the unit tests' and the journeys' to show.

/** What an app does with what a call answered. The samples name these; they are the app's own. */
private object App {
    fun showSignIn() = Unit

    fun showApp(state: AuthState.SignedIn) = check(state.sessionId.isNotEmpty())

    fun proceed(flow: SignInFlow) = check(flow.screen != FlowScreen.NOT_SUPPORTED)

    fun explain(refusal: ProviderRefusal) = check(refusal !is ProviderRefusal.NoAnswer)

    fun callBackend(token: String?) = check(token != "")

    fun show(codes: List<String>) = check(codes.isNotEmpty())
}

@Suppress("unused")
internal object DocsSnippets {
    suspend fun client(storage: TokenStorage): TulaClient {
        // #region client
        // `storage` is where the refresh token is kept: on Android,
        // KeystoreTokenStorage(applicationContext) from the module tula-auth-android.
        val tula = TulaClient(
            publishableKey = "tula_pk_…",
            baseUrl = "https://auth.example.com",
            storage = storage,
        )

        // Once, at start: restores the session the storage holds.
        when (val state = tula.load()) {
            AuthState.Loading -> Unit // the storage could not be read: not known yet
            AuthState.SignedOut -> App.showSignIn()
            is AuthState.SignedIn -> App.showApp(state)
        }
        // #endregion
        return tula
    }

    suspend fun session(tula: TulaClient) {
        // #region session
        val token = tula.session.getToken() // refreshed first when it is about to expire
        App.callBackend(token)
        tula.session.signOut() // throws when the server could not be told
        // #endregion
    }

    suspend fun password(tula: TulaClient, email: String, password: String, code: String, newPassword: String) {
        // #region password
        val signUp = tula.signUp(email = email, password = password)
        // The server emailed a code.
        signUp.verifyEmail(code) // COMPLETE: tula.state is SignedIn

        val signIn = tula.signIn(email)
        signIn.submitPassword(password)

        val reset = tula.resetPassword(email)
        reset.submit(code = code, password = newPassword)
        // #endregion
    }

    suspend fun signIn(tula: TulaClient, password: String, code: String, newPassword: String) {
        // #region sign-in
        val flow = tula.signIn("maya@example.com")
        when (flow.screen) {
            FlowScreen.NEEDS_PASSWORD -> flow.submitPassword(password)
            FlowScreen.NEEDS_FIRST_FACTOR -> {
                flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE) // sends the code
                flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, code)
            }
            FlowScreen.NEEDS_EMAIL_VERIFICATION -> flow.verifyEmail(code)
            FlowScreen.NEEDS_NEW_PASSWORD -> flow.submitNewPassword(newPassword)
            FlowScreen.NEEDS_SECOND_FACTOR -> flow.submitTotp(code)
            FlowScreen.NEEDS_FACTOR_ENROLMENT -> flow.startTotpEnrolment()
            FlowScreen.COMPLETE -> Unit // tula.state is SignedIn
            FlowScreen.NOT_SUPPORTED -> Unit // say so, in words
        }
        // #endregion
    }

    suspend fun changePassword(tula: TulaClient, current: String, newPassword: String) {
        // #region password-change
        tula.changePassword(currentPassword = current, newPassword = newPassword)
        // #endregion
    }

    suspend fun emailCode(tula: TulaClient, email: String, code: String) {
        // #region email-code
        val flow = tula.signIn(email)
        if (flow.screen == FlowScreen.NEEDS_FIRST_FACTOR) {
            flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE) // nothing is emailed until this is called
            flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, code)
        }
        // #endregion
    }

    suspend fun smsCode(tula: TulaClient, phoneNumber: String, code: String) {
        // #region sms-code
        val flow = tula.signIn(phoneNumber)
        if (flow.screen == FlowScreen.NEEDS_FIRST_FACTOR) {
            flow.prepareFirstFactor(CodeStrategy.SMS_CODE) // nothing is texted until this is called
            flow.attemptFirstFactor(CodeStrategy.SMS_CODE, code)
        }
        // #endregion
    }

    suspend fun secondStep(flow: SignInFlow, code: String) {
        // #region second-step
        flow.submitTotp(code) // the authenticator app's code
        flow.submitBackupCode(code) // .remaining says how many are left
        flow.submitSecondFactorWithPasskey() // shows the passkey sheet
        flow.prepareSmsCode() // nothing is texted until this is called
        flow.submitSmsCode(code)
        // #endregion
    }

    suspend fun stepUp(tula: TulaClient, password: String, code: String) {
        // #region step-up
        tula.stepUp.withPassword(password)
        tula.stepUp.withTotp(code) // or withBackupCode(code)
        tula.stepUp.withPasskey()
        tula.stepUp.sendEmailCode()
        tula.stepUp.withEmailCode(code)
        // #endregion
    }

    suspend fun enrolTotp(tula: TulaClient, code: String) {
        // #region totp-enrol
        try {
            tula.factors.startTotp() // the setup key, shown once
            App.show(tula.factors.confirmTotp(code)) // the backup codes, shown once too
        } catch (error: TulaError) {
            // `auth.step_up_required`: error.stepUpMethods says with what to step up first.
            check(error.stepUpMethods.isNotEmpty())
        }
        // #endregion
    }

    suspend fun passkey(tula: TulaClient) {
        // #region passkey
        when (val result = tula.signInWithPasskey()) {
            is TulaCeremony.Finished -> App.proceed(result.value) // a flow, usually COMPLETE
            TulaCeremony.Dismissed -> Unit // the user put the sheet away
        }
        tula.passkeys.add(name = "Pixel") // signed in, after a step-up
        // #endregion
    }

    suspend fun google(tula: TulaClient) {
        // #region google
        tula.signInWithGoogle() // TulaCeremony<SignInFlow>: starts, shows Google's sheet, exchanges
        // #endregion
    }

    suspend fun provider(tula: TulaClient) {
        // #region provider
        when (val outcome = tula.signIn(OAuthProvider.Github, redirectUrl = "https://app.example.com/oauth")) {
            is ProviderOutcome.SignedIn -> Unit
            is ProviderOutcome.NeedsStep -> App.proceed(outcome.flow) // the second step, usually
            ProviderOutcome.Cancelled -> Unit // the user closed the browser
            is ProviderOutcome.Refused -> App.explain(outcome.refusal) // why nothing was exchanged
            is ProviderOutcome.Linked -> Unit // only from tula.identities.link
        }
        // #endregion
    }

    suspend fun organizations(tula: TulaClient) {
        // #region organizations
        val page = tula.organizations.list() // each with the user's role and its permissions
        if (page.data.isEmpty()) {
            val acme = tula.organizations.create(name = "Acme", slug = "acme")
            tula.organizations.setActive(acme.id) // the next access token carries the claims
        }
        tula.organizations.active()?.let { organization ->
            // Read from the access token, to decide what to draw: your server checks the same keys.
            if (organization.hasPermission("org:billing:read")) {
                // show the billing tab
            }
            if (organization.hasRole("admin")) {
                // show the admin tab
            }
        }
        tula.organizations.clearActive() // back to the personal account
        // #endregion
    }

    suspend fun invitation(tula: TulaClient, openedWith: String) {
        // #region invitation
        // The app was opened by the link in the emailed invitation (an app link, say).
        val link = TulaInvitationLink.read(openedWith) ?: return
        // The token is a secret. It was in the address's fragment, which no server saw.
        val preview = tula.organizations.invitations.preview(link.token)
        // preview.organizationName, preview.role and preview.email, to prefill a sign-up.
        // Once the user is signed in as preview.email, with its address verified:
        val joined = tula.organizations.invitations.accept(link.token)
        tula.organizations.setActive(joined.id)
        // or: tula.organizations.invitations.decline(link.token)
        // #endregion
        check(preview.email.isNotEmpty())
    }

    suspend fun suggestions(tula: TulaClient) {
        // #region organization-suggestions
        // Organizations whose verified domain is the one of the user's verified address:
        val offered = tula.organizations.suggestions()
        offered.data.firstOrNull()?.let { first ->
            tula.organizations.join(first.id) // with the environment's default role
        }
        // #endregion
    }

    suspend fun organizationMembers(tula: TulaClient, organizationId: String) {
        // #region organization-members
        // The server decides from the role the user holds now, on every call.
        val members = tula.organizations.members.list(organizationId)
        val roles = tula.organizations.roles(organizationId) // the roles the user may give
        val first = members.data.firstOrNull()
        if (first != null && roles.data.any { it.key == "admin" }) {
            tula.organizations.members.changeRole(organizationId, first.userId, "admin")
        }
        tula.organizations.update(organizationId, name = "Acme Inc")
        tula.organizations.leave(organizationId) // refused for the last manager
        tula.organizations.remove(organizationId) // deletes it for good
        // #endregion
    }

    suspend fun organizationDomains(tula: TulaClient, organizationId: String, typed: String) {
        // #region organization-domains
        // Claim a domain: a code is emailed to an address on it.
        val claim = tula.organizations.domains.start(organizationId, "acme.com", "ada@acme.com", OrganizationDomainMode.Suggest)
        val proved = tula.organizations.domains.verify(organizationId, claim.id, typed)
        // proved.status is Verified until proved.expiresAt; later NeedsReverification.
        tula.organizations.domains.update(organizationId, proved.id, OrganizationDomainMode.AutoJoin)
        tula.organizations.domains.remove(organizationId, proved.id)
        // #endregion
    }
}
