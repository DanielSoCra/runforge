FROM node:22-alpine

WORKDIR /app

# corepack reads the pinned version from root package.json (pnpm@10.32.1)
RUN corepack enable

# Copy package files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/briefing-summarizer/package.json packages/briefing-summarizer/
# Sibling package.json files needed for pnpm workspace lockfile validation (#243)
COPY packages/daemon/package.json packages/daemon/
COPY packages/dashboard/package.json packages/dashboard/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @auto-claude/briefing-summarizer

# Copy source
COPY packages/briefing-summarizer/ packages/briefing-summarizer/

WORKDIR /app/packages/briefing-summarizer

CMD ["pnpm", "start"]
