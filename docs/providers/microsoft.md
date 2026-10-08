# Sign in with Microsoft: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider, and no Microsoft tenant: the flow is tested against the API's built-in
> mock provider and against ID tokens the tests sign themselves. The redirect URI, the scopes
> and the token checks below are what the code does; the portal steps are written from
> Microsoft's documentation and have not been clicked through.

> **Required: the `xms_edov` optional claim (step 4). Without it nobody can sign up with
> Microsoft.** Tula counts a Microsoft address as verified only when the ID token carries
> `xms_edov: true`. A token without it signs in a Microsoft account Tula already knows and
> nothing else: every new account is refused with `oauth.email_unverified`, no user is
> created and no existing user is linked. Adding the claim is part of the setup, not an
> optimisation.
>
> **Personal accounts (`consumers`, and the personal accounts `common` lets in): unknown.**
> The Microsoft documentation this was written from describes `xms_edov` for an address
> whose *domain owner* was verified, which is a property of an organization's tenant. It
> does not say whether a personal account's token (outlook.com, hotmail.com, or a personal
> account on any other address) ever carries the claim, and no such token was looked at.
> Until someone checks with a real personal account, assume that **personal accounts may
> not be able to sign up at all**, and test it before you offer `consumers` or `common`.

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)). It covers
Microsoft Entra ID (work and school accounts) and personal Microsoft accounts.

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/microsoft`.
2. **Register an application** (Microsoft Entra admin center → Identity → Applications → App
   registrations → New registration).
   - *Supported account types*: who may sign in. Remember the choice: step 6 has to match it.
   - *Redirect URI*: platform **Web**, the `callbackUrl`, character for character.
3. **Create a client secret** (the app → Certificates & secrets → New client secret) and copy
   its **Value** at once: the portal shows it once. The *Secret ID* beside it is not the
   secret. A client secret expires; note the date.
4. **Add the optional claims** (the app → Token configuration → Add optional claim → token
   type **ID**):
   - `email`,
   - `xms_edov` (not in the portal's list on every tenant: it can be added in the app's
     **Manifest**, under `optionalClaims.idToken`, as `{ "name": "xms_edov" }`),
   - `given_name` and `family_name` if you want the user's name filled in.

   **This step is required.** Without `xms_edov` every address counts as unverified: nobody
   can sign *up* with Microsoft and no Microsoft account is linked to an existing user by
   its address. See "What the address proves" below.
5. **API permissions**: the delegated Microsoft Graph permissions `openid`, `profile` and
   `email`. Tula asks for nothing else and calls no Microsoft API with the token.
6. **Give Tula the credentials**, with the tenant that matches step 2:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/microsoft" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<application (client) id>", "clientSecret": "<secret value>", "tenant": "organizations" }'
   ```
7. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

## The tenant

`tenant` is required and has no default: which Microsoft accounts may sign in is a decision.

| `tenant` | Who can sign in | "Supported account types" it matches |
| --- | --- | --- |
| `common` | Any Microsoft account: work, school or personal | Any Entra ID tenant and personal accounts |
| `organizations` | Work and school accounts of any organization | Any Entra ID tenant (multitenant) |
| `consumers` | Personal Microsoft accounts only | Personal accounts only |
| a tenant id (a GUID) | Accounts of that one organization | This organizational directory only |

A tenant's domain name (`contoso.onmicrosoft.com`) is refused: a token names its tenant by
id, and Tula compares ids. The directory (tenant) id is on the app's Overview page. The
value is not a secret; it is returned by `GET /v1/admin/oauth-providers` and may be written
in `tula.config.ts`.

With `common` or `organizations`, **any** organization's accounts are accepted, each tenant
under its own issuer. If only some organizations should get in, use one tenant id, or decide
it in your application: Tula has no list of allowed tenants, and a hook is not told the
tenant.

## What Tula checks in the token

Tula asks for the scopes `openid`, `profile` and `email`, sends PKCE (`code_challenge` with
`S256`, the `code_verifier` on the token request) and a `nonce`, and reads the ID token and
nothing else. A token is accepted only when all of these hold; any failure is the same
`oauth.provider_error`, with nothing of the token in it:

- it is signed (`RS256`) by a key of the authority that was configured, and that key is one
  Microsoft publishes for the token's issuer (the key's own `issuer`, in which `{tenantid}`
  stands for the token's tenant);
- `aud` is your client id, it has not expired, and `nonce` is the one this sign-in sent;
- `tid` is a GUID and `iss` is exactly `https://login.microsoftonline.com/<tid>/v2.0`, built
  from the token's **own** tenant id. This is what makes `common` safe: there is no single
  issuer to compare with, so the issuer has to agree with the tenant the token names;
- the tenant is one the configured `tenant` accepts: that tenant itself for a tenant id,
  the personal-account tenant (`9188040d-6c67-4c5b-b112-36a304b66dad`) and nothing else for
  `consumers`, every tenant but that one for `organizations`, any for `common`.

**An account is its tenant id and object id** (`tid` and `oid`), never an email address, a
user principal name or `preferred_username`, which a tenant's administrator can set to
anything, and never `sub`, which is a different value for every application.

## What the address proves

The `email` claim of a Microsoft token is whatever the tenant's administrator stored for the
user. Microsoft's documentation says it "isn't guaranteed to be correct". So Tula treats
the address as **verified only when the token carries `xms_edov` as `true`**: Microsoft's
statement that the owner of the address's domain was verified.

| Token | Outcome |
| --- | --- |
| A Microsoft account Tula already knows (same `tid` and `oid`) | Signed in as its user, whatever the address and the claim say. |
| A new account, `xms_edov` true, no Tula user has the address | A new user, address verified, no password. |
| A new account, `xms_edov` true, a Tula user with that **verified** address | Linked to that user and signed in. |
| A new account, `xms_edov` true, a Tula user with that address **unverified** | `oauth.account_exists`: they sign in their usual way and connect Microsoft from the account page. |
| A new account, `xms_edov` absent or not `true` | `oauth.email_unverified`: no user is created and nothing is linked. |
| A new account with no `email` claim | `oauth.email_missing`. |

The last two rows are the same for every provider (ADR 0026): a provider address that is not
asserted as verified is refused before any account is looked up, so the answer does not say
whether the address has an account. For Microsoft that means the operator has to add the
`xms_edov` claim (step 4) before anyone can sign up with it. The message a user sees for
`oauth.email_unverified` tells them to verify the address with the provider, which a
Microsoft user cannot do themselves: if your users report it, check step 4.

A signed-in user can always **connect** a Microsoft account from the account page, with or
without the claim: there the session is the proof, not the address.

## Limits

- Whether a personal Microsoft account's token carries `xms_edov` is not known (see the
  top of this page). If it does not, personal accounts cannot sign up, and can only be
  connected by a user who is already signed in.
- Not run against Microsoft: no real tenant, no real token. Whether `xms_edov` is sent as a
  JSON boolean was taken from Microsoft's optional-claims reference ("Boolean value"); a
  token that carried it as the string `"true"` or the number `1` would be read as unverified.
- A Microsoft signing key without an `issuer` is refused. Microsoft's keys document carries
  one on every key; a key set that did not would fail every sign-in, closed.
- National clouds (`login.microsoftonline.us`, `login.partner.microsoftonline.cn`) and Azure
  AD B2C / External ID tenants (`<name>.ciamlogin.com`) are not supported: the authority is
  `login.microsoftonline.com`.
- The button is a neutral, themeable one with Microsoft's four-square logo. Microsoft's own
  button has a fixed size, font, colours and the words "Sign in with Microsoft"; check its
  branding guidelines against your theme before you ship.
