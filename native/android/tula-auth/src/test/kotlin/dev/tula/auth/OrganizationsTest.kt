package dev.tula.auth

import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val ACTIVE = "/v1/client/me/organizations/active"
private const val ME_ORGANIZATIONS = "/v1/client/me/organizations"
private const val REFRESH_PATH = "/v1/client/sessions/refresh"
private const val SIGN_OUT_PATH = "/v1/client/sessions/sign-out"

private fun b64(text: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray(Charsets.UTF_8))

/** The three organization claims as the API writes them into a token, each one replaceable. */
private fun orgClaims(
    id: String? = "org_1",
    role: String? = "admin",
    permissions: String? = """["org:billing:read","org:sys:memberships:read"]""",
): String = listOfNotNull(
    id?.let { """"org_id":"$it"""" },
    role?.let { """"org_role":"$it"""" },
    permissions?.let { """"org_perms":$it""" },
).joinToString(",")

/** An unsigned token of a JWT's shape that lives a minute and carries [claims] beside the usual ones. */
private fun orgJwt(label: String, claims: String = orgClaims()): String {
    val extra = if (claims.isEmpty()) "" else ",$claims"
    return b64("""{"alg":"none"}""") + "." +
        b64("""{"iat":1760000000,"exp":1760000060,"jti":"$label"$extra}""") + ".signature-$label"
}

private fun activeJson(
    organizationId: String?,
    token: String?,
    sessionId: String = "session-1",
    refreshToken: String? = null,
): String {
    val org = if (organizationId == null) "null" else "\"$organizationId\""
    val access = if (token == null) "" else ""","accessToken":"$token","accessTokenExpiresAt":"2026-01-01T00:01:00.000Z""""
    val refresh = if (refreshToken == null) "" else ""","refreshToken":"$refreshToken""""
    return """{"sessionId":"$sessionId","organizationId":$org$access$refresh}"""
}

private const val ORGANIZATION =
    """{"id":"org_1","name":"Acme","slug":"acme","role":"admin","permissions":["org:billing:read"],""" +
        """"createdAt":"2026-01-01T00:00:00.000Z"}"""

/** Organizations (TULA-121): the claims of a token, an invitation's link, the calls and the active organization. */
class OrganizationsTest {
    @Test
    fun `the three claims are read together, and a token that fails any rule has no active organization`() {
        val cases = mapOf(
            "valid" to (orgClaims() to true),
            "no claims at all" to ("" to false),
            "no id" to (orgClaims(id = null) to false),
            "no role" to (orgClaims(role = null) to false),
            "no permissions" to (orgClaims(permissions = null) to false),
            "an empty id" to (orgClaims(id = "") to false),
            "an id past 64 characters" to (orgClaims(id = "a".repeat(65)) to false),
            "an id with a slash" to (orgClaims(id = "a/b") to false),
            "a role with a capital" to (orgClaims(role = "Admin") to false),
            "a role past 32 characters" to (orgClaims(role = "a".repeat(33)) to false),
            "an id that is a number" to ("\"org_id\":5,\"org_role\":\"admin\",\"org_perms\":[]" to false),
            "permissions that are no list" to (orgClaims(permissions = "\"org:a:b\"") to false),
            "a permission that is no string" to (orgClaims(permissions = "[5]") to false),
            "a wildcard" to (orgClaims(permissions = """["org:billing:*"]""") to false),
            "a custom permission in the reserved feature" to (orgClaims(permissions = """["org:sys:read"]""") to false),
            "a system permission with a third part" to (orgClaims(permissions = """["org:sys:a:b:c"]""") to false),
            "a permission with a capital" to (orgClaims(permissions = """["org:Billing:read"]""") to false),
            "a permission with a lookalike letter" to (orgClaims(permissions = "[\"org:billing:rеad\"]") to false),
            "an action past 32 characters" to
                (orgClaims(permissions = """["org:${"a".repeat(32)}:${"b".repeat(33)}"]""") to false),
            "more than 32 permissions" to
                (orgClaims(permissions = (0..32).joinToString(",", "[", "]") { "\"org:a:p$it\"" }) to false),
        )
        for ((name, case) in cases) {
            val (claims, valid) = case
            val read = TulaOrganizationClaims.read(orgJwt("a", claims))
            assertEquals(valid, read != null, name)
        }
        assertNull(TulaOrganizationClaims.read(null))
        assertNull(TulaOrganizationClaims.read("not.a.jwt"))
        assertNull(TulaOrganizationClaims.read("x"))
        assertNull(TulaOrganizationClaims.read("a.b"))
    }

    @Test
    fun `the claims are held to their byte cap, with the contract's own numbers`() {
        // The contract's maximal claims (custom-claims.test.ts): a 36-character id, a role of 32
        // characters and 32 permissions of 73, which take 2,541 bytes inside the cap of 2,560.
        val feature = "f".repeat(31)
        val action = "a".repeat(31)
        val list = (0 until 32).joinToString(",", "[", "]") { "\"org:sys:$feature${it % 10}:$action${it % 10}\"" }
        val role = "r" + "o".repeat(31)
        val maximal = assertNotNull(
            TulaOrganizationClaims.read(orgJwt("a", orgClaims(id = "i".repeat(36), role = role, permissions = list))),
        )
        assertEquals(2541, maximal.bytes())
        assertTrue(maximal.bytes() <= TulaOrganizationClaims.MAX_BYTES)
        val small = assertNotNull(
            TulaOrganizationClaims.read(orgJwt("a", orgClaims(id = "o1", role = "member", permissions = "[]"))),
        )
        assertEquals(50, small.bytes())
        // An id the grammar allows can still push the claims over the cap: nothing is repaired,
        // the organization is simply not active.
        assertNull(
            TulaOrganizationClaims.read(orgJwt("a", orgClaims(id = "i".repeat(64), role = role, permissions = list))),
        )
    }

    @Test
    fun `a permission or a role is matched exactly, and an empty key matches nothing`() {
        val claims = assertNotNull(TulaOrganizationClaims.read(orgJwt("a")))
        assertEquals("org_1", claims.organizationId)
        assertEquals("admin", claims.role)
        assertTrue(claims.hasPermission("org:billing:read"))
        assertTrue(claims.hasPermission("org:sys:memberships:read"))
        assertFalse(claims.hasPermission("org:billing:*"))
        assertFalse(claims.hasPermission("org:billing:manage"))
        assertFalse(claims.hasPermission(""))
        assertTrue(claims.hasRole("admin"))
        assertFalse(claims.hasRole("member"))
        assertFalse(claims.hasRole(""))
        assertEquals(claims, TulaOrganizationClaims.read(orgJwt("b")))
        assertEquals("TulaOrganizationClaims", claims.toString())
    }

    @Test
    fun `an invitation link gives its token and the address without it`() {
        val cases = listOf(
            "https://app.example.com/join#tula_invitation=abc123" to ("abc123" to "https://app.example.com/join"),
            "https://app.example.com/join#tula_invitation=a%2Fb%2Bc" to ("a/b+c" to "https://app.example.com/join"),
            "https://app.example.com/join#tula_invitation=a+b" to ("a b" to "https://app.example.com/join"),
            "https://app.example.com/join#x=1&tula_invitation=tok&y=2" to
                ("tok" to "https://app.example.com/join#x=1&y=2"),
            // The first is the token, as URLSearchParams.get reads, and every one is dropped.
            "https://app.example.com/join#tula_invitation=one&tula_invitation=two" to
                ("one" to "https://app.example.com/join"),
            "myapp://join#tula_invitation=tok" to ("tok" to "myapp://join"),
            "https://app.example.com/join#%74ula_invitation=tok" to ("tok" to "https://app.example.com/join"),
        )
        for ((url, expected) in cases) {
            val link = assertNotNull(TulaInvitationLink.read(url), url)
            assertEquals(expected.first, link.token, url)
            assertEquals(expected.second, link.cleanUrl, url)
        }
        for (url in listOf(
            "https://app.example.com/join",
            "https://app.example.com/join#",
            "https://app.example.com/join#tula_invitation=",
            "https://app.example.com/join#tula_invitation",
            "https://app.example.com/join#tula_invitation=%zz",
            "https://app.example.com/join?tula_invitation=tok",
            "https://app.example.com/join#other=1",
        )) {
            assertNull(TulaInvitationLink.read(url), url)
        }
    }

    @Test
    fun `the token of an invitation link is never printed`() {
        val link = assertNotNull(TulaInvitationLink.read("https://app.example.com/join#tula_invitation=secret-token-value"))
        assertEquals("TulaInvitationLink", link.toString())
        assertFalse(link.toString().contains("secret-token-value"))
        assertFalse(link.cleanUrl.contains("secret-token-value"))
    }

    @Test
    fun `organizations are listed, created and joined with the access token, and what names no organization is refused`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("GET", ME_ORGANIZATIONS) {
            ok(
                """{"activeOrganizationId":"org_1","meta":{"totalCount":1,"totalPages":1,"page":1,"perPage":20},""" +
                    """"data":[$ORGANIZATION]}""",
            )
        }
        val page = bench.tula.organizations.list()
        assertEquals("org_1", page.activeOrganizationId)
        assertEquals(listOf("org:billing:read"), page.data.single().permissions)
        assertEquals("Bearer ${fakeJwt("first")}", bench.engine.sent(ME_ORGANIZATIONS).single().headers["authorization"])

        bench.engine.on("POST", ME_ORGANIZATIONS) { ok(ORGANIZATION) }
        val created = bench.tula.organizations.create(name = "Acme", slug = "acme")
        assertEquals("org_1", created.id)
        assertEquals("""{"name":"Acme","slug":"acme"}""", bench.engine.sent(ME_ORGANIZATIONS).last().body)

        bench.engine.on("GET", "$ME_ORGANIZATIONS/suggestions") {
            ok("""{"data":[{"id":"org_2","name":"Globex","slug":"globex"}]}""")
        }
        assertEquals("org_2", bench.tula.organizations.suggestions().data.single().id)
        bench.engine.on("POST", "$ME_ORGANIZATIONS/suggestions/org_2/join") { ok(ORGANIZATION) }
        assertEquals("org_1", bench.tula.organizations.join("org_2").id)
        assertNull(bench.engine.sent("$ME_ORGANIZATIONS/suggestions/org_2/join").single().body)

        // A 200 that names no organization is not an organization (a wrong base URL, a proxy's page).
        bench.engine.on("POST", ME_ORGANIZATIONS) { ok(ORGANIZATION.replace("\"org_1\"", "\"\"")) }
        assertEquals("response.invalid", caught { bench.tula.organizations.create(name = "Acme", slug = "acme") }.code)
        bench.engine.on("POST", "$ME_ORGANIZATIONS/suggestions/org_2/join") { ok("""{"unexpected":true}""") }
        assertEquals("response.invalid", caught { bench.tula.organizations.join("org_2") }.code)

        // The server's refusals reach the caller as their codes.
        bench.engine.on("GET", ME_ORGANIZATIONS) { answer(403, errorJson("organization.disabled", 403)) }
        assertEquals("organization.disabled", caught { bench.tula.organizations.list() }.code)
        bench.engine.on("POST", "$ME_ORGANIZATIONS/suggestions/org_2/join") {
            answer(409, errorJson("organization.suggestion_unavailable", 409))
        }
        assertEquals("organization.suggestion_unavailable", caught { bench.tula.organizations.join("org_2") }.code)
    }

    @Test
    fun `nobody signed in asks nothing, and an id that is no path segment sends nothing`() = runTest {
        val nobody = Bench()
        nobody.tula.load()
        assertEquals("auth.unauthenticated", caught { nobody.tula.organizations.list() }.code)
        assertEquals("auth.unauthenticated", caught { nobody.tula.organizations.setActive("org_1") }.code)
        assertEquals("auth.unauthenticated", caught { nobody.tula.organizations.suggestions() }.code)
        assertEquals("auth.unauthenticated", caught { nobody.tula.organizations.invitations.accept("tok") }.code)
        assertNull(nobody.tula.organizations.active())
        assertFalse(nobody.tula.organizations.hasPermission("org:billing:read"))
        assertTrue(nobody.engine.requests.isEmpty())

        val bench = Bench()
        bench.signIn()
        val before = bench.engine.requests.size
        for (id in listOf("", "..", "a/b")) {
            assertEquals("response.invalid", caught { bench.tula.organizations.join(id) }.code, id)
            assertEquals("response.invalid", caught { bench.tula.organizations.invitations.list(id) }.code, id)
            assertEquals("response.invalid", caught { bench.tula.organizations.invitations.revoke("org_1", id) }.code, id)
        }
        assertEquals(before, bench.engine.requests.size)
    }

    @Test
    fun `choosing an organization installs the access token that carries it and rotates nothing`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("PUT", ACTIVE) { ok(activeJson("org_1", orgJwt("chosen"))) }
        val refreshed = AtomicInteger()
        bench.engine.on("POST", REFRESH_PATH) { refreshed.incrementAndGet(); ok(tokensJson("refresh")) }
        assertNull(bench.tula.organizations.active())
        val storedBefore = bench.storage.get(TEST_STORAGE_KEY)

        val chosen = bench.tula.organizations.setActive("org_1")

        assertEquals("org_1", chosen.organizationId)
        assertEquals("""{"organizationId":"org_1"}""", bench.engine.sent(ACTIVE).single().body)
        assertEquals("Bearer ${fakeJwt("first")}", bench.engine.sent(ACTIVE).single().headers["authorization"])
        val claims = assertNotNull(bench.tula.organizations.active())
        assertEquals("org_1", claims.organizationId)
        assertTrue(bench.tula.organizations.hasPermission("org:billing:read"))
        assertTrue(bench.tula.organizations.hasRole("admin"))
        assertFalse(bench.tula.organizations.hasRole("member"))
        assertEquals(orgJwt("chosen"), bench.tula.session.getToken())
        assertEquals(0, refreshed.get(), "choosing asks for no refresh")
        assertEquals(storedBefore, bench.storage.get(TEST_STORAGE_KEY), "the refresh token is the one it was")

        // Back to the personal account: null on the wire, and the next token has no claims.
        bench.engine.on("PUT", ACTIVE) { ok(activeJson(null, orgJwt("personal", claims = ""))) }
        bench.tula.organizations.clearActive()
        assertEquals("""{"organizationId":null}""", bench.engine.sent(ACTIVE).last().body)
        assertNull(bench.tula.organizations.active())
        assertEquals(storedBefore, bench.storage.get(TEST_STORAGE_KEY))
    }

    @Test
    fun `a refresh token a server put in the answer is ignored`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("PUT", ACTIVE) { ok(activeJson("org_1", orgJwt("chosen"), refreshToken = "tula_rt_intruder")) }
        val storedBefore = bench.storage.get(TEST_STORAGE_KEY)
        bench.tula.organizations.setActive("org_1")
        assertEquals(storedBefore, bench.storage.get(TEST_STORAGE_KEY))
    }

    @Test
    fun `an answer that is not the choice that was asked for installs nothing`() = runTest {
        val bench = Bench()
        bench.signIn()
        val token = bench.tula.session.getToken()

        // Another organization than the one asked for.
        bench.engine.on("PUT", ACTIVE) { ok(activeJson("org_9", orgJwt("other", orgClaims(id = "org_9")))) }
        assertEquals("response.invalid", caught { bench.tula.organizations.setActive("org_1") }.code)
        // An organization chosen, none answered.
        bench.engine.on("PUT", ACTIVE) { ok(activeJson(null, orgJwt("none", claims = ""))) }
        assertEquals("response.invalid", caught { bench.tula.organizations.setActive("org_1") }.code)
        // A stateful session's answer has no access token, and is not a session for this client.
        bench.engine.on("PUT", ACTIVE) { ok(activeJson("org_1", null)) }
        assertEquals("response.invalid", caught { bench.tula.organizations.setActive("org_1") }.code)
        // An empty id is no organization.
        bench.engine.on("PUT", ACTIVE) { ok(activeJson("", orgJwt("empty", claims = ""))) }
        assertEquals("response.invalid", caught { bench.tula.organizations.setActive("") }.code)
        // Not an answer of the API at all.
        bench.engine.on("PUT", ACTIVE) { ok("""{"hello":"proxy"}""") }
        assertEquals("response.invalid", caught { bench.tula.organizations.setActive("org_1") }.code)

        assertEquals(token, bench.tula.session.getToken())
        assertTrue(bench.tula.state.value is AuthState.SignedIn)
    }

    @Test
    fun `a refusal is the server's code and leaves the session as it was`() = runTest {
        val bench = Bench()
        bench.signIn()
        val token = bench.tula.session.getToken()
        bench.engine.on("PUT", ACTIVE) { answer(403, errorJson("organization.not_a_member", 403)) }
        assertEquals("organization.not_a_member", caught { bench.tula.organizations.setActive("org_1") }.code)
        bench.engine.on("PUT", ACTIVE) { answer(409, errorJson("organization.personal_account_disabled", 409)) }
        assertEquals("organization.personal_account_disabled", caught { bench.tula.organizations.clearActive() }.code)
        assertEquals(token, bench.tula.session.getToken())
    }

    @Test
    fun `an answer about another session is not installed`() = runTest {
        val bench = Bench()
        bench.signIn()
        val token = bench.tula.session.getToken()
        bench.engine.on("PUT", ACTIVE) { ok(activeJson("org_1", orgJwt("chosen"), sessionId = "session-2")) }
        assertEquals("auth.unauthenticated", caught { bench.tula.organizations.setActive("org_1") }.code)
        assertEquals(token, bench.tula.session.getToken())
    }

    @Test
    fun `a session that ended while the choice was on its way is not signed in again by it`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", SIGN_OUT_PATH) { answer(204, "") }
        bench.engine.on("PUT", ACTIVE) {
            bench.tula.session.signOut()
            ok(activeJson("org_1", orgJwt("late")))
        }
        assertEquals("auth.unauthenticated", caught { bench.tula.organizations.setActive("org_1") }.code)
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
        assertNull(bench.tula.session.getToken())
    }

    @Test
    fun `a token replaced while the choice was on its way is not installed over, one refresh carries the choice`() = runTest {
        val bench = Bench()
        bench.signIn()
        val refreshed = AtomicInteger()
        bench.engine.on("POST", REFRESH_PATH) { ok(tokensJson("refresh-${refreshed.incrementAndGet()}")) }
        bench.engine.on("PUT", ACTIVE) {
            // The session is refreshed while the choice is in flight: the answer's token is older.
            bench.tula.session.refresh()
            ok(activeJson("org_1", orgJwt("older")))
        }
        bench.tula.organizations.setActive("org_1")
        assertEquals(2, refreshed.get(), "the one of the race, and the one that carries the choice")
        assertEquals(fakeJwt("refresh-2"), bench.tula.session.getToken())
    }

    @Test
    fun `an invitation is previewed without a session, and accepted and declined with one`() = runTest {
        val nobody = Bench()
        nobody.tula.load()
        nobody.engine.on("POST", "/v1/client/organization-invitations/preview") {
            ok("""{"organizationName":"Acme","role":"member","email":"new@example.com","expiresAt":"2026-01-08T00:00:00.000Z"}""")
        }
        val preview = nobody.tula.organizations.invitations.preview("the-token")
        assertEquals("Acme", preview.organizationName)
        val previewed = nobody.engine.sent("/v1/client/organization-invitations/preview").single()
        assertEquals("""{"token":"the-token"}""", previewed.body)
        assertNull(previewed.headers["authorization"])
        assertEquals(TEST_KEY, previewed.headers["x-tula-publishable-key"])

        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", "/v1/client/me/organization-invitations/accept") {
            ok("""{"id":"org_1","name":"Acme","slug":"acme","role":"member","permissions":[],"createdAt":"2026-01-01T00:00:00.000Z"}""")
        }
        bench.engine.on("POST", "/v1/client/me/organization-invitations/decline") { answer(204, "") }
        val joined = bench.tula.organizations.invitations.accept("the-token")
        assertEquals("org_1", joined.id)
        assertEquals("Bearer ${fakeJwt("first")}", bench.engine.sent("/v1/client/me/organization-invitations/accept").single().headers["authorization"])
        bench.tula.organizations.invitations.decline("the-token")
        assertEquals(
            """{"token":"the-token"}""",
            bench.engine.sent("/v1/client/me/organization-invitations/decline").single().body,
        )

        // A 200 that names no organization is not an organization.
        bench.engine.on("POST", "/v1/client/me/organization-invitations/accept") {
            ok("""{"id":"","name":"Acme","slug":"acme","role":"member","permissions":[],"createdAt":"2026-01-01T00:00:00.000Z"}""")
        }
        assertEquals("response.invalid", caught { bench.tula.organizations.invitations.accept("the-token") }.code)
    }

    @Test
    fun `the token of an invitation is in no error, no description and no request but its body`() = runTest {
        val secret = "tula_inv_the-secret-token-value"
        val bench = Bench()
        bench.signIn()
        val refusals = listOf(
            "organization.invitation_wrong_account" to 403,
            "organization.invitation_email_unverified" to 403,
            "organization.invitation_expired" to 410,
            "organization.invitation_used" to 409,
        )
        for ((code, status) in refusals) {
            bench.engine.on("POST", "/v1/client/me/organization-invitations/accept") { answer(status, errorJson(code, status)) }
            val error = caught { bench.tula.organizations.invitations.accept(secret) }
            assertEquals(code, error.code)
            assertFalse(error.toString().contains(secret))
            assertFalse((error.message ?: "").contains(secret))
        }
        bench.engine.on("POST", "/v1/client/me/organization-invitations/accept") { ok("""{"nothing":"useful"}""") }
        val invalid = caught { bench.tula.organizations.invitations.accept(secret) }
        assertFalse(invalid.toString().contains(secret))
        assertFalse((invalid.message ?: "").contains(secret))
        for (request in bench.engine.requests) {
            assertFalse(request.url.contains(secret), "never in an address")
            assertFalse(request.toString().contains(secret))
            assertFalse(request.headers.values.any { it.contains(secret) }, "never in a header")
        }
        assertEquals("TulaOrganizationInvitations", bench.tula.organizations.invitations.toString())
        assertEquals("TulaOrganizations", bench.tula.organizations.toString())
    }

    @Test
    fun `members list, invite and revoke invitations by organization`() = runTest {
        val bench = Bench()
        bench.signIn()
        val invitation =
            """{"id":"inv_1","organizationId":"org_1","email":"new@example.com","role":"member","status":"pending",""" +
                """"invitedBy":"user-1","expiresAt":"2026-01-08T00:00:00.000Z","createdAt":"2026-01-01T00:00:00.000Z"}"""
        bench.engine.on("GET", "$ME_ORGANIZATIONS/org_1/invitations") {
            ok("""{"meta":{"totalCount":1,"totalPages":1,"page":1,"perPage":20},"data":[$invitation]}""")
        }
        bench.engine.on("POST", "$ME_ORGANIZATIONS/org_1/invitations") { ok(invitation) }
        bench.engine.on("DELETE", "$ME_ORGANIZATIONS/org_1/invitations/inv_1") { answer(204, "") }

        assertEquals("inv_1", bench.tula.organizations.invitations.list("org_1").data.single().id)
        val sent = bench.tula.organizations.invitations.invite("org_1", "new@example.com", "member", "https://app.example.com/join")
        assertEquals("inv_1", sent.id)
        assertEquals(
            """{"email":"new@example.com","role":"member","redirectUrl":"https://app.example.com/join"}""",
            bench.engine.sent("$ME_ORGANIZATIONS/org_1/invitations").last().body,
        )
        bench.tula.organizations.invitations.revoke("org_1", "inv_1")
        assertEquals(1, bench.engine.sent("$ME_ORGANIZATIONS/org_1/invitations/inv_1").size)

        bench.engine.on("GET", "$ME_ORGANIZATIONS/org_1/invitations") {
            answer(403, errorJson("organization.permission_required", 403))
        }
        assertEquals("organization.permission_required", caught { bench.tula.organizations.invitations.list("org_1") }.code)
    }
}
