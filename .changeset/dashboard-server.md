---
'@tula/contract': minor
'@tula/admin': minor
---

The server side of the dashboard (ADR 0032).

- `@tula/contract`: the dashboard's header names (`DASHBOARD_HEADER`, `DASHBOARD_HEADER_VALUE`,
  `ENVIRONMENT_HEADER`) and cookie name (`DASHBOARD_SESSION_COOKIE`) in `@tula/contract/headers`;
  the `instance_admin` audit actor; `INSTANCE_ACTIVITY_TYPES` and `INSTANCE_AUDIT_TARGET_TYPES`
  for the instance audit log.
- `@tula/admin`: the admin client gains `listUserSessions` and `revokeUserSession`, and the
  audit log's `actorType`, `from` and `to`; the instance client gains workspaces, projects,
  environments and the instance audit log. Both still take the secret key and the instance
  admin token: the dashboard's cookie session is a browser's and is not part of this package.
