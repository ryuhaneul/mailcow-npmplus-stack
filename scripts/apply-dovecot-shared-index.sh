#!/bin/bash
# ============================================================
# apply-dovecot-shared-index.sh
#
# Move the dovecot shared namespace INDEX out of the owner's maildir
# (INDEX=~/Maildir/Shared/%%u) to /var/vmail_index/%%u, so the first open of a
# shared folder reuses the owner's index/cache instead of rebuilding one.
#
# Usage:
#   apply-dovecot-shared-index.sh [apply]   write config, restart dovecot if changed, verify
#   apply-dovecot-shared-index.sh --revert  restore the stock mailcow include, restart, verify
#   apply-dovecot-shared-index.sh --check   report state only (no change, no restart)
#
# Env: MAILCOW_DIR (default /home/mailcow-dockerized)
# Exit: 0 = ok (--check: applied), non-zero = failure (--check: not applied)
# ============================================================
set -euo pipefail

MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
CONF_DIR="$MAILCOW_DIR/data/conf/dovecot"
DOVECOT_CONF="$CONF_DIR/dovecot.conf"
HC_CONF="$CONF_DIR/shared_namespace_hc.conf"
INC_ORIG='!include_try /etc/dovecot/shared_namespace.conf'
INC_HC='!include_try /etc/dovecot/shared_namespace_hc.conf'

log() { echo "[apply-dovecot-shared-index] $*"; }
die() { echo "[apply-dovecot-shared-index] ERROR: $*" >&2; exit 1; }

MODE=apply
case "${1:-apply}" in
    apply)    MODE=apply ;;
    --revert) MODE=revert ;;
    --check)  MODE=check ;;
    *) die "usage: $0 [apply|--revert|--check]" ;;
esac

[ -f "$DOVECOT_CONF" ] || die "dovecot.conf not found: $DOVECOT_CONF"
[ -f "$MAILCOW_DIR/mailcow.conf" ] || die "mailcow.conf not found: $MAILCOW_DIR/mailcow.conf"

# MAILDIR_SUB (empty = maildir at the home root); same rule as mailcow's entrypoint
MAILDIR_SUB=$(sed -n 's/^MAILDIR_SUB=//p' "$MAILCOW_DIR/mailcow.conf" | tail -n1 | tr -d '"'"'"'\r')
MAILDIR_SUB_SHARED=""
[ -n "$MAILDIR_SUB" ] && MAILDIR_SUB_SHARED="/$MAILDIR_SUB"

LOC_HC="maildir:%%h${MAILDIR_SUB_SHARED}:INDEX=/var/vmail_index/%%u:VOLATILEDIR=/var/volatile/%%u"
LOC_ORIG="maildir:%%h${MAILDIR_SUB_SHARED}:INDEX=~${MAILDIR_SUB_SHARED}/Shared/%%u"

hc_content() {
    printf '%s\n' \
        '# Managed by mailcow-npmplus-stack (apply-dovecot-shared-index.sh)' \
        'namespace {' \
        '    type = shared' \
        '    separator = /' \
        '    prefix = Shared/%%u/' \
        "    location = ${LOC_HC}" \
        '    subscriptions = no' \
        '    list = children' \
        '}'
}

count_line() { grep -cFx -- "$1" "$DOVECOT_CONF" || true; }

