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
# WEBMAIL_ALLMAIL_EXCLUDE: comma-separated mailbox patterns; relay address from edge config.
# Revert removes webmail_virtual definitions, leaving user indexes untouched.
VIRTUAL_DIR="$CONF_DIR/webmail_virtual"
DEFINITION="$VIRTUAL_DIR/AllMail/dovecot-virtual"
# shellcheck source=lib/webmail-env.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/webmail-env.sh"
# Used by edge_load_config in the sourced library.
# shellcheck disable=SC2034
WEBMAIL_STACK_ENV="$PROJECT_DIR/.env"
if [ "$MODE" != revert ]; then edge_load_config || die "invalid edge configuration"; fi
WEBMAIL_ALLMAIL_EXCLUDE="${WEBMAIL_ALLMAIL_EXCLUDE:-}"
restore_aux() {
    rm -rf "$VIRTUAL_DIR"
    if [ -d "$WORK/virtual-original" ]; then cp -a "$WORK/virtual-original" "$VIRTUAL_DIR"; fi
}
if [ -d "$VIRTUAL_DIR" ]; then cp -a "$VIRTUAL_DIR" "$WORK/virtual-original"; fi
: > "$WORK/virtual"
: > "$WORK/trusted"
: > "$WORK/definition"
if [ "$MODE" != revert ]; then
    cat > "$WORK/trusted" <<EOF
# BEGIN mailstack-webmail trusted (apply-dovecot-webmail.sh)
login_trusted_networks = \$login_trusted_networks $WEBMAIL_RELAY_IPV4/32
# END mailstack-webmail trusted
EOF
    # 2026-09a: POP3/Sieve inherit global plugins; only IMAP/LMTP override them.
    cat > "$WORK/virtual" <<'EOF'
# BEGIN mailstack-webmail virtual (apply-dovecot-webmail.sh)
mail_plugins = $mail_plugins virtual
protocol imap {
  mail_plugins = $mail_plugins virtual
}
protocol lmtp {
  mail_plugins = $mail_plugins virtual
}
namespace webmail_virtual {
  prefix = WebmailVirtual/
  separator = /
  location = virtual:/etc/dovecot/webmail_virtual:INDEX=/var/vmail_index/%u/webmail_virtual:VOLATILEDIR=/var/volatile/%u
  list = no
  hidden = yes
  subscriptions = no
}
# END mailstack-webmail virtual
EOF
    cat > "$WORK/definition" <<'EOF'
INBOX
*
-Trash
-Junk
-Drafts
-WebmailVirtual/*
-Shared/*
EOF
    # Reject line/config injection. Surrounding spaces may be part of a mailbox name.
    [[ ! "$WEBMAIL_ALLMAIL_EXCLUDE" =~ [[:cntrl:]] ]] || die "WEBMAIL_ALLMAIL_EXCLUDE contains a control character"
    IFS=, read -r -a exclusions <<< "$WEBMAIL_ALLMAIL_EXCLUDE"
    for mailbox in "${exclusions[@]}"; do
        [ -z "$mailbox" ] || printf -- '-%s\n' "$mailbox" >> "$WORK/definition"
    done
    printf '  all\n' >> "$WORK/definition"
fi
edit_block 'mailstack-webmail virtual' "$WORK/virtual"
edit_block 'mailstack-webmail trusted' "$WORK/trusted"
verify_live() {
    [ "$MODE" != revert ] || return 0
    local protocol plugins word original
    for protocol in imap lmtp pop3; do
        plugins=$(dove doveconf -h -f "protocol=$protocol" mail_plugins) || return 1
        [[ " $plugins " == *' virtual '* ]] || return 1
        if [ -f "$WORK/plugins-$protocol" ]; then
            original=$(cat "$WORK/plugins-$protocol")
            for word in $original; do
                [[ " $plugins " == *" $word "* ]] || return 1
            done
        fi
    done
}
SAME=0
if cmp -s "$WORK/next" "$WORK/original"; then
    if [ "$MODE" = revert ]; then
        [ -d "$VIRTUAL_DIR" ] || SAME=1
    elif [ -f "$DEFINITION" ] && cmp -s "$WORK/definition" "$DEFINITION"; then
        SAME=1
    fi
fi
if [ "$MODE" = check ]; then
    [ "$SAME" -eq 1 ] || die "managed blocks or AllMail definition differ"
    dove doveconf -n > "$WORK/live" || die "doveconf failed"
    verify_live || die "virtual plugin is missing"
    log "applied (blocks, definition, effective protocol plugins)"
    exit 0
fi
if [ "$SAME" -eq 1 ]; then log "already $MODE; no changes"; exit 0; fi
if [ "$MODE" = apply ]; then
    for protocol in imap lmtp pop3; do
        dove doveconf -h -f "protocol=$protocol" mail_plugins > "$WORK/plugins-$protocol" || die "cannot read existing $protocol plugins"
    done
fi
begin_change
if [ "$MODE" = revert ]; then
    rm -rf "$VIRTUAL_DIR"
else
    mkdir -p "$VIRTUAL_DIR/AllMail"
    chmod 755 "$VIRTUAL_DIR" "$VIRTUAL_DIR/AllMail"
    if [ ! -f "$DEFINITION" ] || ! cmp -s "$WORK/definition" "$DEFINITION"; then
        cp "$WORK/definition" "$DEFINITION"
        chmod 644 "$DEFINITION"
    fi
fi
finish_change
