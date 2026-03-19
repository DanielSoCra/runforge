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
# Per-package node_modules must come AFTER copying source (not to be overwritten)
COPY --from=deps /app/packages/dashboard/node_modules ./packages/dashboard/node_modules
WORKDIR /app/packages/dashboard
RUN pnpm build

FROM base AS runner
# outputFileTracingRoot points to repo root, so standalone mirrors:
#   packages/dashboard/server.js (entry) + node_modules/ (at repo root level)
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/packages/dashboard/.next/standalone ./
COPY --from=builder /app/packages/dashboard/.next/static ./packages/dashboard/.next/static
COPY --from=builder /app/packages/dashboard/public ./packages/dashboard/public
EXPOSE 3000
CMD ["node", "packages/dashboard/server.js"]
