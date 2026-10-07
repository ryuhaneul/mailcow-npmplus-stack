#!/bin/bash
# ============================================================
# apply-dovecot-shared-index.sh
#
# Move the dovecot shared namespace INDEX out of the owner's maildir
# (INDEX=~/Maildir/Shared/%%u) to /var/vmail_index/%%u, so the first open of a
# shared folder reuses the owner's index/cache instead of rebuilding one.
#
# It also keeps the sort cache: a managed block in data/conf/dovecot/extra.conf sets
# mail_cache_unaccessed_field_drop = 3650 days. (Dovecot 2.3.11+: at purge, fields not
# accessed for that period go YES->TEMP and are dropped after twice that period; the
# default is 30 days. 3650 days is effectively "keep", not "never delete", and cache
# that is already gone is not restored.) Content of extra.conf outside the block is
# never modified.
#
# Usage:
#   apply-dovecot-shared-index.sh [apply]   write config, verify. A namespace change restarts
#                                           dovecot-mailcow; a cache-setting-only change
#                                           re-applies the config without a container restart
#                                           (doveadm reload; active IMAP/POP sessions reconnect)
#   apply-dovecot-shared-index.sh --revert  restore the stock include AND remove the extra.conf block
#                                           (to drop only the cache setting: delete the block by hand,
#                                           then doveadm reload)
#   apply-dovecot-shared-index.sh --check   report state only (no change, no restart/reload)
#
# If doveadm reload failed or was interrupted, a re-run does not reload again (the files
# already match): run "docker compose exec -T dovecot-mailcow doveadm reload" (or restart
# dovecot-mailcow) by hand.
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
EXTRA_CONF="$CONF_DIR/extra.conf"
BLOCK_BEGIN='# BEGIN mailcow-npmplus-stack (apply-dovecot-shared-index.sh)'
BLOCK_END='# END mailcow-npmplus-stack'
CACHE_KEY='mail_cache_unaccessed_field_drop'
CACHE_VALUE='3650 days'
CACHE_DEFAULT='30 days'

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

backup_file() {
    local bak
    bak="$1.bak-shared-index-$(date +%Y%m%d-%H%M%S)"
    cp -p "$1" "$bak"
    log "backup: $bak"
}

# Rewrite dovecot.conf in place (keeps inode/permissions) after a timestamped backup.
swap_include() {
    local from="$1" to="$2" tmp
    backup_file "$DOVECOT_CONF"
    tmp=$(mktemp)
    awk -v from="$from" -v to="$to" '$0 == from { print to; next } { print }' "$DOVECOT_CONF" > "$tmp"
    cat "$tmp" > "$DOVECOT_CONF"
    rm -f "$tmp"
}

# ---- extra.conf managed block (mail_cache_unaccessed_field_drop) ----

block_text() { printf '%s\n%s = %s\n%s\n' "$BLOCK_BEGIN" "$CACHE_KEY" "$CACHE_VALUE" "$BLOCK_END"; }

# Inspect extra.conf. Sets EXTRA_STATE (absent|none|same|different), EXTRA_L1/EXTRA_L2
# (first/last line of the block) and EXTRA_OUTKEY (non-comment lines outside the block
# that set the key). Dies — before anything has been changed — on a missing, duplicated
# or malformed marker.
extra_inspect() {
    EXTRA_STATE=absent; EXTRA_L1=0; EXTRA_L2=0; EXTRA_OUTKEY=0
    [ -f "$EXTRA_CONF" ] || return 0
    local res
    res=$(awk -v B="$BLOCK_BEGIN" -v E="$BLOCK_END" -v K="$CACHE_KEY" -v W="$CACHE_KEY = $CACHE_VALUE" '
        function bad(m) { if (err == "") err = m }
        $0 == B { if (nb++ || inb) bad("duplicate or nested BEGIN marker at line " NR); inb = 1; l1 = NR; nbody = 0; differ = 0; next }
        $0 == E { if (!inb) bad("END marker without BEGIN at line " NR); ne++; inb = 0; l2 = NR; next }
        index($0, "BEGIN mailcow-npmplus-stack") || index($0, "END mailcow-npmplus-stack") {
            bad("malformed marker at line " NR); next
        }
        inb { nbody++; if ($0 != W) differ = 1; next }
        $0 ~ ("^[ \t]*" K "[ \t]*=") { outkey++ }
        END {
            if (inb) bad("BEGIN marker at line " l1 " has no END marker")
            if (nb != ne) bad("BEGIN/END marker count mismatch (" nb "/" ne ")")
            if (err != "") { print "ERR " err; exit }
            st = (nb == 0) ? "none" : ((nbody == 1 && !differ) ? "same" : "different")
            print "OK " st " " l1 + 0 " " l2 + 0 " " outkey + 0
        }' "$EXTRA_CONF")
    case "$res" in
        "ERR "*) die "$EXTRA_CONF: ${res#ERR } — nothing was changed; fix the file manually" ;;
        "OK "*)  read -r _ EXTRA_STATE EXTRA_L1 EXTRA_L2 EXTRA_OUTKEY <<< "$res" ;;
        *)       die "could not inspect $EXTRA_CONF" ;;
    esac
}

