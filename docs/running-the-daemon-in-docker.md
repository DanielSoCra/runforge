# Running the daemon in Docker (always-on)

How to run the auto-claude daemon as an always-on container against a target
repo, on a Mac that authenticates Claude via a Max/Pro **subscription** (no API
key, no per-token cost). Covers the three things that make a container daemon
actually work: the **workspace clone**, **subscription-auth that stays fresh**,
and **per-role model selection**.

## 1. Workspace: `workspaceRoot` (clone-on-startup)

The pipeline creates a git worktree per issue (`git worktree add`), which needs
a **git repo to branch off**. Natively the daemon is launched from inside a
checkout of the target repo, so its cwd is that repo. A container's cwd
(`/app/packages/daemon`) is the daemon's own code, not the target — so set:

```jsonc
// auto-claude.config.json
{
  "repo": { "owner": "you", "name": "your-target-repo" },
  "workspaceRoot": "/app/repo"   // daemon clones config.repo here on startup
}
```

On startup the daemon checks `workspaceRoot`:
- already a git checkout → use as-is (idempotent across restarts);
- not a git repo → **clone `config.repo` into it** (auth via the credential
  store, below) so the worktree base exists.

Mount a writable volume at that path so the clone (and parked-run worktrees)
survive restarts:

```yaml
# docker-compose override
services:
  daemon:
    volumes:
      - daemon-workspace:/app/repo
volumes:
  daemon-workspace:
```

`GITHUB_TOKEN` must be in the container env (already required for the daemon).
The clone uses a global credential store keyed on `$HOME/.git-credentials`
(written 0600), so the token never lands in the repo's `.git/config`.

## 2. Subscription auth that stays fresh (`sync-claude-creds.sh`)

The CLI reads creds from `$HOME/.claude/.credentials.json`. In a container that
is a **bind-mounted copy** of the host credential. The token expires roughly
hourly, and you do **not** want the container running its own OAuth refresh —
that rotates the shared refresh-token and breaks the host's `claude` login.

So the **host Keychain stays the single source of truth** and a launchd job
copies the current credential into the mounted dir on a short interval, well
inside the access-token lifetime — the container never needs to refresh itself.

```bash
# one-shot (also used to seed before first `up`)
AUTO_CLAUDE_CREDS_DIR=/path/mounted/to/root/.claude \
  scripts/sync-claude-creds.sh

# always-on: install the launchd agent (every 15 min, RunAtLoad)
#   substitute __REPO_ROOT__, __CREDS_DIR__, __HOME__, __PATH__ in
#   scripts/com.autoclaude.creds-sync.plist, then:
launchctl load -w ~/Library/LaunchAgents/com.autoclaude.creds-sync.plist
```

The subscription credential lives under Keychain account = your macOS username
(service `Claude Code-credentials`). Override with `AUTO_CLAUDE_KEYCHAIN_ACCOUNT`
if needed. The script validates the credential and writes atomically; it never
prints the secret.

> **Caveat (known limitation):** if the host `claude` CLI rotates the
> refresh-token between syncs, the container keeps working on its synced
> access-token until the next sync overwrites it. Keep the sync interval
> comfortably under the access-token lifetime (default 15 min). A dedicated
> always-on host (separate login) removes the shared-token coupling entirely.

Mount the creds dir writable (`:ro` makes the CLI 401):

```yaml
    environment:
      HOME: /root
    volumes:
      - /path/mounted/to/root/.claude:/root/.claude
      - ${HOME}/.claude.json:/root/.claude.json   # onboarding/trust (one-time)
```

## 3. Per-role model selection (`roleModels`)

Default is every role on Claude Opus 4.8. Route any agent role to a different
model/provider via `roleModels`, keyed by the resolved agent-definition name.
Example — keep building on Opus, send reviews to GPT-5.5 (Codex/`codex-cli`):

```jsonc
{
  "providers": {
    "codex-cli": { "name": "codex-cli", "model": "gpt-5.5-codex" }
  },
  "roleModels": {
    "codebase-reviewer": { "provider": "codex-cli", "modelTier": "xhigh" }
  }
}
```

Caveats:
- **Codex spend is invisible to the daemon's budget tracker** (it bills the
  Codex/ChatGPT side, not the Claude subscription). Watch it separately.
- Some role prompts reference Claude-specific skills (e.g. the L2 designer); audit
  the prompt before routing those roles to a non-Claude provider.

## Bring-up + kill switch

```bash
# build
docker compose --profile containerized-daemon build daemon
# run (restart: unless-stopped keeps it always-on)
docker compose --profile containerized-daemon up -d daemon
# kill switch
docker stop auto-claude-daemon-1
```

Verify the boot log shows the workspace line
(`repoRoot … is a git checkout — using as-is`, or `cloning …`) and
`Auto-Claude daemon started`. Health: `curl localhost:3847/health`.
