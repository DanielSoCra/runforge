FROM node:22-slim

# Install pnpm and git
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Create state directory
RUN mkdir -p state/runs

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://127.0.0.1:3847/health || exit 1

EXPOSE 3847

ENTRYPOINT ["pnpm", "start", "--", "-c", "/app/auto-claude.config.json"]
