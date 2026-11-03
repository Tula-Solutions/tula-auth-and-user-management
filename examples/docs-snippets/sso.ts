import { createAdminClient } from '@tula-tech/admin'

// The admin API calls shown in docs/enterprise-sso.md, docs/sso-providers/*.md and docs/scim.md,
// through `@tula-tech/admin` so that they are typed against the OpenAPI contract. Copied by
// region (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })

/** Create a SAML connection from the identity provider's metadata, and read what to give it. */
export async function createSamlConnection(organizationId: string) {
  // #region sso-create-saml
  const { data: connection } = await admin.call('createSsoConnection', {
    body: {
      organizationId,
      protocol: 'saml',
      name: 'Acme Okta',
      saml: { metadataUrl: 'https://acme.okta.com/app/exk1abc/sso/saml/metadata' },
      // The preset names the attributes the provider sends; see the provider's page.
      attributeMapping: { idp: 'okta' },
      domains: ['acme.com'],
    },
  })
  // Paste these into the identity provider.
  const { acsUrl, spEntityId } = connection.saml ?? {}
  // #endregion
  return { connection, acsUrl, spEntityId }
}

/** Map the provider's groups to roles; the order is the precedence. */
export async function mapGroups(connectionId: string) {
  // #region sso-group-roles
  await admin.call('replaceSsoGroupRoles', {
    params: { id: connectionId },
    body: {
      mappings: [
        { group: 'tula-admins', role: 'admin' },
        { group: 'everyone', role: 'member' },
      ],
    },
  })
  // #endregion
}

/** Start a test sign-in, then read what it found: nothing is created by it. */
export async function testAndActivate(connectionId: string) {
  // #region sso-test-activate
  const { data: test } = await admin.call('startSsoConnectionTest', {
    params: { id: connectionId },
    body: { redirectUrl: 'https://auth.example.com/dashboard/' },
  })
  // Open test.authorizationUrl in a browser and sign in; it returns with #tula_test=<testId>.
  const { data: result } = await admin.call('getSsoConnectionTest', {
    params: { id: connectionId, testId: test.testId },
  })
  if (result.status === 'passed') {
    // Activation without a passing test is refused with `sso.test_required`.
    await admin.call('updateSsoConnection', {
      params: { id: connectionId },
      body: { status: 'active' },
    })
  }
  // #endregion
  return result
}

/** Turn enforcement on, with a password-only break-glass role and trust in the provider's MFA. */
export async function enforce(connectionId: string) {
  // #region sso-enforce
  await admin.call('updateSsoConnection', {
    params: { id: connectionId },
    body: { enforced: true, breakGlassRole: 'admin', trustIdpMfa: true },
  })
  // #endregion
}

/** Make a setup link for the organization's IT administrator; the token is shown once. */
export async function setupLink(organizationId: string) {
  // #region sso-setup-link
  const { data: link } = await admin.call('createSetupLink', {
    body: { organizationId, name: 'Acme IT', expiresInDays: 7 },
  })
  // Send link.url; the token is in its fragment and is not shown again.
  // #endregion
  return link.url
}
