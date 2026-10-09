# syntax=docker/dockerfile:1.7
# O-02: one Dockerfile for every Nest app in packages/backend (build with --build-arg APP=core|worker|projector|...).
#
#   docker build -f infra/docker/node/Dockerfile --build-arg APP=core -t marketplace/core .
#
# Layers, most stable first, so a code change re-runs only the last two:
#   1. pnpm fetch from the lockfile alone        (cached until pnpm-lock.yaml changes)
#   2. offline install of the backend's deps      (cached until manifests change)
#   3. nest build <app>                           (webpack bundle of the app + libs/common)
#   4. offline production-only install            (no dev deps in the runtime image)
ARG NODE_VERSION=24.13.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM fetch AS build
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline --filter api...
COPY packages/contracts packages/contracts
COPY packages/backend packages/backend
ARG APP
RUN test -n "$APP" && pnpm --filter api exec nest build "$APP"

FROM fetch AS prod-deps
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline --prod --filter api...

# Pre-deploy migrations (deploy.yml runs it once per release, before any new app instance starts):
#   docker build --target migrator ...  →  docker run <image>   (expand/contract: old code must keep working)
FROM build AS migrator
RUN npm install -g sequelize-cli@6.6.3
WORKDIR /repo/packages/backend
USER node
ENTRYPOINT ["sequelize-cli", "db:migrate", "--env", "production"]

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
# tini = PID 1: forwards SIGTERM to node (graceful shutdown, F-01) and reaps zombies (ffmpeg children).
# ffmpeg only where transcoding runs (SD-26 worker).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && if [ "$APP" = "worker" ]; then apt-get install -y --no-install-recommends ffmpeg; fi \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production APP=${APP} OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
WORKDIR /app
# pnpm's node_modules is a symlink farm into .pnpm: copy both levels whole so the links still resolve.
COPY --from=prod-deps --chown=node:node /repo/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /repo/packages/backend/node_modules /app/packages/backend/node_modules
COPY --from=build --chown=node:node /repo/packages/backend/dist/apps/${APP} /app/packages/backend/dist/apps/${APP}
COPY --chown=node:node infra/docker/node/entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /app/packages/backend
USER node
# No HEALTHCHECK: the ALB/target group probes /readyz, the ASG replaces instances that fail /livez.
EXPOSE 8000 9464
# Orchestrators stop with SIGTERM; make it explicit so a base-image change cannot swap it for SIGINT/SIGKILL (S54 G-45).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
