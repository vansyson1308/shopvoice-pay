FROM public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json types-node-compat.d.ts ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --no-audit --no-fund
RUN npx tsc -b apps/alexa-sim

ENV NODE_ENV=production
EXPOSE 8091
USER node
CMD ["node", "apps/alexa-sim/dist/server.js"]
