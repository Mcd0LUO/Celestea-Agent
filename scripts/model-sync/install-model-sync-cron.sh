#!/bin/bash
# install-model-sync-cron.sh — 部署两个「模型清单同步」定时任务（需 root 执行）。
#
# 装什么：
#   /etc/cron.d/celes-studio-models        每 30min 把 Studio providers 清单与网关实际可用模型对齐
#   /etc/cron.d/celes-sync-upstream-models 每 30min 把基元律动渠道 model 清单与上游 /v1/models 对齐
# 部署方式：脚本真源留在 /src/celestea_studio-ts/scripts/model-sync/，/server-center/runtime/bin/ 只放 symlink
#          （与 newapi-ops README 的约定一致）。
#
# 用法：  sudo bash /src/celestea_studio-ts/scripts/model-sync/install-model-sync-cron.sh
# 先干看：sudo bash ... --dry-run
set -euo pipefail

SRC=/src/celestea_studio-ts/scripts/model-sync
BIN=/server-center/runtime/bin
CRON=/etc/cron.d
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ "$(id -u)" = "0" ] || { echo "FATAL: 需要 root（cron.d / runtime/bin 都是 root 域）"; exit 1; }
[ -d "$SRC" ] || { echo "FATAL: 找不到 $SRC"; exit 1; }

files=(
  "sync-models.py:celes-studio-models"
  "sync-upstream-models.py:celes-sync-upstream-models"
)

for pair in "${files[@]}"; do
  script="${pair%%:*}"; cronname="${pair##*:}"
  src="$SRC/$script"; cronfile="$SRC/$cronname.cron"
  [ -f "$src" ] || { echo "FATAL: 缺脚本 $src"; exit 1; }
  [ -f "$cronfile" ] || { echo "FATAL: 缺 cron 模板 $cronfile"; exit 1; }

  # cron 不接受末行缺换行 —— 宁可在这里拦下，也不要静默失效（见 celes-price-sync 教训）
  if [ -n "$(tail -c1 "$cronfile")" ]; then
    echo "FATAL: $cronfile 末行缺少换行，cron 会忽略整个文件"
    exit 1
  fi

  echo "[plan] ln -sfn $src $BIN/$script"
  echo "[plan] install -m 0644 $cronfile $CRON/$cronname"
  if [ "$DRY" = "0" ]; then
    ln -sfn "$src" "$BIN/$script"
    chmod 0755 "$src"
    install -m 0644 "$cronfile" "$CRON/$cronname"
  fi
done

if [ "$DRY" = "1" ]; then
  echo "dry-run: 未做任何改动"
  exit 0
fi

echo "--- 已安装 ---"
ls -l "$BIN/sync-models.py" "$BIN/sync-upstream-models.py" "$CRON/celes-studio-models" "$CRON/celes-sync-upstream-models"

# 先跑一次 dry-run，把真实差异打出来（不写任何东西）
echo "--- dry-run: Studio 清单 ---"
/usr/bin/python3 "$BIN/sync-models.py" || echo "(exit=$?；2=有漂移，1=失败)"
echo "--- dry-run: 基元律动渠道清单 ---"
/usr/bin/python3 "$BIN/sync-upstream-models.py" || echo "(exit=$?；2=有漂移，1=失败)"

echo "--- cron 是否认了这两个文件（应无 Missing newline / ERROR）---"
sleep 1
journalctl -u cron --since '-2 min' 2>/dev/null | grep -iE "newline|celes-studio-models|celes-sync-upstream" || echo "(无相关日志)"
echo
echo "日志：/server-center/runtime/log/studio-model-sync.log"
echo "      /server-center/runtime/log/sync-upstream-models.log"
