# Build context: the repository root (docker build -f apps/console/Dockerfile .)
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
RUN npx tsc -b apps/console
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/console ./apps/console
EXPOSE 8091
USER node
CMD ["node", "apps/console/dist/server.js"]
