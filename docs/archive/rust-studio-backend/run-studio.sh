#!/usr/bin/env bash
# Celestea Studio launcher (systemd): resolve API key from dsh credentials and exec the release binary.
set -euo pipefail
cd /src/celestea_studio
CKEY=$(sudo python3 -c "import yaml;print(yaml.safe_load(open('/opt/dsh/.credentials.yaml'))['refs']['CELESTEA_API_KEY'])" 2>/dev/null || true)
if [ -z "$CKEY" ]; then
  echo "[run-studio] failed to resolve CELESTEA_API_KEY from /opt/dsh/.credentials.yaml" >&2
  exit 1
fi
export CELESTEA_API_KEY="$CKEY"
export CELESTEA_SESSION_DIR="${CELESTEA_SESSION_DIR:-/src/celestea_studio/sessions}"
exec ./target/release/celestea-studio
