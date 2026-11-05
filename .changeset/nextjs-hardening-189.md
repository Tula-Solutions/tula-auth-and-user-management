---
'@tula-tech/nextjs': patch
---

Hardening: the handler clears a refresh cookie that a new session id replaces, and the README states the limits of the single flight, of unprefixed cookies over http and of the `x-tula-auth` header outside the matcher.
