#!/usr/bin/env python3
"""add-model-to-channels.py — 批量给某系列渠道「加入一个模型」（可选同时加 model_mapping 别名）。

场景：基元律动(tokenrhythm) 渠道要支持新模型 id（例：deepseek-v4.1-flash），
渠道的 models 字段是人工快照，需要一个批量、幂等、可 dry-run 的入口。

做法：对自发现出的每条渠道执行
    GET  /api/channel/{id}      -> 取完整对象（含 key）
    PUT  /api/channel/          -> 回写「models 追加 + 可选 model_mapping 追加」
写入必须遵守本版定制 NewAPI 的规则（踩坑记录，见 tools/MODEL-SYNC.md）：
    1. payload **不能含 `status`**：UpdateChannel 一见 requestData["status"] 直接判「非法参数」；
    2. 只读字段不要回带（created_time/test_time/response_time/balance/balance_updated_time/
       used_quota/status_code_mapping/channel_info），否则被清零；
    3. 必须回带 `key`（本版 PUT 会用 payload 覆盖）；key 优先取单条 GET 的 key 字段，
       拿不到时回退 `sudo -u postgres psql`（与 tokenrhythm-usage.py 同法，需 root）；
       两者都拿不到就**跳过该渠道并告警**，绝不冒险写（避免清 key）；
    4. `other_info` / `setting` 等原样回带。

安全性：默认 dry-run；--apply 才写；幂等（已在 models/映射里的渠道跳过）；
        只碰 --base-url-substr 命中的渠道（默认 tokenrhythm.studio），排除 is_multi_key 聚合池。

用法（须 root，走 celes_auth 取管理 token）：
  sudo python3 /server-center/runtime/bin/add-model-to-channels.py --model deepseek-v4.1-flash
  sudo python3 /server-center/runtime/bin/add-model-to-channels.py --model deepseek-v4.1-flash --apply
  # 需要别名映射时（本地名 -> 上游名）：
  sudo python3 ... --model deepseek-v4.1-flash --map-to deepseek-v4.1-flash-0810 --apply

退出码：0=已同步/无变化  1=有渠道失败  2=dry-run 发现待改动
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE_DEFAULT = "http://127.0.0.1:3001"

# 本版定制 NewAPI：PUT 时必须剔除的只读/服务端管理字段（带 `status` 会直接判非法参数）
PUT_SKIP = {
    "status", "created_time", "test_time", "response_time", "balance",
    "balance_updated_time", "used_quota", "status_code_mapping", "channel_info",
}


def log(msg):
    print(msg, flush=True)


def api(base, method, path, token=None, payload=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, {}


def err_of(status, body):
    msg = (body or {}).get("message") or (body or {}).get("code") or ""
    return f"HTTP {status} {str(msg)[:160]}"


def get_token(args):
    if args.token:
        return args.token
    sys.path.insert(0, "/server-center/runtime/bin")
    import celes_auth  # noqa: E402  (部署在同目录，由 root 运行)
    return celes_auth.get_token()


def parse_json(raw, default):
    if raw is None or raw == "":
        return default
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except Exception:
        return default


def split_models(raw):
    if isinstance(raw, list):
        return [str(m).strip() for m in raw if str(m).strip()]
    return [m.strip() for m in str(raw or "").split(",") if m.strip()]


def db_key(cid):
    """回退取 key：本机 NewAPI 的渠道 key 在 postgres（与 tokenrhythm-usage.py 同法）。"""
    try:
        out = subprocess.run(
            ["sudo", "-u", "postgres", "psql", "-d", "newapi", "-tAc",
             f"select key from channels where id={cid}"],
            capture_output=True, text=True, timeout=20)
        return out.stdout.strip()
    except Exception:
        return ""


def discover(base, token, substr, timeout, page_size):
    out, page = [], 1
    while page <= 50:
        st, body = api(base, "GET", f"/api/channel/?p={page}&page_size={page_size}",
                       token, timeout=timeout)
        if st != 200 or not (body or {}).get("success", True):
            raise RuntimeError(f"GET /api/channel/ p={page} -> {err_of(st, body)}")
        data = (body or {}).get("data") or {}
        items = data.get("items") or []
        for c in items:
            if substr and substr not in (c.get("base_url") or ""):
                continue
            if parse_json(c.get("channel_info"), {}).get("is_multi_key"):
                continue          # 聚合池不动
            out.append(c)
        total = data.get("total")
        if not items or (isinstance(total, int) and page * page_size >= total):
            break
        page += 1
    return out


def upstream_ids(base, token, cid, timeout):
    """读该渠道上游 /v1/models 的 id 列表（只读，用于提示）。失败返回 None。"""
    st, body = api(base, "GET", f"/api/channel/fetch_models/{cid}", token, timeout=timeout)
    if st != 200 or not (body or {}).get("success", True):
        return None
    data = (body or {}).get("data")
    if isinstance(data, list):
        return [str(x) for x in data]
    if isinstance(data, dict):
        ids = data.get("models") or data.get("data")
        if isinstance(ids, list):
            return [str(x.get("id") if isinstance(x, dict) else x) for x in ids]
    return None


def main():
    ap = argparse.ArgumentParser(description="Batch-add a model to a channel family")
    ap.add_argument("--model", required=True, help="要加入的模型 id（本地名，逗号分隔）")
    ap.add_argument("--map-to", default="",
                    help="为 --model 设置 model_mapping（本地名->上游名，逗号分隔与 --model 对齐）")
    ap.add_argument("--apply", action="store_true", help="真正写（默认 dry-run）")
    ap.add_argument("--base-url-substr", default="tokenrhythm.studio",
                    help="只处理 base_url 含该子串的渠道")
    ap.add_argument("--api-base", default=BASE_DEFAULT)
    ap.add_argument("--token", default=None, help="测试用；缺省走 celes_auth")
    ap.add_argument("--timeout", type=int, default=40)
    ap.add_argument("--page-size", type=int, default=100)
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少条（0=全部）")
    ap.add_argument("--probe-upstream", action="store_true",
                    help="先读各渠道上游 /v1/models，若不含该模型则告警（不阻断）")
    ap.add_argument("--sleep", type=float, default=0.05)
    args = ap.parse_args()

    models = [m.strip() for m in args.model.split(",") if m.strip()]
    maps = [m.strip() for m in args.map_to.split(",")] if args.map_to else []
    if not models:
        log("FATAL: --model 不能为空")
        return 1
    if maps and len(maps) != len(models):
        log("FATAL: --map-to 项目数需与 --model 一致")
        return 1

    try:
        token = get_token(args)
    except Exception as e:
        log(f"FATAL: 取管理 token 失败: {type(e).__name__}: {e}")
        return 1

    try:
        channels = discover(args.api_base, token, args.base_url_substr, args.timeout, args.page_size)
    except Exception as e:
        log(f"FATAL: 渠道自发现失败: {type(e).__name__}: {e}")
        return 1
    if args.limit > 0:
        channels = channels[:args.limit]
    if not channels:
        log("WARN: 未发现匹配渠道，什么都不做（绝不因发现异常误操作）")
        return 1
    log(f"匹配渠道 {len(channels)} 条: {[c.get('id') for c in channels]}")
    log(f"目标模型: {models}" + (f" | 映射: {dict(zip(models, maps))}" if maps else " | 无映射改动"))

    pending, failed, changed, skipped, warned = 0, 0, 0, 0, 0
    for ch in channels:
        cid, name = ch.get("id"), ch.get("name")
        st, body = api(args.api_base, "GET", f"/api/channel/{cid}", token, timeout=args.timeout)
        if st != 200 or not (body or {}).get("success", True):
            failed += 1
            log(f"[{cid} {name}] FAIL: GET 单条 -> {err_of(st, body)}")
            continue
        full = (body or {}).get("data") or {}
        cur = split_models(full.get("models"))
        mapping = parse_json(full.get("model_mapping"), {}) or {}
        if not isinstance(mapping, dict):
            mapping = {}

        add_models = [m for m in models if m not in cur]
        add_maps = {m: t for m, t in zip(models, maps) if t and mapping.get(m) != t} if maps else {}
        if not add_models and not add_maps:
            skipped += 1
            continue
        pending += 1

        if args.probe_upstream:
            ids = upstream_ids(args.api_base, token, cid, args.timeout)
            if ids is not None and not all(m in ids for m in models):
                warned += 1
                missing = [m for m in models if m not in ids]
                log(f"[{cid} {name}] WARN: 上游 /v1/models 不含 {missing}；"
                    f"上游现有: {ids[:20]}{'...' if len(ids) > 20 else ''}")
            if args.sleep:
                time.sleep(args.sleep)

        log(f"[{cid} {name}] 待改: models+{add_models} mapping+{add_maps or '{}'} "
            f"(当前 {len(cur)} 个模型)")
        if not args.apply:
            continue

        key = str(full.get("key") or "").strip()
        if not key:
            key = db_key(cid)
        if not key:
            # 拿不到 key 只是"这条改不了"，不是任务失败：告警跳过（不冒险写，避免清 key）
            warned += 1
            log(f"[{cid} {name}] WARN: 拿不到 key，跳过（避免误清 key）")
            continue

        patch = {k: v for k, v in full.items() if k not in PUT_SKIP and v is not None}
        patch["key"] = key
        patch["models"] = ",".join(cur + add_models)          # 本版 models 存逗号分隔字符串
        if add_maps:
            merged = dict(mapping)
            merged.update(add_maps)
            patch["model_mapping"] = json.dumps(merged, ensure_ascii=False)
        st, body = api(args.api_base, "PUT", "/api/channel/", token, payload=patch, timeout=args.timeout)
        if st != 200 or not (body or {}).get("success", False):
            failed += 1
            log(f"[{cid} {name}] FAIL: PUT -> {err_of(st, body)}")
            continue
        # 幂等复核：回读确认真的写进去了
        st, body = api(args.api_base, "GET", f"/api/channel/{cid}", token, timeout=args.timeout)
        after = split_models(((body or {}).get("data") or {}).get("models")) if st == 200 else []
        oknow = all(m in after for m in models)
        if oknow:
            changed += 1
            log(f"[{cid} {name}] OK: 已写入（当前 {len(after)} 个模型）")
        else:
            failed += 1
            log(f"[{cid} {name}] FAIL: PUT 返回成功但回读未包含 {models}")
        if args.sleep:
            time.sleep(args.sleep)

    log(f"汇总: 渠道 {len(channels)} / 待改 {pending} / 已写 {changed} / 已是最新 {skipped} / "
        f"失败 {failed} / 告警 {warned}")
    if failed:
        return 1
    if pending and not args.apply:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
