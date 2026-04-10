# Mailcow + NPMplus + CrowdSec Stack

Mailcow 메일서버 앞단에 NPMplus(리버스 프록시) + CrowdSec(WAF)를 배치하는 구성.

## Architecture

```
Internet → :80/443 → NPMplus + CrowdSec WAF
                       ├── mail.DOMAIN      → Snappymail (webmail)
                       ├── mailcow.DOMAIN   → Mailcow Admin UI
                       └── mail-npm.DOMAIN  → NPMplus Dashboard

         → :25/465/587 → Postfix (direct)
         → :143/993    → Dovecot (direct)
```

## Prerequisites

- Linux server (Rocky/Alma/CentOS/Debian/Ubuntu)
- Root access
- DNS A records for `mail.DOMAIN`, `mailcow.DOMAIN`, `mail-npm.DOMAIN`
- **Docker, Mailcow are NOT required** — setup.sh installs everything

## Quick Start

```bash
git clone <this-repo> && cd mailcow-npmplus-stack
cp .env.example .env
# Edit .env — set DOMAIN at minimum
vi .env

chmod +x scripts/*.sh
sudo ./scripts/setup.sh
```

## What setup.sh does

1. Installs system packages (curl, dig, openssl, git)
2. Installs Docker Engine + Docker Compose
3. Clones and configures Mailcow (or patches existing)
4. Deploys NPMplus + CrowdSec (ports 80/443)
5. Deploys Snappymail (webmail)
6. Creates NPM admin account + proxy hosts + Let's Encrypt certs
7. Creates SSL symlinks for Mailcow (dovecot/postfix)
8. Installs cert reload cron

## Verify

```bash
sudo ./scripts/verify.sh
```

## Rollback

```bash
sudo ./scripts/teardown.sh
```

Restores Mailcow to direct 80/443 binding, removes NPMplus/CrowdSec/Snappymail.

## Files

```
.env.example                          # Configuration template
npmplus/docker-compose.yml            # NPMplus + CrowdSec
snappymail/docker-compose.yml         # Snappymail webmail
mailcow-override/
  docker-compose.override.yml         # Mailcow overrides (cert sharing, acme off)
  docker-compose.override.toolkit.yml # Toolkit addon (optional)
toolkit/config.yml.template           # Toolkit config template
scripts/
  setup.sh                            # Full installation
  verify.sh                           # Health check
  teardown.sh                         # Rollback
docs/guide.md                         # Detailed configuration guide
```

## Notes

- `MAILCOW_HOSTNAME` stays as `mail.DOMAIN` — used for HELO, autodiscover, SPF/DKIM
- SSL certs are issued by NPMplus and shared to Mailcow via Docker volume + symlinks
- Symlinks are dangling on host (point to `/npm-data/...`) but resolve inside containers
- `update.sh` may warn about symlinks — this is harmless
- See `docs/guide.md` for detailed troubleshooting
