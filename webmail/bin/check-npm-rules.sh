#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
violations=0
scan() {
  local pattern=$1
  shift
  local result=0
  grep -rnE "$pattern" "$@" || result=$?
  case "$result" in
    0) violations=1 ;;
    1) ;;
    *) exit "$result" ;;
  esac
}
sources=(server)
[[ ! -d web/src ]] || sources+=(web/src)
scan '\b401\b|WWW-Authenticate' "${sources[@]}"
scan "headers[[:space:]]*(\.[[:space:]]*[aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN]|\[[[:space:]]*['\"][aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN])" server/routes server/security
if (( violations )); then
  echo 'R-NPM: 위반 발견' >&2
  exit 1
fi
echo 'R-NPM: 0건'
