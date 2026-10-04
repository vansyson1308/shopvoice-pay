# Build context: the repository root (docker build -f apps/console/Dockerfile .)
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json types-node-compat.d.ts ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund
RUN npx tsc -b apps/console
RUN npm prune --omit=dev --no-audit --no-fund

FROM public.ecr.aws/docker/library/node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/console ./apps/console
EXPOSE 8091
USER node
CMD ["node", "apps/console/dist/server.js"]
