# Hetzner Deployment Guide

Runforge runs on Hetzner via Docker Compose. The stack includes **Postgres**, a one-shot **migration** job, **daemon**, **dashboard**, **briefing-summarizer**, and **Caddy** on a private Docker network. Caddy handles TLS termination and proxies HTTPS traffic to the dashboard.

## Prerequisites

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

The `runforge` user is created automatically by `cloud-init.yml` (with Docker group membership). If provisioning manually:

```bash
useradd -m -s /bin/bash runforge
usermod -aG docker runforge
```

> **Note:** All `docker compose` commands below are run as **root** (or via `sudo`). Even with the `docker` group, some volume-mount permission issues require root on this server.

## 4. Clone the Repository

```bash
git clone https://github.com/DANIELSOCRAHANDLEZZ/runforge.git /home/runforge/runforge
chown -R runforge:runforge /home/runforge/runforge
cd /home/runforge/runforge
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
| `POSTGRES_DB` | Use `runforge` unless you need a different local database name |
| `POSTGRES_USER` | Use `runforge` unless you need a different local database user |
| `POSTGRES_PASSWORD` | Generate a strong database password |
| `RUNFORGE_DOCKER_DATABASE_URL` | `postgres://runforge:<url-encoded-password>@postgres:5432/runforge` |
| `DAEMON_DATA_BACKEND` | `postgres` |
| `BRIEFING_DATA_BACKEND` | `postgres` |
| `NEXT_PUBLIC_SITE_URL` | `https://app.example.com` (your domain) |
| `DAEMON_URL` | `http://daemon:3847` (Docker service name — do not change) |
| `ENCRYPTION_KEY` | Any 32+ character random string |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub OAuth App client ID for repository connections |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret for repository connections |

## 6. Configure the Daemon

```bash
cp runforge.config.example.json runforge.config.json
nano runforge.config.json
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

## 8. Apply Migrations

The Compose stack runs the app-owned Postgres migrations automatically through the `migrate` service before consumers start.

## 9. Deploy

```bash
cd /home/runforge/runforge
docker compose --env-file .env.prod --profile public up --build -d
```

Verify the runtime containers are healthy and the migration job completed:

```bash
docker compose --env-file .env.prod --profile public ps
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
cd /home/runforge/runforge
git pull
docker compose --env-file .env.prod --profile public up --build -d
```

### View logs

```bash
# All services
docker compose --env-file .env.prod --profile public logs -f

# Single service
docker compose --env-file .env.prod --profile public logs -f dashboard
docker compose --env-file .env.prod --profile public logs -f daemon
```

### Restart a service

```bash
docker compose --env-file .env.prod --profile public restart dashboard
```

### Back up Postgres

Back up the app-owned database with `pg_dump`. Store `.env.prod` and especially `ENCRYPTION_KEY` with the backup; database credentials are encrypted and require the same key after restore.

```bash
mkdir -p backups
docker compose --env-file .env.prod exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/runforge-$(date +%Y%m%d-%H%M%S).dump"
```

### Restore Postgres

Restores overwrite the current database. Stop application consumers first, restore the dump, then start the stack again.

```bash
docker compose --env-file .env.prod --profile public stop dashboard briefing-summarizer
# If this host also runs the containerized daemon profile:
docker compose --env-file .env.prod --profile containerized-daemon stop daemon

cat backups/runforge-YYYYMMDD-HHMMSS.dump | docker compose --env-file .env.prod exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner'

docker compose --env-file .env.prod --profile public up --build -d
```

### Stop everything

```bash
docker compose --env-file .env.prod --profile public down
```

## Troubleshooting

**`git pull` fails with "unsafe directory"**

```bash
chown -R runforge:runforge /home/runforge/runforge
```

**`git pull` blocked by untracked files**

```bash
git stash  # or git reset --hard origin/main if no local changes to keep
```

**Dashboard shows 502**

Caddy is up but dashboard container is not. Check:

```bash
docker compose --env-file .env.prod --profile public logs dashboard
```
