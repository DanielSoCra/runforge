# Hetzner Deployment Guide

Auto-Claude runs on Hetzner via Docker Compose. Three containers — **daemon**, **dashboard**, and **Caddy** — communicate over a private Docker network. Caddy handles TLS termination and proxies HTTPS traffic to the dashboard.

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- A domain with DNS control (current: `app.example.com`)
- An SSH key added to the Hetzner server

## 1. Server Provisioning

Recommended: **CPX21** (3 vCPUs, 4 GB RAM, 80 GB SSD), Ubuntu 24.04 LTS.

1. Log into [Hetzner Cloud Console](https://console.hetzner.cloud/).
2. Create a server, add your SSH key, note the public IP.
3. Point your domain's A record at the server IP.

## 2. Verify Docker

Docker and Docker Compose are installed automatically by `cloud-init.yml`. If provisioning manually (without Terraform/cloud-init), install Docker first:

```bash
curl -fsSL https://get.docker.com | sh
```

Verify:

```bash
docker --version
docker compose version
```

## 3. Create the Deploy User

The `autoclaud` user is created automatically by `cloud-init.yml` (with Docker group membership). If provisioning manually:

```bash
useradd -m -s /bin/bash autoclaud
usermod -aG docker autoclaud
```

> **Note:** All `docker compose` commands below are run as **root** (or via `sudo`). Even with the `docker` group, some volume-mount permission issues require root on this server.

## 4. Clone the Repository

```bash
git clone https://github.com/DANIELSOCRAHANDLEZZ/auto-claude.git /home/autoclaud/auto-claude
chown -R autoclaud:autoclaud /home/autoclaud/auto-claude
cd /home/autoclaud/auto-claude
```

## 5. Create the Environment File

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

Fill in all values:

| Variable | Where to get it |
|----------|----------------|
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Fine-grained PAT with `repo` scope |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project → Settings → API → `anon` key |
| `SUPABASE_URL` | Same as `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API → `service_role` key |
| `NEXT_PUBLIC_SITE_URL` | `https://app.example.com` (your domain) |
| `DAEMON_URL` | `http://daemon:3847` (Docker service name — do not change) |
| `ENCRYPTION_KEY` | Any 32+ character random string |
| `GITHUB_REPO_OAUTH_APP_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_REPO_OAUTH_APP_CLIENT_SECRET` | GitHub OAuth App client secret |

## 6. Configure the Daemon

```bash
cp auto-claude.config.example.json auto-claude.config.json
nano auto-claude.config.json
```

Set at minimum:

```json
{
  "repo": {
    "owner": "your-github-username",
    "name": "your-repo-name"
  }
}
```

## 7. Configure Caddy

The `Caddyfile` in the repo root is pre-configured:

```
app.example.com {
  reverse_proxy dashboard:3000
}
```

Change the domain if needed before first deploy.

## 8. Apply Supabase Migrations

Migrations live in `packages/daemon/migrations/`. Run them in the Supabase SQL editor or via the Supabase CLI before starting the stack.

## 9. Deploy

```bash
cd /home/autoclaud/auto-claude
docker compose -f docker-compose.prod.yml up --build -d
```

Verify all three containers are running:

```bash
docker compose -f docker-compose.prod.yml ps
```

The dashboard is available at `https://app.example.com` once Caddy has obtained a TLS certificate (usually within 30 seconds on first start).

## 10. Firewall

Allow only HTTP, HTTPS, and SSH:

```bash
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

The daemon's control port (3847) is **not** exposed externally — it is internal to the Docker network only.

## Routine Operations

### Update to latest

```bash
cd /home/autoclaud/auto-claude
git pull
docker compose -f docker-compose.prod.yml up --build -d
```

### View logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Single service
docker compose -f docker-compose.prod.yml logs -f dashboard
docker compose -f docker-compose.prod.yml logs -f daemon
```

### Restart a service

```bash
docker compose -f docker-compose.prod.yml restart dashboard
```

### Stop everything

```bash
docker compose -f docker-compose.prod.yml down
```

## Troubleshooting

**`git pull` fails with "unsafe directory"**

```bash
chown -R autoclaud:autoclaud /home/autoclaud/auto-claude
```

**`git pull` blocked by untracked files**

```bash
git stash  # or git reset --hard origin/main if no local changes to keep
```

**Dashboard shows 502**

Caddy is up but dashboard container is not. Check:

```bash
docker compose -f docker-compose.prod.yml logs dashboard
```
