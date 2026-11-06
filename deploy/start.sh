#!/bin/sh
# Start command per service for the one workspace image: deploy/start.sh <service>
#   relayer-facilitator | relayer | paid-api | merchant-server | indexer-api
# The relayer variants also run the scheduled online database backup (see BACKUP_* below).
set -eu
cd /app
TSX=/app/node_modules/.bin/tsx

backup_loop() {
  dir="${BACKUP_DIR:-/data/backups}"
  every="${BACKUP_INTERVAL_SECONDS:-21600}"
  (
    cd /app/packages/relayer
    sleep 60
    while true; do
      BACKUP_DIR="$dir" BACKUP_KEEP="${BACKUP_KEEP:-14}" "$TSX" src/db-cli.ts backup || echo '{"msg":"scheduled backup failed"}'
      sleep "$every"
    done
  ) &
}

case "${1:-}" in
  relayer-facilitator)
    backup_loop
    cd packages/facilitator && exec "$TSX" src/main.ts ;;
  relayer)
    backup_loop
    cd packages/relayer && exec "$TSX" src/index.ts ;;
  paid-api)
    cd apps/paid-api && exec "$TSX" src/main.ts ;;
  merchant-server)
    cd apps/demo-store && exec "$TSX" server/index.ts ;;
  indexer-api)
    cd packages/indexer && exec "$TSX" src/api/main.ts ;;
  *)
    echo "usage: start.sh relayer-facilitator|relayer|paid-api|merchant-server|indexer-api" >&2
    exit 2 ;;
esac
