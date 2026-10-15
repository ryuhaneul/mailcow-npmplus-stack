#!/usr/bin/env bash
set -euo pipefail
webmail_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$webmail_dir/.."
# 패턴 자체가 검출되지 않도록 글자 하나를 문자 클래스로 표기한다.
pattern='host[c]enter|h[m]aster|hc[m]ail|nuri[c]loud'
result=0
grep -rniE --exclude-dir=node_modules --exclude-dir=.git "$pattern" webmail scripts .env.example docs README.md || result=$?
case "$result" in
  0) echo 'R-GENERIC: 위반 발견' >&2; exit 1 ;;
  1) echo 'R-GENERIC: 0건' ;;
  *) exit "$result" ;;
esac
