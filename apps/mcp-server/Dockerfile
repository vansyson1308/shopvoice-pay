# Build context: the repository root (docker build -f apps/mcp-server/Dockerfile .)
# The Node base image. The default is what Render builds with; CI overrides it
# (--build-arg NODE_BASE_IMAGE=...) with a mirror of the same official image,
# because anonymous pulls from shared runner IPs hit ECR Public's data limit.
ARG NODE_BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json types-node-compat.d.ts ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund
RUN npx tsc -b apps/mcp-server
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_BASE_IMAGE}
# psql applies migrations in the pre-deploy step (scripts/deploy/db_prepare.mjs).
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/mcp-server ./apps/mcp-server
# Simulated supplier agents (PayPal Cart API spec), mounted at /supplier-agent.
COPY --from=build /app/apps/supplier-agent ./apps/supplier-agent
COPY db ./db
# The demo dataset generator backs visitor demo shops; the rest prepares the database.
COPY scripts/gen_demo_seed.mjs scripts/db_lib.mjs scripts/db_migrate.mjs ./scripts/
COPY scripts/deploy ./scripts/deploy
EXPOSE 8090
USER node
CMD ["node", "apps/mcp-server/dist/server.js"]
