#!/bin/sh
# 사용: sh all.sh <프로젝트 루트> <이 폴더(윈도우 경로)>  — 네 가지 설정으로 차례로 잰다
S="$2"
cd "$1" || exit 1
up() { MAX_BATCH="$1" SPIN="$2" docker compose -f experiment/docker-compose.yml -f "$S/override.yml" up -d --wait >/dev/null 2>&1; sleep 3; docker compose -f experiment/docker-compose.yml logs app 2>&1 | tail -2; }
up "" "";  node "$S/run.mjs" . A-batch16 4
up 1 "";   node "$S/run.mjs" . B-batch1 4 short
up "" 1;   node "$S/run.mjs" . C-spin 4 short
up 1 1;    node "$S/run.mjs" . D-batch1-spin 3 short
up "" ""
echo ALL_DONE
