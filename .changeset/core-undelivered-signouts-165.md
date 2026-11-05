---
'@tula-tech/core': patch
---

A sign-out that could not reach the server is no longer forgotten when a new session starts: the next sign-out revokes every token it never delivered (up to eight), not only the newest.
