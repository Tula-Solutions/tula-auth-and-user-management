---
"@tula-tech/contract": minor
"@tula-tech/core": patch
"@tula-tech/admin": minor
---

Test sign-in for an SSO connection (TULA-145). `POST /v1/admin/sso-connections/{id}/tests` starts a test round and `GET .../tests/{testId}` reads its result (passed with the mapped attributes, or failed with a reason code and an English sentence); the round creates no user, session, identity or membership. A connection is activated only after a test of its current settings has passed: `sso.test_required` (409) otherwise, and a changed setting takes the mark away (`tested` on the connection). New codes `sso.url_not_https` (422: a SAML SSO URL and an OIDC authorization endpoint must be https, http only in the `local` tier), `sso.test_required` and `sso.test_not_found`.
