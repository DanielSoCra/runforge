FROM node:22-slim

# corepack reads the pinned version from root package.json (pnpm@10.32.1)
RUN corepack enable
# python3/make/g++ are the native toolchain for building better-sqlite3 ^12
# (pulled in via @auto-claude/decision-index, listed in onlyBuiltDependencies)
RUN apt-get update && apt-get install -y git curl python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.81

# Install phase — build context is repo root so pnpm-lock.yaml is accessible
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/package.json
COPY packages/daemon/package.json ./packages/daemon/package.json
# decision-index + decision-protocol are workspace deps of the daemon (statically
# imported by control-plane/decision-escalation/*). Their package.json must be
# present so --frozen-lockfile can resolve the daemon's dependency closure.
COPY packages/decision-index/package.json ./packages/decision-index/package.json
COPY packages/decision-protocol/package.json ./packages/decision-protocol/package.json
# Dashboard package.json needed for pnpm workspace lockfile validation,
# but --filter ensures only daemon dependencies are actually installed (#189)
COPY packages/dashboard/package.json ./packages/dashboard/package.json
RUN pnpm install --frozen-lockfile --filter @auto-claude/daemon...

# Copy daemon source only
COPY packages/db/ ./packages/db/
# decision-index + decision-protocol source — statically imported by the daemon
# control plane, so the runtime needs them present (not just at install time).
COPY packages/decision-index/ ./packages/decision-index/
COPY packages/decision-protocol/ ./packages/decision-protocol/
COPY packages/daemon/src/ ./packages/daemon/src/
COPY packages/daemon/tsconfig.json ./packages/daemon/

# Run from the daemon package dir: process.cwd() resolves state/, prompts/, etc.
WORKDIR /app/packages/daemon
RUN mkdir -p state/runs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://127.0.0.1:3847/health || exit 1

EXPOSE 3847

# CMD (not ENTRYPOINT) so docker-compose command: can override in dev
# WORKDIR is /app/packages/daemon — default config path auto-claude.config.json resolves there
CMD ["pnpm", "start"]
