#!/bin/bash
# ============================================================
# apply-toolkit-data-mount.sh
#
# Give an EXISTING install the persistent data mount the Toolkit's team
# distribution screen needs: /home/mailcow-toolkit/data -> /data in the
# toolkit-mailcow container. The screen writes one backup line per filter
# change to /data/filter-backups/YYYY-MM.jsonl before it saves.
#
# What it does (idempotent):
#   1. creates $TOOLKIT_DIR/data/filter-backups (mode 0700)
#   2. adds "- /home/mailcow-toolkit/data:/data" under the toolkit-mailcow
#      service's volumes in $MAILCOW_DIR/docker-compose.override.yml, only if
#      that mount is not there yet. Everything else in the override is kept
#      as is; the original is copied to docker-compose.override.yml.bak.<time>
#      first, and restored if "docker compose config" rejects the result.
#      "docker compose config" must pass BEFORE the edit too (and docker must be
#      present); otherwise nothing is changed and the script fails. Overrides
#      whose toolkit volumes use the long form (type/source/target), an inline
#      list, or already mount something at /data are refused: add the line by hand.
# It does NOT restart anything and does not run the full update.sh. Afterwards
# recreate only the Toolkit (mail services are not touched):
#   cd $MAILCOW_DIR && docker compose up -d --build toolkit-mailcow
#
# Rolling the Toolkit back by restoring its directory: keep
# $TOOLKIT_DIR/data (and data/filter-backups) -- it is the only copy of the
# pre-change filter scripts.
#
# Usage: apply-toolkit-data-mount.sh [apply|--check]
# Env:   MAILCOW_DIR (default /home/mailcow-dockerized)
#        TOOLKIT_DIR (default /home/mailcow-toolkit)
# Exit:  0 = ok (--check: mount and directory in place), non-zero = failure
# ============================================================
set -euo pipefail
usage() { echo "Usage: $0 [apply|--check]"; }
for arg in "$@"; do
    case "$arg" in
        apply|--check) ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done
[ "$#" -le 1 ] || { usage >&2; exit 2; }


MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
TOOLKIT_DIR="${TOOLKIT_DIR:-/home/mailcow-toolkit}"
OVERRIDE="$MAILCOW_DIR/docker-compose.override.yml"
SERVICE="toolkit-mailcow"
MOUNT_LINE="$TOOLKIT_DIR/data:/data"
DATA_DIR="$TOOLKIT_DIR/data"

log() { echo "[apply-toolkit-data-mount] $*"; }
die() { echo "[apply-toolkit-data-mount] ERROR: $*" >&2; exit 1; }

MODE=apply
case "${1:-apply}" in
    apply)   MODE=apply ;;
    --check) MODE=check ;;
    *) die "usage: $0 [apply|--check]" ;;
esac

[ -f "$OVERRIDE" ] || die "override not found: $OVERRIDE (run setup.sh for a fresh install)"

