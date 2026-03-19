# Hetzner Cloud Self-Hosted Runner Setup

This guide covers deploying Auto-Claude on a Hetzner Cloud server with a GitHub Actions self-hosted runner.

## 1. Server Provisioning

Recommended server type: **CPX21** (3 vCPUs, 4 GB RAM, 80 GB SSD).

1. Log into [Hetzner Cloud Console](https://console.hetzner.cloud/).
2. Create a new project (e.g., `auto-claude`).
3. Add a new server:
   - Location: choose the region closest to you.
   - Image: Ubuntu 24.04 LTS.
   - Type: CPX21.
   - SSH key: add your public key.
4. Note the server's public IP.

## 2. Initial System Setup

SSH into the server and run:

```bash
apt-get update && apt-get upgrade -y
apt-get install -y git curl build-essential
```

## 3. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version   # should print v22.x.x
```

## 4. Install pnpm

```bash
npm install -g pnpm
pnpm --version
```

## 5. Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

Authenticate once interactively:

```bash
claude auth login
```

The credentials are stored in `~/.config/anthropic/`. For non-interactive environments set `ANTHROPIC_API_KEY` instead.

## 6. Clone the Repository

```bash
git clone https://github.com/<owner>/<repo>.git /opt/auto-claude
cd /opt/auto-claude
pnpm install
cp auto-claude.config.example.json auto-claude.config.json
# Edit auto-claude.config.json with your repo details
```

## 7. Install the GitHub Actions Self-Hosted Runner

In your GitHub repository: **Settings → Actions → Runners → New self-hosted runner**.

Select **Linux / x64** and follow the generated commands, e.g.:

```bash
mkdir /opt/actions-runner && cd /opt/actions-runner
curl -o actions-runner-linux-x64-2.x.x.tar.gz -L https://github.com/actions/runner/releases/download/v2.x.x/actions-runner-linux-x64-2.x.x.tar.gz
tar xzf ./actions-runner-linux-x64-2.x.x.tar.gz
./config.sh --url https://github.com/<owner>/<repo> --token <REGISTRATION_TOKEN>
```

## 8. systemd Service for the Runner

Create `/etc/systemd/system/github-runner.service`:

```ini
[Unit]
Description=GitHub Actions Self-Hosted Runner
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/actions-runner
ExecStart=/opt/actions-runner/run.sh
Restart=always
RestartSec=5
Environment=GITHUB_TOKEN=<your-github-token>
Environment=ANTHROPIC_API_KEY=<your-anthropic-key>

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable github-runner
systemctl start github-runner
systemctl status github-runner
```

## 9. Configuring Secrets

Set secrets in your GitHub repository under **Settings → Secrets and variables → Actions**:

- `GITHUB_TOKEN` — A fine-grained PAT with `issues: write` and `contents: write` permissions (or use the default `GITHUB_TOKEN` provided by Actions).
- `ANTHROPIC_API_KEY` — Your Anthropic API key.

For the systemd daemon mode (non-Actions), you can also set these in `/etc/environment` or in the service's `EnvironmentFile`.

## 10. Optional: Auto-Claude Daemon for the Dashboard

To run the control-plane daemon (which exposes the dashboard at `http://localhost:3847/dashboard`):

Create `/etc/systemd/system/auto-claude.service`:

```ini
[Unit]
Description=Auto-Claude Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/auto-claude
ExecStart=/usr/bin/npx tsx src/main.ts start -c auto-claude.config.json
Restart=always
RestartSec=10
EnvironmentFile=/etc/auto-claude.env

[Install]
WantedBy=multi-user.target
```

Create `/etc/auto-claude.env`:

```
GITHUB_TOKEN=<your-github-token>
ANTHROPIC_API_KEY=<your-anthropic-key>
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable auto-claude
systemctl start auto-claude
```

The dashboard will be accessible at `http://<server-ip>:3847/dashboard`. Consider placing nginx in front to restrict access.

## 11. Firewall

Allow only necessary ports:

```bash
ufw allow ssh
ufw allow 3847/tcp   # only if exposing the dashboard externally (optional)
ufw enable
```
