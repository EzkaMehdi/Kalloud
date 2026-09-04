# OPS-05: the production image.
#
# Three stages, so what ships carries neither the build toolchain nor the
# devDependencies: a smaller attack surface, and an image whose contents are
# determined by the lockfile rather than by whatever was installed on the
# machine that built it.
#
# Pinned to Node 22 (active LTS) rather than to `node:latest`: "reproducible"
# has to mean the same bytes next month, and Next.js 16 is validated on
# 20/22/24 — the repo's own AGENTS.md warns that this Next is not the one
# most tooling assumes.
#
# pnpm is pinned by `packageManager` in package.json, which corepack honours.
# Without it, `corepack enable` fetched whatever was newest — this build came
# up on pnpm 11 while CI pinned 10, and failed on a lockfile the project
# considers perfectly valid. A build that depends on the day it runs is the
# opposite of what this ticket delivers.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: a lockfile that no longer matches package.json fails the
# build instead of silently resolving something else.
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Runs as a non-root user (the base image already provides `node`): a process
# that never needs to write to its own image should not be able to.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Migrations and their runner ship with the image, not beside it: the schema
# a release expects is part of that release. Same reason the readiness probe
# compares the two (lib/schema-version.ts).
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node
EXPOSE 3000

# No `pnpm` in the runtime stage: the standalone output is a plain Node
# server, and the fewer executables in the image, the better.
CMD ["node", "server.js"]
