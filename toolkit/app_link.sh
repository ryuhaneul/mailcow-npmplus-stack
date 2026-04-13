#!/bin/bash
# Helper: add or remove Toolkit from Mailcow App Links (Redis)
# Usage: app_link.sh add|remove MAILCOW_DIR

ACTION="$1"
MAILCOW_DIR="$2"

REDIS_PASS=$(grep REDISPASS "$MAILCOW_DIR/mailcow.conf" | cut -d= -f2)
if [ -z "$REDIS_PASS" ]; then
  echo "WARN: REDISPASS not found"
  exit 1
fi

REDIS_CONTAINER=$(docker ps --format '{{.Names}}' | grep redis-mailcow | head -1)
if [ -z "$REDIS_CONTAINER" ]; then
  echo "WARN: Redis container not found"
  exit 1
fi

CURRENT=$(docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASS" GET APP_LINKS 2>/dev/null | grep -v "Warning")

if [ "$ACTION" = "add" ]; then
  if echo "$CURRENT" | grep -q "Toolkit"; then
    echo "already_exists"
    exit 0
  fi
  NEW_LINKS=$(python3 -c "
import json, sys
raw = sys.argv[1].strip() if len(sys.argv) > 1 else ''
try:
    links = json.loads(raw) if raw else []
except:
    links = []
links.append({'Toolkit': {'link': '/toolkit/', 'user_link': '/toolkit/', 'hide': False}})
print(json.dumps(links))
" "$CURRENT")
  docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASS" SET APP_LINKS "$NEW_LINKS" >/dev/null 2>&1
  echo "added"

elif [ "$ACTION" = "remove" ]; then
  if ! echo "$CURRENT" | grep -q "Toolkit"; then
    echo "not_found"
    exit 0
  fi
  NEW_LINKS=$(python3 -c "
import json, sys
raw = sys.argv[1].strip() if len(sys.argv) > 1 else ''
try:
    links = json.loads(raw) if raw else []
except:
    links = []
links = [l for l in links if 'Toolkit' not in l]
print(json.dumps(links))
" "$CURRENT")
  if [ "$NEW_LINKS" = "[]" ]; then
    docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASS" DEL APP_LINKS >/dev/null 2>&1
  else
    docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASS" SET APP_LINKS "$NEW_LINKS" >/dev/null 2>&1
  fi
  echo "removed"
fi
