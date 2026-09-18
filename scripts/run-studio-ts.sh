#!/usr/bin/env bash
# Celestea Studio TS launcher (systemd): same env/data files as the retired unit.
# Resolves CELESTEA_API_KEY from dsh credentials; never persists the key.
#
# W781（2026-09-14）：前端/后端已并成同一仓，运行数据移出仓外。
#   代码   /src/celestea_studio-ts      （唯一仓：apps/studio 后端 + apps/web 前端）
#   数据   /var/lib/celestea-agent      （0750 celestea:celesdev；密钥文件 0600）
#   前端产物 apps/web/dist              （STUDIO_STATIC_ROOT，先 `cd apps/web && pnpm build`）
set -euo pipefail

REPO=/src/celestea_studio-ts
DATA=/var/lib/celestea-agent

cd "$REPO"
CKEY=$(sudo python3 -c "import yaml;print(yaml.safe_load(open('/opt/dsh/.credentials.yaml'))['refs']['CELESTEA_API_KEY'])" 2>/dev/null || true)
if [ -z "$CKEY" ]; then
  echo "[run-studio-ts] failed to resolve CELESTEA_API_KEY from /opt/dsh/.credentials.yaml" >&2
  exit 1
fi
export CELESTEA_API_KEY="$CKEY"

# --- 运行数据（仓外，见 /var/lib/celestea-agent；providers.json / studio-auth.secret 为 0600） ---
export CELESTEA_WORKSPACES_FILE="${CELESTEA_WORKSPACES_FILE:-$DATA/workspaces.json}"
export CELESTEA_PROVIDERS_FILE="${CELESTEA_PROVIDERS_FILE:-$DATA/providers.json}"
export CELESTEA_PROMPTS_FILE="${CELESTEA_PROMPTS_FILE:-$DATA/prompts.json}"
export CELESTEA_SESSION_DIR="${CELESTEA_SESSION_DIR:-$DATA/sessions}"
export CELESTEA_AUTH_SECRET_FILE="${CELESTEA_AUTH_SECRET_FILE:-$DATA/studio-auth.secret}"
export CELESTEA_USAGE_LEDGER_FILE="${CELESTEA_USAGE_LEDGER_FILE:-$DATA/usage-ledger.jsonl}"

# --- 工具沙箱：本仓 + 引擎参考实现 + /tmp（读根白名单，fail-closed） ---
export CELESTEA_TOOL_ROOTS="${CELESTEA_TOOL_ROOTS:-$REPO:/src/celestea_harness:/tmp}"
export CELESTEA_TOOL_WORKDIR="${CELESTEA_TOOL_WORKDIR:-$REPO}"
export CELAESTEA_RUN_SHELL_WORKDIR="${CELAESTEA_RUN_SHELL_WORKDIR:-$REPO}"
# W9: the network now follows the session permission (default full-access =>
# --share-net). Force isolation with CELESTEA_PERMISSION_MAX=write-read instead.

# --- 前端静态根（Vite 产物） ---
export STUDIO_STATIC_ROOT="${STUDIO_STATIC_ROOT:-$REPO/apps/web/dist}"
export STUDIO_TS_PORT="${STUDIO_TS_PORT:-3777}"
export STUDIO_TS_BIND="${STUDIO_TS_BIND:-127.0.0.1}"

# --- W847 W0: fail-loud Node major guard (engines.node band) -----------------
# pnpm does NOT auto-run pre/post scripts by default (enable-pre-post-scripts
# defaults to false), so the guard lives on this production entry path instead of
# a prestart hook that could silently never fire. `set -e` stops us on a bad Node.
node "$REPO/scripts/check-node.mjs"

exec pnpm --dir "$REPO/apps/studio" start
