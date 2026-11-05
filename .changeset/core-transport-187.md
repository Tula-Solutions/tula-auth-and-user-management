---
'@tula-tech/core': patch
---

The client refuses a plain `http` base URL for any host but this machine (set `allowInsecureHttp` for a private network), never follows a redirect with the publishable key, and treats a success body that is not a JSON object as `response.invalid`.
