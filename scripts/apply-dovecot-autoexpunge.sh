#!/bin/bash
# Managed extra.conf blocks; apply (default), --check, --revert; -y skips confirmation.
# Reads the stack .env if present. MAILCOW_DIR defaults to /home/mailcow-dockerized.
# Changes require Docker and a running dovecot-mailcow. Backups are kept beside extra.conf.
# Reload can disconnect all IMAP/POP clients; schedule outside working hours.
set -euo pipefail
usage() { echo "Usage: $0 [apply|--check|--revert] [-y]"; }
for arg in "$@"; do
    case "$arg" in
        apply|--check|--revert|-y) ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi
MAILCOW_DIR="${MAILCOW_DIR:-/home/mailcow-dockerized}"
CONF_DIR="$MAILCOW_DIR/data/conf/dovecot"
EXTRA_CONF="$CONF_DIR/extra.conf"
NAME="$(basename "$0" .sh)"
log() { echo "[$NAME] $*"; }
die() { echo "[$NAME] ERROR: $*" >&2; exit 1; }
MODE=apply
YES=0
for arg in "$@"; do
    case "$arg" in
        apply) MODE=apply ;;
        --check) MODE=check ;;
        --revert) MODE=revert ;;
        -y) YES=1 ;;
        *) die "usage: $0 [apply|--check|--revert] [-y]" ;;
    esac
