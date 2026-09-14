#!/usr/bin/env python3
"""sync-models.py — 把 Studio 的 provider 模型清单与上游网关（基元律动/NewAPI）真实可用模型对齐。

背景：
  上游会改模型 id（例：deepseek-v4.1-flash-expires-on-0910 于 0910 关闭、
  deepseek-v4-pro-0813 渠道消失、新统一 id 为 deepseek-flash）。Studio 的
  providers.json 是人工维护的快照，id 一变就留旧死模型、缺新模型，下拉里
  点进去就报「模型已关闭 / No available channel」。

做法（全部走 HTTP，不直接改磁盘文件、不需要重启后端）：
  1. 读 Studio 活体 store：GET {studio}/api/providers（拿到 provider 的
     id/name/note/base_url/request_format/models）——注意**不要**直接改
     providers.json：后端启动时把文件读进内存，直接改盘会与内存不一致。
  2. 读 api_key：{providers_file}（0600，只有 cron/root 读得到；本脚本
     绝不打印、绝不回传 key）。
  3. GET {base_url}/models -> 上游目录（catalog）。
  4. 判定「模型还在不在」只依据目录成员关系，**绝不发模型请求**（2026-09-10 改）：
       在 catalog 里     -> 保留
       不在 catalog 里   -> 视为已下线（删除）
       目录拉取失败/为空 -> FATAL 退出，本轮不做任何写操作
     旧版对每个候选发 max_tokens=1 的 chat 探针：22 候选 × 48 轮/天 ≈ 1056 次真实
     计费请求，其中 18 个/轮是 --include 永不采纳、又不在清单里的 id（纯浪费，且
     每次都吃上游 403）。目录成员关系足以判死（本次 deepseek-v4.1-flash 即因不在
     目录里），故整段探针移除。**本脚本不再发送任何模型推理请求。**
  5. 目标清单 = 现有模型(保序，已在目录外的剔除) + 目录内匹配 --include 的新 id
     （默认 ^deepseek，即只自动采纳 deepseek 家族新 id，不擅自把 mimo/glm
     之类塞进 Studio 清单；--include '' 表示全部采纳）。
  6. 有变化才 POST {studio}/api/providers 回写（不带 api_key 字段 = 保留原 key）。
  7. 若 store 的 default_model 已不在目录内，改用 --prefer 里第一个在场的模型
     POST {studio}/api/providers/default（busy 时后端返回 409，本轮跳过，
     下次 cron 再试）。

用法：
  python3 sync-models.py                 # dry-run（默认，只打印计划）
  python3 sync-models.py --apply         # 真正同步
cron（root，30 分钟一次）：
  */30 * * * * root /usr/bin/python3 /server-center/runtime/bin/sync-models.py \
      --apply >> /server-center/runtime/log/studio-model-sync.log 2>&1

退出码：0=成功(无变化或已应用)  1=失败(API/解析)  2=dry-run 发现漂移
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request

DEFAULT_PROVIDERS_FILE = "/src/celestea_studio/providers.json"
DEFAULT_STUDIO = "http://127.0.0.1:3777"
DEFAULT_PROVIDER_ID = "celestea"
DEFAULT_INCLUDE = "^deepseek"           # 自动采纳的新 id 白名单（正则）
DEFAULT_PREFER = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-0731",
                  "deepseek-v4-pro"]

# 已知模型的元数据（name, reasoning_efforts, context_window）；表外的 id 走探针推断。
METADATA = {
    "deepseek-flash": ("DeepSeek Flash", ["low", "high", "max"], 1000000),
    "deepseek-v4-flash": ("DeepSeek V4 Flash", ["low", "high", "max"], 1000000),
    "deepseek-v4-flash-0731": ("DeepSeek V4 Flash (0731)", ["low", "high"], 1000000),
    "deepseek-v4-pro": ("DeepSeek V4 Pro", ["low", "high", "max"], 1000000),
    "glm-5.3-flash": ("GLM 5.3 Flash", [], None),
}
EFFORTS_REASONING = ["low", "high", "max"]

# 判定只依据「在不在上游目录里」——已无探针，故不再需要判死关键词表。


def http_json(url, method="GET", payload=None, key=None, timeout=15):
    """返回 (status, body_text)；HTTP 错误状态也返回（不抛），网络错误抛 OSError。"""
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def model_meta(mid):
    """目录里出现的 id 的元数据。已无探针，无法再实测 reasoning 能力：
    表内走人工维护值；表外的 deepseek 家族按「支持 reasoning」处理
    （本脚本只自动采纳 ^deepseek，结果与旧探针路径一致）。"""
    if mid in METADATA:
        name, efforts, ctx = METADATA[mid]
        return name, list(efforts), ctx
    if mid.startswith("deepseek"):
        return mid, list(EFFORTS_REASONING), 1000000
    return mid, [], None


def log(msg):
    print(msg, flush=True)


def main():
    ap = argparse.ArgumentParser(description="Sync Studio provider models with the live gateway catalog")
    ap.add_argument("--apply", action="store_true", help="真正写回（默认 dry-run）")
    ap.add_argument("--providers-file", default=DEFAULT_PROVIDERS_FILE)
    ap.add_argument("--studio", default=DEFAULT_STUDIO)
    ap.add_argument("--provider-id", default=DEFAULT_PROVIDER_ID)
    ap.add_argument("--include", default=DEFAULT_INCLUDE,
                    help="新模型采纳正则（默认 ^deepseek；空串=全部采纳）")
    ap.add_argument("--prefer", default=",".join(DEFAULT_PREFER),
                    help="default_model 失效时的候选顺序（逗号分隔）")
    ap.add_argument("--timeout", type=int, default=20, help="单次 HTTP 超时秒")
    ap.add_argument("--base-url", default=None, help="覆盖 provider base_url（测试用）")
    ap.add_argument("--api-key", default=None, help="覆盖 api_key（测试用，勿在命令行留痕）")
    args = ap.parse_args()

    # ---- 1. Studio 活体 store -------------------------------------------------
    try:
        status, text = http_json(f"{args.studio.rstrip('/')}/api/providers", timeout=args.timeout)
    except OSError as e:
        log(f"FATAL: cannot reach studio {args.studio}: {type(e).__name__}: {e}")
        return 1
    if status != 200:
        log(f"FATAL: GET {args.studio}/api/providers -> HTTP {status}: {text[:200]}")
        return 1
    store = json.loads(text)
    provider = next((p for p in store.get("providers", [])
                     if p.get("id") == args.provider_id), None)
    if provider is None:
        log(f"FATAL: provider '{args.provider_id}' not in studio store "
            f"(have: {[p.get('id') for p in store.get('providers', [])]})")
        return 1

    # ---- 2. api_key（本地 0600 文件，绝不打印） --------------------------------
    key = args.api_key
    if not key:
        try:
            with open(args.providers_file, "r", encoding="utf-8") as f:
                disk = json.load(f)
        except Exception as e:
            log(f"FATAL: cannot read {args.providers_file}: {type(e).__name__}: {e}")
            return 1
        dp = next((p for p in disk.get("providers", [])
                   if p.get("id") == args.provider_id), None)
        key = (dp or {}).get("api_key")
    if not key:
        log(f"FATAL: no api_key for provider '{args.provider_id}' "
            f"(neither {args.providers_file} nor --api-key)")
        return 1

    base_url = args.base_url or provider.get("base_url")
    if not base_url:
        log("FATAL: provider has no base_url")
        return 1

    current = provider.get("models") or []
    cur_ids = [m["id"] for m in current]

    # ---- 3. 上游 catalog ------------------------------------------------------
    try:
        status, text = http_json(base_url.rstrip("/") + "/models", key=key, timeout=args.timeout)
    except OSError as e:
        log(f"FATAL: GET {base_url}/models failed: {type(e).__name__}: {e}")
        return 1
    if status != 200:
        log(f"FATAL: GET {base_url}/models -> HTTP {status}: {text[:200]}")
        return 1
    catalog = []
    parsed = json.loads(text)
    for k in ("data", "models"):
        arr = parsed.get(k)
        if isinstance(arr, list):
            catalog = [x.get("id") for x in arr if isinstance(x, dict) and x.get("id")]
            break
    log(f"catalog: {len(catalog)} ids | store: {len(cur_ids)} models | provider={provider['id']}")

    # ---- 4. 成员关系判定（无探针：不发任何模型请求）--------------------------
    inc = re.compile(args.include) if args.include else None
    prefer = [s.strip() for s in args.prefer.split(",") if s.strip()]
    if not catalog:
        log("FATAL: upstream catalog is empty — refusing to touch the model list")
        return 1
    in_catalog = set(catalog)
    log(f"membership check: {len(in_catalog)} catalog ids, 0 probe requests")

    # ---- 5. 目标清单 ----------------------------------------------------------
    desired, removed, added = [], [], []
    for m in current:
        if m["id"] not in in_catalog:
            removed.append(m["id"])
            log(f"  drop {m['id']}: absent from upstream catalog")
            continue
        desired.append(m)
    seen = {m["id"] for m in desired}
    for mid in sorted(in_catalog):
        if mid in seen:
            continue
        if inc and not inc.search(mid):
            continue
        name, efforts, ctx = model_meta(mid)
        desired.append({"id": mid, "name": name, "reasoning_efforts": efforts,
                        "context_window": ctx, "max_output_tokens": None})
        added.append(mid)

    if not desired:
        log("FATAL: desired model list is empty — refusing to wipe the provider")
        return 1

    changed = bool(added or removed) or [m["id"] for m in desired] != cur_ids
    log(f"plan: -{len(removed)} {removed} | +{len(added)} {added}")

    # ---- 6. default_model 守卫 -------------------------------------------------
    dm = store.get("default_model")
    dm_action = None
    desired_ids = {m["id"] for m in desired}
    if dm and dm not in desired_ids:
        pick = next((p for p in prefer if p in desired_ids), None) or desired[0]["id"]
        dm_action = pick
        log(f"default_model '{dm}' is gone -> switch to '{pick}'")

    if not changed and not dm_action:
        log("in sync: nothing to do")
        return 0
    if not args.apply:
        log("dry-run: re-run with --apply to write")
        return 2

    # ---- 7. 写回（不带 api_key = 保留原 key） ---------------------------------
    payload = {
        "id": provider["id"],
        "name": provider.get("name") or provider["id"],
        "note": provider.get("note") or "",
        "base_url": provider.get("base_url"),
        "request_format": provider.get("request_format") or "chat_completions",
        "models": desired,
    }
    if changed:
        try:
            status, text = http_json(f"{args.studio.rstrip('/')}/api/providers", "POST",
                                     payload, timeout=args.timeout)
        except OSError as e:
            log(f"FATAL: POST {args.studio}/api/providers failed: {type(e).__name__}: {e}")
            return 1
        if status != 200:
            log(f"FATAL: POST /api/providers -> HTTP {status}: {text[:300]}")
            return 1
        log(f"applied: models -> {[m['id'] for m in desired]}")
    if dm_action:
        try:
            status, text = http_json(f"{args.studio.rstrip('/')}/api/providers/default", "POST",
                                     {"model": dm_action}, timeout=args.timeout)
        except OSError as e:
            log(f"WARN: POST /api/providers/default failed: {type(e).__name__}: {e}")
            return 1
        if status == 409:
            log("WARN: default_model busy (a turn is running) — will retry next run")
        elif status != 200:
            log(f"WARN: POST /api/providers/default -> HTTP {status}: {text[:200]}")
        else:
            log(f"applied: default_model -> {dm_action}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
