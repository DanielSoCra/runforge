# Self-Hosted GitHub Actions Runner (macOS)

The workflows in `.github/workflows/` (`ci.yml`, `runforge.yml`) target `runs-on: self-hosted`. This doc covers running that runner on a macOS machine (tested on Apple Silicon) as a user-scope LaunchAgent that starts on login.

## Prerequisites

- `gh` CLI authenticated against the repo owner (`gh auth status`)
- Node 22+ and pnpm on `PATH` (workflows use `pnpm install`)
- Owner/admin rights on the repo to mint registration tokens

## 1. Download the runner

Pick the latest release tag and the matching `osx-arm64` / `osx-x64` tarball:

```bash
LATEST=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name)
VER=${LATEST#v}
ARCH=osx-arm64  # or osx-x64 on Intel

mkdir -p ~/actions-runner && cd ~/actions-runner
curl -sL -o runner.tar.gz \
  "https://github.com/actions/runner/releases/download/${LATEST}/actions-runner-${ARCH}-${VER}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
```

## 2. Register with the repo

Registration tokens expire after ~1 hour. Mint one via `gh` and pass it to `config.sh` in the same step:

```bash
TOKEN=$(gh api -X POST repos/<OWNER>/<REPO>/actions/runners/registration-token --jq .token)

cd ~/actions-runner
./config.sh \
  --url https://github.com/<OWNER>/<REPO> \
  --token "$TOKEN" \
  --name "$(hostname -s)" \
  --labels self-hosted,macOS,ARM64 \
  --work _work \
  --unattended --replace
```

`--replace` lets you re-register a runner with the same name (useful after re-imaging).

## 3. Install as a LaunchAgent

```bash
cd ~/actions-runner
./svc.sh install
./svc.sh start
```

This writes `~/Library/LaunchAgents/actions.runner.<owner>-<repo>.<hostname>.plist` and loads it via `launchctl`. It starts on user login; it does NOT run while the user is logged out (use a LaunchDaemon with `sudo ./svc.sh install` if you need pre-login execution).

Verify:

```bash
launchctl list | grep actions.runner
gh api repos/<OWNER>/<REPO>/actions/runners --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
```

The runner should show `"status":"online"` and pick up queued jobs immediately.

## Operate

```bash
# stop/start
cd ~/actions-runner && ./svc.sh stop
cd ~/actions-runner && ./svc.sh start

# logs
tail -f ~/Library/Logs/actions.runner.<owner>-<repo>.<hostname>/Runner_*.log
```

## Uninstall

```bash
cd ~/actions-runner
./svc.sh stop
./svc.sh uninstall
REMOVE=$(gh api -X POST repos/<OWNER>/<REPO>/actions/runners/remove-token --jq .token)
./config.sh remove --token "$REMOVE"
cd ~ && rm -rf ~/actions-runner
```

## Notes

- **Trust model:** the runner executes workflow code as the logged-in user with access to the keychain, SSH keys, and all files that user can read. Only grant write access to the repo to people you trust to run code on this machine.
- **Minutes billing:** self-hosted runners do NOT consume the GitHub Actions minutes quota. Queue time on a self-hosted runner does not bill either; however, with no runner online, jobs sit queued until the 24h timeout.
- **Concurrent jobs:** the runner processes one job at a time. Multiple queued jobs drain sequentially. If parallel CI matters, register additional runners.
- **Local daemon coexistence:** `runforge.yml` fires on `ready` label and runs the daemon's `process` command via Claude API (using `ANTHROPIC_API_KEY` secret). If a local daemon is also polling the same repo, both will try to process the same issue. Gate one of them — typically by disabling `runforge.yml` when the local daemon is authoritative.
