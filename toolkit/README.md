# Mailcow Toolkit

Modular management tools for Mailcow, served as a sidecar container with Mailcow authentication.

## Modules

- **Groups** — Visual alias-based mail group management (inbound addresses → group → members)
- **Sync Jobs** — Batch create and monitor IMAP sync jobs

## Installation (Integrated)

```bash
cd /home
git clone <repo-url> mailcow-toolkit
cd mailcow-toolkit
cp config.yml.example config.yml
vi config.yml   # Set your Mailcow API key
chmod +x install.sh uninstall.sh
./install.sh    # Auto-detects mailcow directory
```

Access at: `https://<your-mailcow-domain>/toolkit/`

## Installation (Standalone)

```bash
git clone <repo-url> mailcow-toolkit
cd mailcow-toolkit
cp config.yml.example config.yml
vi config.yml   # Set api_url and api_key
docker compose up -d
```

Access at: `http://localhost:5100/`

## After Mailcow Update

```bash
cd /home/mailcow-toolkit
./install.sh --check          # Verify everything is intact
./install.sh --check --repair # Auto-fix if broken
```

## Uninstall

```bash
cd /home/mailcow-toolkit
./uninstall.sh
```

## Adding Modules

1. Create `app/modules/your_module.py` (Flask Blueprint)
2. Add templates and static files
3. Register in `main.py`
4. Add to `config.yml` modules list
