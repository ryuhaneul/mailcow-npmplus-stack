#!/bin/bash
# Shared deployment API (source after/before webmail-env.sh):
# log_archive_prepare <repository root>: generate env, start independent project,
#   wait for required-source backfill. Config must already be loaded.
# log_archive_wait_backfill: bounded readiness check (30 seconds).
# log_archive_stop_and_drain <compose directory> <service>...: backfill first,
#   stop and drain; success leaves targets stopped for caller's replacement.
# log_archive_restore: start only IDs that this transaction found running.
# log_archive_release: forget saved IDs after successful replacement.
# Callers MUST trap failure/INT/TERM and call restore, then release after success.
# Multiple stop_and_drain calls may accumulate one transaction's running set.
# OFF is a no-op. No helper prints keys, source paths or raw API responses.
if [ "${LOG_ARCHIVE_LIB_LOADED:-false}" = true ]; then return 0; fi
LOG_ARCHIVE_LIB_LOADED=true
declare -a LOG_ARCHIVE_RUNNING_IDS=()

log_archive_error() { echo "[log-archive] ERROR: $*" >&2; return 1; }

log_archive_validate_sources() {
    local source seen=,
    local -a sources
    IFS=, read -r -a sources <<< "${LOG_ARCHIVE_REQUIRED_SOURCES:-}"
    [ "${#sources[@]}" -gt 0 ] && [[ "$LOG_ARCHIVE_REQUIRED_SOURCES" != *, ]] || { log_archive_error 'invalid required sources'; return 1; }
    for source in "${sources[@]}"; do
        case "$source" in postfix|dovecot|rspamd|php-fpm|nginx|webmail|webmail-admin|npmplus) ;; *) log_archive_error 'invalid required sources'; return 1 ;; esac
        case "$seen" in *",$source,"*) log_archive_error 'duplicate required source'; return 1 ;; esac
        seen+="$source,"
    done
}

log_archive_ensure_key() {
    set +x
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    if [ -n "${LOG_ARCHIVE_KEY:-}" ]; then
        [[ "$LOG_ARCHIVE_KEY" =~ ^[A-Za-z0-9_+/=.-]+$ ]] || { log_archive_error 'invalid shared key'; return 1; }
        chmod 600 "$WEBMAIL_STACK_ENV" || return 1
        return 0
    fi
    LOG_ARCHIVE_KEY=$(openssl rand -hex 32) || return 1
    local tmp line found=0
    tmp=$(mktemp "$WEBMAIL_STACK_ENV.tmp.XXXXXX") || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^(export[[:space:]]+)?LOG_ARCHIVE_KEY= ]]; then
            if [ "$found" -eq 0 ]; then printf 'LOG_ARCHIVE_KEY=%s\n' "$LOG_ARCHIVE_KEY"; found=1; fi
        else printf '%s\n' "$line"; fi
    done < "$WEBMAIL_STACK_ENV" > "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$found" -eq 0 ]; then printf 'LOG_ARCHIVE_KEY=%s\n' "$LOG_ARCHIVE_KEY" >> "$tmp" || { rm -f "$tmp"; return 1; }; fi
    if ! chmod 600 "$tmp" || ! mv "$tmp" "$WEBMAIL_STACK_ENV"; then rm -f "$tmp"; return 1; fi
}

