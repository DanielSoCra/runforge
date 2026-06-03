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

# Bake the runtime governance + prompt + fitness assets into the image so the
# daemon boots with NO runtime mounts. These are repo-tracked, non-secret
# operational files — unlike creds, which the operator mounts (NEVER baked).
#   - prompts/        : validatePromptContracts() (daemon.ts) + every worker /
#                       reviewer session read prompts/*.md. PROMPTS_DIR (below)
#                       points the daemon at this baked copy.
#   - FACTORY_RULES.md: governance doc; loadGovernanceContext() requires it at
#                       <documentPath> resolved from cwd (/app/packages/daemon)
#                       or the repo-root fallback.
#   - fitness/        : fitness-function shell scripts referenced by the daemon.
COPY prompts/ ./packages/daemon/prompts/
COPY FACTORY_RULES.md ./packages/daemon/FACTORY_RULES.md
COPY fitness/ ./packages/daemon/fitness/

# Point prompt resolution at the baked copy regardless of process.cwd(). Without
# this, daemon.ts/runtime.ts fall back to join(import.meta.dirname,'../../../../prompts'),
# which resolves to /app/prompts in-container — where nothing is copied.
ENV PROMPTS_DIR=/app/packages/daemon/prompts

# Run from the daemon package dir: process.cwd() resolves state/, prompts/, etc.
WORKDIR /app/packages/daemon
RUN mkdir -p state/runs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://127.0.0.1:3847/health || exit 1

EXPOSE 3847

# CMD (not ENTRYPOINT) so docker-compose command: can override in dev
# WORKDIR is /app/packages/daemon — default config path auto-claude.config.json resolves there
CMD ["pnpm", "start"]
