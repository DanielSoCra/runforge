FROM node:22-alpine AS base
# corepack reads the pinned version from root package.json (pnpm@10.32.1)
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
# Workspace root files required: pnpm must see workspace context to resolve
# node_modules from /app/node_modules during next build
COPY package.json pnpm-workspace.yaml ./
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY packages/dashboard/ ./packages/dashboard/
WORKDIR /app/packages/dashboard
RUN pnpm build

FROM base AS runner
WORKDIR /app/packages/dashboard
ENV NODE_ENV=production
COPY --from=builder /app/packages/dashboard/.next/standalone ./
COPY --from=builder /app/packages/dashboard/.next/static ./.next/static
COPY --from=builder /app/packages/dashboard/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