# Print the toolkit-mailcow service block (lines indented deeper than the key).
service_block() {
    awk -v svc="  $SERVICE:" '
        { line = $0; sub(/[ \t]+(#.*)?$/, "", line) }
        in_svc && $0 ~ /^[^ \t#]/ { exit }
        in_svc && $0 ~ /^  [^ \t#]/ { exit }
        in_svc { print }
        line == svc { in_svc = 1 }
    ' "$OVERRIDE"
}

has_mount() {
    service_block | grep -Eq "^[[:space:]]+-[[:space:]]*[\"']?${MOUNT_LINE//\//\\/}(:rw)?[\"']?[[:space:]]*(#.*)?\$"
}

grep -Eq "^  ${SERVICE}:[[:space:]]*(#.*)?\$" "$OVERRIDE" \
    || die "service '$SERVICE' not found in $OVERRIDE; add the mount by hand ($MOUNT_LINE)"

if [ "$MODE" = check ]; then
    rc=0
    if has_mount; then log "mount: present in override"; else log "mount: MISSING in override"; rc=1; fi
    if [ -d "$DATA_DIR/filter-backups" ]; then
        log "directory: $DATA_DIR/filter-backups exists ($(stat -c %a "$DATA_DIR/filter-backups"))"
    else
        log "directory: $DATA_DIR/filter-backups MISSING"; rc=1
    fi
    exit $rc
fi

# 1. the override must already be valid as seen by docker compose, or nothing is touched
compose_ok() { (cd "$MAILCOW_DIR" && docker compose config -q) >/dev/null 2>&1; }
command -v docker >/dev/null 2>&1 || die "docker not found; cannot validate the override, nothing changed"
compose_ok || die "'docker compose config' fails on the current override; fix it first, nothing changed"

mkdirs() {
    # the container runs as root, so a root-owned 0700 directory is writable
    mkdir -p "$DATA_DIR/filter-backups"
    chmod 700 "$DATA_DIR" "$DATA_DIR/filter-backups"
    log "directory ready: $DATA_DIR/filter-backups (0700)"
}

if has_mount; then
    mkdirs
    log "override already mounts $MOUNT_LINE; nothing to change"
    exit 0
fi

# 2. only a plain short-form volume list gets the new line
if service_block | grep -Eq ":/data(:[a-z]+)?[\"']?[[:space:]]*(#.*)?\$"; then
    die "$SERVICE already mounts something else at /data; resolve by hand"
fi
if service_block | grep -Eq '^    volumes:[[:space:]]*[^[:space:]#]'; then
    die "$SERVICE has an inline 'volumes:' value; add '- $MOUNT_LINE' by hand"
fi
if service_block | grep -Eq '^[[:space:]]*(-[[:space:]]+)?(type|source|target):([[:space:]]|$)'; then
    die "$SERVICE uses the long volume form (type/source/target); add '- $MOUNT_LINE' by hand"
fi

mkdirs
BAK="$OVERRIDE.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "$OVERRIDE" "$BAK"
TMP="$OVERRIDE.tmp.$$"
trap 'rm -f "$TMP"' EXIT

awk -v svc="  $SERVICE:" -v mount="$MOUNT_LINE" '
    { L[NR] = $0 }
    END {
        in_svc = 0; in_vol = 0; svc_last = 0; vol_key = 0; vol_last = 0; indent = "      "
        for (i = 1; i <= NR; i++) {
            line = L[i]; key = line; sub(/[ \t]+(#.*)?$/, "", key)
            if (!in_svc) { if (key == svc) { in_svc = 1; svc_last = i } continue }
            if (line ~ /^[^ \t#]/ || line ~ /^  [^ \t#]/) break
            if (line ~ /^[ \t]*(#.*)?$/) continue
            svc_last = i
            if (line ~ /^    volumes:[ \t]*(#.*)?$/) { in_vol = 1; vol_key = i; vol_last = i; continue }
            if (line ~ /^    [^ \t#]/) { in_vol = 0; continue }
            if (in_vol && line ~ /^[ \t]+-/) { vol_last = i; match(line, /^[ \t]+/); indent = substr(line, 1, RLENGTH) }
        }
        if (!svc_last) exit 1
        at = vol_key ? vol_last : svc_last
        for (i = 1; i <= NR; i++) {
            print L[i]
            if (i == at) {
                if (!vol_key) print "    volumes:"
                print indent "- " mount
            }
        }
    }
' "$OVERRIDE" > "$TMP" || die "could not edit override (backup kept: $BAK)"

cp "$TMP" "$OVERRIDE"
if ! compose_ok; then
    cp -p "$BAK" "$OVERRIDE"
    die "docker compose rejected the edited override; original restored (backup: $BAK)"
fi
has_mount || { cp -p "$BAK" "$OVERRIDE"; die "mount not found after edit; original restored (backup: $BAK)"; }
log "added $MOUNT_LINE to $SERVICE volumes (backup: $BAK)"
log "next: cd $MAILCOW_DIR && docker compose up -d --build $SERVICE   (mail services are not touched)"
