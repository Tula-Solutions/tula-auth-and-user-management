---
'@tula/contract': patch
---

The OpenAPI document says more of what the API already does.

- Every `/v1/admin/*` and `/v1/instance/*` operation documents the answers of the dashboard's
  way in: 400 (two credentials in one request), 401, 403 `request.origin_not_allowed` and 404
  (an unknown environment). The routes themselves did not change.
- An API key's `name` refuses control characters (`^[^\u0000-\u001f\u007f]*$`).