extra_die_if_outside_key() {
    [ "$EXTRA_OUTKEY" -eq 0 ] || die "$EXTRA_CONF sets $CACHE_KEY outside the managed block — nothing was changed; remove or move that line manually"
}

# Write/replace the managed block. Everything outside it is kept byte for byte
# (head/tail copy the remaining lines unchanged).
extra_write_block() {
    local tmp
    case "$EXTRA_STATE" in
        absent)
            block_text > "$EXTRA_CONF"
            chmod 644 "$EXTRA_CONF"
            ;;
        none)
            backup_file "$EXTRA_CONF"
            # file without trailing newline: terminate its last line first
            [ -z "$(tail -c1 "$EXTRA_CONF")" ] || printf '\n' >> "$EXTRA_CONF"
            block_text >> "$EXTRA_CONF"
            ;;
        different)
            backup_file "$EXTRA_CONF"
            tmp=$(mktemp)
            { head -n $((EXTRA_L1 - 1)) "$EXTRA_CONF"; block_text; tail -n +$((EXTRA_L2 + 1)) "$EXTRA_CONF"; } > "$tmp"
            cat "$tmp" > "$EXTRA_CONF"
            rm -f "$tmp"
            ;;
    esac
}

extra_remove_block() {
    local tmp
    backup_file "$EXTRA_CONF"
    tmp=$(mktemp)
    { head -n $((EXTRA_L1 - 1)) "$EXTRA_CONF"; tail -n +$((EXTRA_L2 + 1)) "$EXTRA_CONF"; } > "$tmp"
    cat "$tmp" > "$EXTRA_CONF"
    rm -f "$tmp"
}

# verify_cache <expected value>: running dovecot reports the expected value.
verify_cache() {
    local expected="$1" out=""
    for _ in $(seq 1 15); do
        if out=$(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -h "$CACHE_KEY" 2>/dev/null | tr -d '\r') \
            && [ "$out" = "$expected" ]; then
            return 0
        fi
        sleep 2
    done
    log "live $CACHE_KEY: ${out:-<none>} (expected $expected)"
    return 1
}

reload_dovecot() {
    log "re-applying dovecot configuration without a container restart (doveadm reload; active IMAP/POP sessions reconnect)..."
    (cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveadm reload)
}

# Restart when the namespace changed (a restart re-reads everything); otherwise reload
# when only the cache setting changed.
apply_changes() {
    local ns="$1" cache="$2"
    if [ "$ns" -eq 1 ]; then
        restart_dovecot
    elif [ "$cache" -eq 1 ]; then
        reload_dovecot
    fi
}

N_ORIG=$(count_line "$INC_ORIG")
N_HC=$(count_line "$INC_HC")

case "$MODE" in
check)
    rc=0
    if [ "$N_HC" -eq 1 ] && [ "$N_ORIG" -eq 0 ] && [ -f "$HC_CONF" ]; then
        if verify_live "$LOC_HC"; then
            log "shared namespace INDEX: applied (config + running dovecot)"
        else
            log "shared namespace INDEX: NOT active — config is applied but running dovecot differs (restart needed?)"
            rc=1
        fi
    else
        log "shared namespace INDEX: not applied (stock shared_namespace.conf include)"
        rc=1
    fi
    extra_inspect
    if [ "$EXTRA_STATE" = same ] && [ "$EXTRA_OUTKEY" -eq 0 ]; then
        if verify_cache "$CACHE_VALUE"; then
            log "$CACHE_KEY: applied ($CACHE_VALUE, config + running dovecot)"
        else
            log "$CACHE_KEY: NOT active — block present but running dovecot differs (doveadm reload needed?)"
            rc=1
        fi
    else
        log "$CACHE_KEY: not applied (extra.conf block missing, outdated or conflicting key)"
        rc=1
    fi
    exit "$rc"
    ;;

