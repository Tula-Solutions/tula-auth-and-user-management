---
"@tula-tech/contract": minor
"@tula-tech/core": minor
"@tula-tech/react": minor
---

`tula.organizations.sso` lets a member who holds `org:sys:sso:manage` read and change their organization's SSO connections and group mapping through `/v1/client/me/organizations/:id/sso-connections`; the client secret is write-only. `<OrganizationProfile>` gets a "Single sign-on" tab for such a member.
