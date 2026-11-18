#!/usr/bin/env bash
# Starts SalonOS (API, worker, web) in a GitHub Codespace against the staging database on Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."

if curl -sf -o /dev/null http://localhost:5173; then
  echo "SalonOS is already running: open the Ports tab and click the globe next to 'SalonOS'."
  exit 0
fi

if [ -z "${DB_APP_PASSWORD:-}" ]; then
  cat <<'MSG'

SalonOS needs the staging database password to start. Add it once as a Codespaces secret:
  github.com/settings/codespaces  >  New secret
    Name:  DB_APP_PASSWORD
    Value: the salon_app password (the DB_APP_PASSWORD of the GitHub environment "staging")
    Repository access: ShantanuKyada/SaloonSaas
Then rebuild this codespace: Ctrl/Cmd+Shift+P  >  "Codespaces: Rebuild Container".

MSG
  exit 1
fi

node .devcontainer/write-env.mjs > .env
echo "Starting SalonOS against the staging database. It opens in a new tab when ready (sign in: owner@glow.test / Welcome@2026)."
exec npm run dev
