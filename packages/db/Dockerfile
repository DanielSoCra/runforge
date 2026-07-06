FROM node:22-alpine

WORKDIR /app

# corepack reads the pinned version from root package.json (pnpm@10.32.1)
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/package.json

RUN pnpm install --frozen-lockfile --filter @runforge/db

COPY packages/db/ ./packages/db/

CMD ["pnpm", "--filter", "@runforge/db", "db:migrate"]
