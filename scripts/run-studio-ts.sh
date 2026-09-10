#!/usr/bin/env bash
# Celestea Studio TS launcher (systemd): same env/data files as the Rust unit.
# Resolves CELESTEA_API_KEY from dsh credentials; never persists the key.
set -euo pipefail
cd /src/celestea_studio-ts
CKEY=$(sudo python3 -c "import yaml;print(yaml.safe_load(open('/opt/dsh/.credentials.yaml'))['refs']['CELESTEA_API_KEY'])" 2>/dev/null || true)
if [ -z "$CKEY" ]; then
  echo "[run-studio-ts] failed to resolve CELESTEA_API_KEY from /opt/dsh/.credentials.yaml" >&2
  exit 1
fi
export CELESTEA_API_KEY="$CKEY"
export CELESTEA_WORKSPACES_FILE="${CELESTEA_WORKSPACES_FILE:-/src/celestea_studio/workspaces.json}"
export CELESTEA_PROVIDERS_FILE="${CELESTEA_PROVIDERS_FILE:-/src/celestea_studio/providers.json}"
export CELESTEA_PROMPTS_FILE="${CELESTEA_PROMPTS_FILE:-/src/celestea_studio/prompts.json}"
export CELESTEA_SESSION_DIR="${CELESTEA_SESSION_DIR:-/src/celestea_studio/sessions}"
export CELESTEA_TOOL_ROOTS="${CELESTEA_TOOL_ROOTS:-/src/celestea_studio:/src/celestea_studio-ts:/src/celestea_harness:/tmp}"
export CELESTEA_SANDBOX_NET="${CELESTEA_SANDBOX_NET:-0}"
export STUDIO_STATIC_ROOT="${STUDIO_STATIC_ROOT:-/src/celestea_studio/frontend/dist}"
export STUDIO_TS_PORT="${STUDIO_TS_PORT:-3777}"
export STUDIO_TS_BIND="${STUDIO_TS_BIND:-127.0.0.1}"
exec pnpm --dir /src/celestea_studio-ts/apps/studio start