# Print location of every shared namespace in the running dovecot config.
live_shared_locations() {
    (cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -n) | awk '
        /^namespace .*\{[ \t]*$/ { inns=1; depth=1; type=""; loc=""; next }
        inns && /\{[ \t]*$/      { depth++; next }
        inns && /^[ \t]*\}[ \t]*$/ {
            depth--
            if (depth == 0) { if (type == "shared") print loc; inns=0 }
            next
        }
        inns && depth == 1 && /^[ \t]+type = /     { sub(/^[ \t]+type = /, ""); type=$0 }
        inns && depth == 1 && /^[ \t]+location = / { sub(/^[ \t]+location = /, ""); loc=$0 }
    '
}

# verify_live <expected location>: exactly one shared namespace with that location.
verify_live() {
    local expected="$1" out="" n
    for _ in $(seq 1 15); do
        if out=$(live_shared_locations 2>/dev/null); then
            n=$(printf '%s\n' "$out" | grep -c . || true)
            if [ "$n" -eq 1 ] && [ "$out" = "$expected" ]; then
                return 0
            fi
        fi
        sleep 2
    done
    log "live shared namespaces (${n:-0}): ${out:-<none>}"
    log "expected one with location = $expected"
    return 1
}

restart_dovecot() {
    log "restarting dovecot-mailcow..."
    (cd "$MAILCOW_DIR" && docker compose restart dovecot-mailcow)
}

# Rewrite dovecot.conf in place (keeps inode/permissions) after a timestamped backup.
swap_include() {
    local from="$1" to="$2" bak tmp
    bak="$DOVECOT_CONF.bak-shared-index-$(date +%Y%m%d-%H%M%S)"
    cp -p "$DOVECOT_CONF" "$bak"
    log "backup: $bak"
    tmp=$(mktemp)
    awk -v from="$from" -v to="$to" '$0 == from { print to; next } { print }' "$DOVECOT_CONF" > "$tmp"
    cat "$tmp" > "$DOVECOT_CONF"
    rm -f "$tmp"
}

N_ORIG=$(count_line "$INC_ORIG")
N_HC=$(count_line "$INC_HC")

case "$MODE" in
check)
    if [ "$N_HC" -eq 1 ] && [ "$N_ORIG" -eq 0 ] && [ -f "$HC_CONF" ]; then
        if verify_live "$LOC_HC"; then
            log "applied (config + running dovecot)"
            exit 0
        fi
        log "NOT active: config is applied but running dovecot differs (restart needed?)"
        exit 1
    fi
    log "not applied (stock shared_namespace.conf include)"
    exit 1
    ;;

apply)
    changed=0
    if [ "$N_HC" -eq 0 ] && [ "$N_ORIG" -eq 0 ]; then
        die "neither '$INC_ORIG' nor '$INC_HC' found in $DOVECOT_CONF"
    fi
    if [ "$N_HC" -gt 1 ] || [ "$N_ORIG" -gt 1 ] || { [ "$N_HC" -ge 1 ] && [ "$N_ORIG" -ge 1 ]; }; then
        die "unexpected include lines in $DOVECOT_CONF (orig=$N_ORIG, hc=$N_HC) — fix manually"
    fi

    if [ ! -f "$HC_CONF" ] || ! hc_content | cmp -s - "$HC_CONF"; then
        hc_content > "$HC_CONF"
        chmod 644 "$HC_CONF"
        log "wrote $HC_CONF"
        changed=1
    fi
    if [ "$N_ORIG" -eq 1 ]; then
        swap_include "$INC_ORIG" "$INC_HC"
        log "dovecot.conf: include switched to shared_namespace_hc.conf"
        changed=1
    fi

    [ "$changed" -eq 1 ] && restart_dovecot
    verify_live "$LOC_HC" || die "verification failed after apply (use --revert to roll back)"
    if [ "$changed" -eq 1 ]; then
        log "applied: shared namespace INDEX=/var/vmail_index/%%u"
    else
        log "already applied"
    fi
    ;;

revert)
    changed=0
    if [ "$N_HC" -eq 0 ] && [ "$N_ORIG" -eq 0 ]; then
        die "neither '$INC_ORIG' nor '$INC_HC' found in $DOVECOT_CONF"
    fi
    if [ "$N_HC" -gt 1 ] || [ "$N_ORIG" -gt 1 ] || { [ "$N_HC" -ge 1 ] && [ "$N_ORIG" -ge 1 ]; }; then
        die "unexpected include lines in $DOVECOT_CONF (orig=$N_ORIG, hc=$N_HC) — fix manually"
    fi
    if [ "$N_HC" -eq 1 ]; then
        swap_include "$INC_HC" "$INC_ORIG"
        log "dovecot.conf: include restored to shared_namespace.conf"
        changed=1
    fi
    [ "$changed" -eq 1 ] && restart_dovecot
    verify_live "$LOC_ORIG" || die "verification failed after revert"
    if [ "$changed" -eq 1 ]; then
        log "reverted: stock shared namespace restored"
    else
        log "already reverted"
    fi
    ;;
esac