log_archive_generate_env() (
    set +x
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    local dest="$1" tmp docker_root npm_volume
    log_archive_ensure_key && log_archive_validate_sources || return 1
    docker_root=$(docker info --format '{{.DockerRootDir}}') || return 1
    [[ "$docker_root" = /* ]] || { log_archive_error 'invalid Docker data root'; return 1; }
    if docker inspect npmplus >/dev/null 2>&1; then
        npm_volume=$(docker inspect npmplus --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}') || return 1
    else
        npm_volume=$(docker volume inspect npmplus_npmplus-data --format '{{.Name}}' 2>/dev/null) \
            || { log_archive_error 'NPMplus container and pre-created data volume unavailable'; return 1; }
        [ "$npm_volume" = npmplus_npmplus-data ] || { log_archive_error 'unexpected pre-created NPMplus data volume'; return 1; }
    fi
    [[ "$npm_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { log_archive_error 'NPMplus data volume unavailable'; return 1; }
    mkdir -p "$dest" || return 1
    tmp=$(mktemp "$dest/.archive-env.XXXXXX") || return 1
    trap 'rm -f "$tmp"' EXIT
    {
        webmail_env_line LOG_ARCHIVE_KEY "$LOG_ARCHIVE_KEY" &&
        webmail_env_line LOG_ARCHIVE_REQUIRED_SOURCES "$LOG_ARCHIVE_REQUIRED_SOURCES" &&
        webmail_env_line LOG_ARCHIVE_COLLECT_INTERVAL_MS 1000 &&
        webmail_env_line LOG_ARCHIVE_MAILCOW_PROJECT mailcowdockerized &&
        webmail_env_line LOG_ARCHIVE_WEBMAIL_PROJECT webmail
    } > "$tmp" || return 1
    {
        webmail_env_line LOG_ARCHIVE_DOCKER_CONTAINERS "${docker_root%/}/containers" &&
        webmail_env_line LOG_ARCHIVE_NPMPLUS_VOLUME "$npm_volume"
    } >> "$tmp" || return 1
    chmod 600 "$tmp" && mv "$tmp" "$dest/.env"
)

# Key stays inside archiver's environment, never in argv or host stdout.
log_archive_status() {
    local budget="${1:-3}"
    [ "$budget" -le 3 ] || budget=3
    timeout "${budget}s" docker exec -i log-archiver node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
try {
  const key = process.env.LOG_ARCHIVE_KEY_FILE ? (await readFile(process.env.LOG_ARCHIVE_KEY_FILE, 'utf8')).trim() : process.env.LOG_ARCHIVE_KEY;
  const r = await fetch('http://127.0.0.1:8080/v1/status', { headers: { 'X-Log-Archive-Key': key }, signal: AbortSignal.timeout(2000) });
  if (!r.ok) process.exit(1);
  process.stdout.write(await r.text());
} catch { process.exit(1); }
JS
}

# stdin JSON is intentionally parsed without printing upstream data/errors.
log_archive_check_status() {
    python3 -c '
import json,sys,datetime
try:
 s=json.load(sys.stdin)
 if sys.argv[1]=="backfill":
  required=sys.argv[2].split(",")
  assert s.get("backfillComplete") is True and not s.get("issues")
  assert all(any(g.get("source")==source and g.get("visible") is True for g in s["generations"]) for source in required)
 else:
  source,instance,count,after=sys.argv[2:]
  stamp=datetime.datetime.fromisoformat(s["observedAt"].replace("Z","+00:00")).timestamp()
  assert stamp>float(after)+2
  generations=[g for g in s["generations"] if g.get("source")==source and g.get("instance")==instance]
  assert generations and all(g.get("pendingBytes")==0 and g.get("offset")==g.get("observedSize") for g in generations)
  assert sum(g.get("visible") is True for g in generations)==int(count)
  assert not any(i.get("source")==source for i in s.get("issues",[]))
except Exception: sys.exit(1)
' "$@"
}

log_archive_wait_backfill() {
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    local deadline=$((SECONDS + 30))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if log_archive_status "$((deadline - SECONDS))" | log_archive_check_status backfill "$LOG_ARCHIVE_REQUIRED_SOURCES"; then return 0; fi
        if [ "$SECONDS" -lt "$deadline" ]; then sleep 1; fi
    done
    log_archive_error 'backfill not ready within 30 seconds'
}

log_archive_prepare() {
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    local dest="${LOG_ARCHIVE_DIR:-$1/log-archiver}"
    log_archive_generate_env "$dest" || return 1
    (cd "$dest" && docker compose -p log-archiver -f compose.yml up -d --build) || return 1
    log_archive_wait_backfill
}

log_archive_restore() {
    local id failed=0
    for id in "${LOG_ARCHIVE_RUNNING_IDS[@]}"; do
        docker start "$id" >/dev/null || failed=1
    done
    [ "$failed" -eq 0 ] || log_archive_error 'could not restore original running set'
}
log_archive_release() { LOG_ARCHIVE_RUNNING_IDS=(); }

# Count only the exact numeric uncompressed rotations the collector supports.
log_archive_file_count() {
    python3 - "$1" <<'PY'
import pathlib,re,sys
try:
 p=pathlib.Path(sys.argv[1])
 files=[f for f in p.parent.iterdir() if f.is_file() and (f.name==p.name or re.fullmatch(re.escape(p.name)+r'\.[1-9][0-9]*',f.name))]
 if not files: raise ValueError()
 print(len(files))
except Exception: sys.exit(1)
PY
}

log_archive_stop_and_drain() {
    [ "${LOG_ARCHIVE_ENABLE:-false}" = true ] || return 0
    local dir="$1" service source ids id running path count after deadline instance
    shift
    log_archive_wait_backfill || { log_archive_restore; return 1; }
    for service in "$@"; do
        case "$service" in
            postfix-mailcow|dovecot-mailcow|rspamd-mailcow|php-fpm-mailcow|nginx-mailcow) source=${service%-mailcow} ;;
            webmail|webmail-admin|npmplus) source=$service ;;
            *) log_archive_error 'unsupported drain service'; log_archive_restore; return 1 ;;
        esac
        ids=$(cd "$dir" && docker compose --profile admin ps -a -q "$service") || { log_archive_restore; return 1; }
        for id in $ids; do
            id=$(docker inspect "$id" --format '{{.Id}}') || { log_archive_restore; return 1; }
            running=$(docker inspect "$id" --format '{{.State.Running}}') || { log_archive_restore; return 1; }
            if [ "$running" = true ]; then
                LOG_ARCHIVE_RUNNING_IDS+=("$id")
                if ! timeout 30s docker stop "$id" >/dev/null; then log_archive_restore; return 1; fi
            fi
            after=$(date +%s.%N)
            instance=$id
            if [ "$source" = npmplus ]; then
                instance=npmplus
                path=$(docker inspect "$id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}') || { log_archive_restore; return 1; }
                path="$path/nginx/logs/access.log"
            else
                path=$(docker inspect "$id" --format '{{.LogPath}}') || { log_archive_restore; return 1; }
            fi
            count=$(log_archive_file_count "$path") || { log_archive_error 'source files unavailable'; log_archive_restore; return 1; }
            deadline=$((SECONDS + 30))
            while [ "$SECONDS" -lt "$deadline" ]; do
                if log_archive_status "$((deadline - SECONDS))" | log_archive_check_status drain "$source" "$instance" "$count" "$after"; then break; fi
                if [ "$SECONDS" -lt "$deadline" ]; then sleep 1; fi
            done
            if [ "$SECONDS" -ge "$deadline" ]; then log_archive_error 'drain not confirmed within 30 seconds'; log_archive_restore; return 1; fi
        done
    done
    # Count + fresh status cannot prove identity when rotation exactly overlaps
    # the stop boundary. Managed replacement has this explicit limitation.
}
