# syntax=docker/dockerfile:1
# Tula API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t tula-api .
# Bun runs the TypeScript sources directly, so there is no compile step: the image is the
# production dependencies plus the sources of the API and the two packages it imports.
#
# The base image is pinned by digest (the multi-arch index, so amd64 and arm64 both resolve):
# a tag can be moved to different contents, a digest cannot. Dependabot proposes the update
# when a new digest or version is published (.github/dependabot.yml); keep the tag in step with
# `packageManager` in the root package.json. To check or refresh it by hand:
#   docker buildx imagetools inspect oven/bun:1.4.2-slim
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /usr/src/app

# Production dependencies only, for the workspaces the API is built from. The manifests of the
# browser packages (`packages/react`, `packages/nextjs`, `examples/*`) are deliberately NOT
# copied: with them present, `bun install --production` installs their dependencies and peers,
# and the API image gains React and Next.js. A frozen lockfile installs fine with workspaces missing (they are skipped); the
# `self-host` CI job builds this image, so a Bun that stops tolerating that fails there.
FROM base AS install
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/conformance/package.json packages/conformance/
COPY packages/core/package.json packages/core/
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS release
ENV NODE_ENV=production
COPY --from=install /usr/src/app ./
COPY packages/tsconfig packages/tsconfig
COPY packages/contract packages/contract
COPY packages/db packages/db
COPY apps/api apps/api
# The dashboard (ADR 0032). The API serves `apps/dashboard/dist` at /dashboard when it holds an
# index.html, and answers 404 there when it does not, so this image works without the app.
# Placeholder for the dashboard's build stage, which arrives with the app (step 1.15's UI):
#   COPY --from=dashboard /usr/src/app/apps/dashboard/dist apps/dashboard/dist
# It must build with `base: '/dashboard/'` and no inline script or style (the CSP forbids both).

# Never run as root: the server needs no write access to its own files.
USER bun
WORKDIR /usr/src/app/apps/api
EXPOSE 3003/tcp

# `/v1/ready` also checks the database, so an instance that cannot serve is not marked healthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/v1/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "run", "src/server.ts"]
