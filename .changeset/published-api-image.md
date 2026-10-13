---
'create-tula': minor
---

A new project pulls the Tula API image instead of asking you to build it. `TULA_API_IMAGE`
in the scaffolded `.env` now names the published image of `create-tula`'s own version,
`ghcr.io/tula-solutions/tula-api:<version>` (amd64 and arm64), which `bunx tula dev` pulls
the first time it starts the stack: no checkout of the Tula repository and no
`docker build` is needed for a web project. `--api-image <ref>` still names another image,
such as `tula-api:local` built from a checkout.