apply)
    if [ "$N_HC" -eq 0 ] && [ "$N_ORIG" -eq 0 ]; then
        die "neither '$INC_ORIG' nor '$INC_HC' found in $DOVECOT_CONF"
    fi
    if [ "$N_HC" -gt 1 ] || [ "$N_ORIG" -gt 1 ] || { [ "$N_HC" -ge 1 ] && [ "$N_ORIG" -ge 1 ]; }; then
        die "unexpected include lines in $DOVECOT_CONF (orig=$N_ORIG, hc=$N_HC) — fix manually"
    fi
    # Validate everything before the first change.
    extra_inspect
    extra_die_if_outside_key

    changed_ns=0
    changed_cache=0
    if [ ! -f "$HC_CONF" ] || ! hc_content | cmp -s - "$HC_CONF"; then
        hc_content > "$HC_CONF"
        chmod 644 "$HC_CONF"
        log "wrote $HC_CONF"
        changed_ns=1
    fi
    if [ "$N_ORIG" -eq 1 ]; then
        swap_include "$INC_ORIG" "$INC_HC"
        log "dovecot.conf: include switched to shared_namespace_hc.conf"
        changed_ns=1
    fi
    if [ "$EXTRA_STATE" != same ]; then
        extra_write_block
        log "extra.conf: managed block written ($CACHE_KEY = $CACHE_VALUE)"
        changed_cache=1
    fi

    apply_changes "$changed_ns" "$changed_cache"
    verify_live "$LOC_HC" || die "namespace verification failed after apply (use --revert to roll back)"
    verify_cache "$CACHE_VALUE" || die "$CACHE_KEY verification failed after apply (use --revert to roll back)"
    if [ "$changed_ns" -eq 1 ] || [ "$changed_cache" -eq 1 ]; then
        log "applied: shared namespace INDEX=/var/vmail_index/%%u, $CACHE_KEY=$CACHE_VALUE"
    else
        log "already applied"
    fi
    ;;

revert)
    if [ "$N_HC" -eq 0 ] && [ "$N_ORIG" -eq 0 ]; then
        die "neither '$INC_ORIG' nor '$INC_HC' found in $DOVECOT_CONF"
    fi
    if [ "$N_HC" -gt 1 ] || [ "$N_ORIG" -gt 1 ] || { [ "$N_HC" -ge 1 ] && [ "$N_ORIG" -ge 1 ]; }; then
        die "unexpected include lines in $DOVECOT_CONF (orig=$N_ORIG, hc=$N_HC) — fix manually"
    fi
    extra_inspect
    has_block=0
    [ "$EXTRA_STATE" = none ] || [ "$EXTRA_STATE" = absent ] || has_block=1
    [ "$has_block" -eq 0 ] || extra_die_if_outside_key

    changed_ns=0
    changed_cache=0
    if [ "$N_HC" -eq 1 ]; then
        swap_include "$INC_HC" "$INC_ORIG"
        log "dovecot.conf: include restored to shared_namespace.conf"
        changed_ns=1
    fi
    if [ "$has_block" -eq 1 ]; then
        extra_remove_block
        log "extra.conf: managed block removed (other content kept)"
        changed_cache=1
    fi

    apply_changes "$changed_ns" "$changed_cache"
    verify_live "$LOC_ORIG" || die "namespace verification failed after revert"
    if [ "$has_block" -eq 1 ]; then
        verify_cache "$CACHE_DEFAULT" || die "$CACHE_KEY did not return to $CACHE_DEFAULT after revert"
    fi
    if [ "$changed_ns" -eq 1 ] || [ "$changed_cache" -eq 1 ]; then
        log "reverted: stock shared namespace restored, extra.conf block removed"
    else
        log "already reverted"
    fi
    ;;
esac
