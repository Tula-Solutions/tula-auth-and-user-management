---
'@tula-tech/nextjs': patch
---

Access tokens are accepted only with `typ: JWT` in their header, and a production server with no `appUrl` (`TULA_APP_URL`) now says once that the app origin is taken from the forwarded host.
