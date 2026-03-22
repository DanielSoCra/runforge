FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/briefing-summarizer/package.json packages/briefing-summarizer/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @auto-claude/briefing-summarizer

# Copy source
COPY packages/briefing-summarizer/ packages/briefing-summarizer/

WORKDIR /app/packages/briefing-summarizer

CMD ["pnpm", "start"]
