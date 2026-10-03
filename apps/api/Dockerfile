# syntax=docker/dockerfile:1
# Tula API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t tula-api .
# Bun runs the TypeScript sources directly, so there is no compile step: the image is the
# production dependencies plus the sources of the API and the two packages it imports.
FROM oven/bun:1.4.2-slim AS base
WORKDIR /usr/src/app

# Production dependencies only. Every workspace manifest is needed for the frozen lockfile to
# resolve, including packages whose sources never reach the image.
FROM base AS install
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/conformance/package.json packages/conformance/
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS release
ENV NODE_ENV=production
COPY --from=install /usr/src/app ./
COPY packages/tsconfig packages/tsconfig
COPY packages/contract packages/contract
COPY packages/db packages/db
COPY apps/api apps/api

# Never run as root: the server needs no write access to its own files.
USER bun
WORKDIR /usr/src/app/apps/api
EXPOSE 3003/tcp

# `/v1/ready` also checks the database, so an instance that cannot serve is not marked healthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/v1/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "run", "src/server.ts"]