done
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/dovecot-ready.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/dovecot-ready.sh"
[ -d "$CONF_DIR" ] || die "Dovecot configuration directory not found: $CONF_DIR"
command -v docker >/dev/null 2>&1 || die "docker not found; nothing changed"
WORK=$(mktemp -d)
PENDING=0
HAD_EXTRA=0
[ ! -f "$EXTRA_CONF" ] || HAD_EXTRA=1
cleanup() {
    local rc=$?
    trap - EXIT
    if [ "$PENDING" -eq 1 ]; then
        if [ "$HAD_EXTRA" -eq 1 ]; then
            cp -p "$WORK/original" "$EXTRA_CONF"
        else
            rm -f "$EXTRA_CONF"
        fi
        restore_aux
        log "original files restored; backup retained: $BACKUP"
    fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$HAD_EXTRA" -eq 1 ]; then
    cp -p "$EXTRA_CONF" "$WORK/original"
else
    : > "$WORK/original"
fi
cp "$WORK/original" "$WORK/next"
dove() { (cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow "$@"); }
# Only exact, paired markers belonging to this script are accepted. Other scripts'
# blocks are opaque bytes. Prepending a new block preserves even a missing EOF newline.
edit_block() {
    local label="$1" desired="$2" begin end span first last
    begin="# BEGIN $label ($NAME.sh)"
    end="# END $label"
    span=$(awk -v B="$begin" -v E="$end" -v P="# BEGIN $label" '
        $0 == B { if (n++ || inside) bad=1; first=NR; inside=1; next }
        $0 == E { if (!inside || ends++) bad=1; last=NR; inside=0; next }
        index($0, P) == 1 || index($0, E) == 1 { bad=1 }
        END { if (bad || inside || n != ends) exit 1; print first+0, last+0 }
    ' "$WORK/next") || die "malformed or duplicate $label markers; nothing changed"
    read -r first last <<< "$span"
    if [ "$first" -eq 0 ]; then
        { cat "$desired"; cat "$WORK/next"; } > "$WORK/edit"
    else
        { head -n "$((first - 1))" "$WORK/next"; cat "$desired"; tail -n "+$((last + 1))" "$WORK/next"; } > "$WORK/edit"
    fi
    mv "$WORK/edit" "$WORK/next"
}
confirm_reload() {
    local answer
    [ "$YES" -eq 0 ] || return 0
    [ -t 0 ] || die "reload may disconnect IMAP/POP clients; use -y for non-interactive execution"
    read -r -p 'Reload Dovecot (may disconnect all IMAP/POP clients)? [y/N] ' answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "cancelled; nothing changed"
}
begin_change() {
    confirm_reload
    BACKUP=$(mktemp "$EXTRA_CONF.bak.$(date +%Y%m%d-%H%M%S).XXXXXX")
    cp -p "$WORK/original" "$BACKUP"
    log "backup: $BACKUP"
    PENDING=1
    cat "$WORK/next" > "$EXTRA_CONF"
    if [ "$HAD_EXTRA" -eq 0 ]; then chmod 644 "$EXTRA_CONF"; fi
}
finish_change() {
    dove doveconf -n > "$WORK/live" || die "doveconf rejected configuration"
    verify_live || die "effective configuration does not match; reload skipped"
    # A failed reload may have partially reached the daemon. Restore and reload
    # the original configuration before reporting the error.
    if ! dovecot_wait_master "$MAILCOW_DIR" || ! dove doveadm reload; then
        if [ "$HAD_EXTRA" -eq 1 ]; then cp -p "$WORK/original" "$EXTRA_CONF"; else rm -f "$EXTRA_CONF"; fi
        restore_aux
        PENDING=0
        dove doveadm reload || log "original reload failed; manual recovery required"
        die "reload failed; original files restored (backup: $BACKUP)"
    fi
    PENDING=0
    log "$MODE complete"
}
# MAIL_AUTOEXPUNGE_ENABLE defaults to false; false selects revert.
# MAIL_AUTOEXPUNGE_DAYS defaults to 30 and must be an integer from 1 to 365.
# Policy applies to every mail client, only to inbox/Junk and inbox/Trash.
restore_aux() { :; }
ENABLE="${MAIL_AUTOEXPUNGE_ENABLE:-false}"
DAYS="${MAIL_AUTOEXPUNGE_DAYS:-30}"
case "$ENABLE" in true|false) ;; *) die "MAIL_AUTOEXPUNGE_ENABLE must be true or false" ;; esac
[[ "$DAYS" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$DAYS))" -ge 1 ] && [ "$((10#$DAYS))" -le 365 ] \
    || die "MAIL_AUTOEXPUNGE_DAYS must be an integer from 1 to 365"
DAYS=$((10#$DAYS))
if [ "$MODE" = apply ] && [ "$ENABLE" = false ]; then MODE=revert; fi
: > "$WORK/block"
if [ "$MODE" != revert ]; then
    cat > "$WORK/block" <<EOF
# BEGIN mailstack autoexpunge (apply-dovecot-autoexpunge.sh)
namespace inbox {
  mailbox Junk {
    autoexpunge = ${DAYS}d
  }
  mailbox Trash {
    autoexpunge = ${DAYS}d
  }
}
# END mailstack autoexpunge
EOF
fi
# Inspect only inbox/Junk and inbox/Trash; other mailbox policies are independent.
policy_values() {
    awk '
        /^[[:space:]]*namespace inbox \{/ { inbox=1; depth=1; next }
        inbox && /^[[:space:]]*mailbox / {
            box=$0; sub(/^[[:space:]]*mailbox /,"",box); sub(/ \{.*/,"",box); gsub(/"/,"",box)
        }
        inbox && /\{/ { depth++ }
        inbox && /\}/ { depth--; if (depth == 1) box=""; if (!depth) inbox=0 }
        inbox && (box == "Junk" || box == "Trash") && /^[[:space:]]*autoexpunge[[:space:]]*=/ {
            value=$0; sub(/^[^=]*=[[:space:]]*/,"",value); sub(/[[:space:]]*#.*/,"",value)
            print box "=" value
        }
    ' "$1"
}
# Remove our block first to detect pre-existing policy conflicts before any write.
: > "$WORK/empty"
edit_block 'mailstack autoexpunge' "$WORK/empty"
if [ -n "$(policy_values "$WORK/next")" ]; then
    die "inbox/Junk or inbox/Trash autoexpunge exists outside the managed block; resolve manually"
fi
# Included mailcow files may also carry a policy. Inspect the effective baseline
# on the first apply, before introducing our block.
if [ "$MODE" = apply ] && ! grep -qFx '# BEGIN mailstack autoexpunge (apply-dovecot-autoexpunge.sh)' "$WORK/original"; then
    dove doveconf -n > "$WORK/baseline" || die "cannot read existing configuration"
    if policy_values "$WORK/baseline" | grep -Eq '=[1-9]'; then
        die "effective inbox/Junk or inbox/Trash autoexpunge already exists; resolve manually"
    fi
fi
cp "$WORK/original" "$WORK/next"
edit_block 'mailstack autoexpunge' "$WORK/block"
verify_live() {
    if [ "$MODE" = revert ]; then return 0; fi
    policy_values "$WORK/live" | awk -F= -v days="$DAYS" '
        function seconds(v, n, a, i, total, unit) {
            if (v ~ /^[0-9]+d$/) return (v+0)*86400
            n=split(v,a," "); total=0
            if (n == 1 && a[1] ~ /^[0-9]+$/) return a[1]+0
            if (n % 2) return -1
            for (i=1; i<n; i+=2) {
                if (a[i] !~ /^[0-9]+$/) return -1
                unit=a[i+1]
                if (unit ~ /^weeks?$/) total+=a[i]*604800
                else if (unit ~ /^days?$/) total+=a[i]*86400
                else if (unit ~ /^hours?$/) total+=a[i]*3600
                else if (unit ~ /^mins?$/) total+=a[i]*60
                else if (unit ~ /^secs?$/) total+=a[i]
                else return -1
            }
            return total
        }
        seconds($2) == days*86400 { ok[$1]++ }
        END { exit !(ok["Junk"] == 1 && ok["Trash"] == 1) }
    '
}
if [ "$MODE" = check ]; then
    [ "$ENABLE" = true ] || die "autoexpunge is disabled"
    cmp -s "$WORK/original" "$WORK/next" || die "managed block differs"
    dove doveconf -n > "$WORK/live" || die "doveconf failed"
    verify_live || die "effective Junk/Trash autoexpunge differs"
    log "applied ($DAYS days, Junk and Trash)"
    exit 0
fi
if cmp -s "$WORK/original" "$WORK/next"; then log "already $MODE; no changes"; exit 0; fi
begin_change
finish_change
