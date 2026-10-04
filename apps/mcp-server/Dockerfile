FROM public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json types-node-compat.d.ts ./
COPY apps ./apps
COPY packages ./packages
# The demo dataset generator backs MCP_DATA_BACKEND=memory (offline demos).
COPY scripts/v2/gen_demo_seed.mjs ./scripts/v2/gen_demo_seed.mjs

RUN npm ci --no-audit --no-fund
RUN npx tsc -b apps/mcp-server

ENV NODE_ENV=production
EXPOSE 8090
USER node
CMD ["node", "apps/mcp-server/dist/server.js"]
