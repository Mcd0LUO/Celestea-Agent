#!/usr/bin/env python3
"""sync-upstream-models.py — 基元律动(tokenrhythm) 渠道「模型清单」随上游同步。

背景：
  上游会改模型 id（例：deepseek-v4-pro-0813 渠道消失、deepseek-v4.1-flash-expires-on-0910
  于 0910 关闭、新统一 id 为 deepseek-flash）。NewAPI 渠道的 models 字段是人工快照，
  不同步就会：网关 /v1/models 仍挂死 id（调用报「模型已关闭 / No available channel」），
  而新 id 又进不来。

本脚本用 NewAPI 定制版自带的「上游模型更新」接口做同步（不自造探针）：
  POST /api/channel/upstream_updates/detect  {"id": N}   -> 服务端拿该渠道自己的 key 拉上游
        /v1/models，落 last_detected/last_removed，**不自动改** models
  POST /api/channel/upstream_updates/apply   {"id": N, "add_models": [...],
        "remove_models": [...], "ignore_models": [...]}  -> 真正写渠道 models

这两个接口只要求 ChannelOperate / ChannelWrite，**不需要改渠道配置**，
所以默认路径是纯「读上游 + 改 models」，绝不碰 setting/key/status。

可选 --enable-flags：额外把渠道 setting 的
        upstream_model_update_check_enabled / upstream_model_update_auto_sync_enabled 置真，
  让 NewAPI 自带的 30min system task 也持续兜底。该写入用 PUT /api/channel/，必须遵守本版
  定制规则（实测教训）：
    - payload **不能含 `status`**：`UpdateChannel` 一见 requestData["status"] 直接判
      「非法参数」（success=false）——这正是首版 58 条渠道全 FAIL 的原因；
    - 只读字段（created_time/test_time/response_time/balance/balance_updated_time/used_quota/
      status_code_mapping/channel_info 等）不要回带，否则被清零；
    - 需回带 key（本版 PUT 会用 payload 覆盖），且必须取单条 GET /api/channel/{id}
      的完整对象（列表接口不保证带 key）；拿不到 key 就**放弃写入**并告警。

范围与红线：
  - 只碰 base_url 含 tokenrhythm.studio 的渠道（自发现 + 分页，不做死白名单）；
    排除 channel_info.is_multi_key 聚合池（与 tokenrhythm-usage.py 同规则）。
  - key 只在进程内使用，**不打印、不写日志、不入 other_info 标记**。
  - 默认 dry-run；--apply 才写。删除默认不做，需显式 --remove。
  - detect 失败/上游超时 → 该渠道跳过并告警，绝不做删除类误操作。

用法：
  python3 sync-upstream-models.py                      # dry-run：列出差异
  python3 sync-upstream-models.py --apply              # 应用「新增」模型
  python3 sync-upstream-models.py --apply --remove     # 另加「上游已无」的删除
  python3 sync-upstream-models.py --apply --remove --enable-flags   # 另开渠道开关
cron（root，30min）：
  */30 * * * * root /usr/bin/python3 /server-center/runtime/bin/sync-upstream-models.py \
      --apply --remove >> /server-center/runtime/log/sync-upstream-models.log 2>&1

退出码：0=已同步/无变化  1=有渠道失败  2=dry-run 发现待同步项
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

BASE_DEFAULT = "http://127.0.0.1:3001"
BASE_URL_SUBSTR = "tokenrhythm.studio"
FLAG_CHECK = "upstream_model_update_check_enabled"
FLAG_AUTO = "upstream_model_update_auto_sync_enabled"
PAGE_SIZE = 100           # GET /api/channel/?p=&page_size= 分页大小（渠道数会增长）
PAGE_LIMIT = 50           # 分页上限（防跑飞）

# PUT /api/channel/ 时**必须剔除**的字段：本版定制 NewAPI 的只读/服务端管理字段。
# `status` 单独处理——带了它 UpdateChannel 直接判非法参数。
READONLY_SKIP = {
    "created_time", "test_time", "response_time", "balance",
    "balance_updated_time", "used_quota", "status_code_mapping", "channel_info",
}
# other_info 保留原值回带（tokenrhythm-usage.py 同款做法：不覆盖既有字段）。
PRESERVE_AS_IS = {"other_info"}


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
    """失败摘要（永不回显 key：body 里不会有 key，且只截 160 字符）。"""
    msg = (body or {}).get("message") or (body or {}).get("code") or ""
    return f"HTTP {status} {str(msg)[:160]}"


def get_token(args):
    if args.token:
        return args.token
    sys.path.insert(0, "/server-center/runtime/bin")
    import celes_auth  # noqa: E402  (部署在同目录，由 cron root 运行)
    return celes_auth.get_token()


def parse_json_str(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    try:
        return json.loads(raw)
    except Exception:
        return {}


def is_multi_key(ch):
    return bool(parse_json_str(ch.get("channel_info")).get("is_multi_key"))


def discover(base, token, timeout, page_size=PAGE_SIZE):
    """分页拉全量渠道；只留 tokenrhythm 且非聚合池的。"""
    out, page = [], 1
    while page <= PAGE_LIMIT:
        st, body = api(base, "GET", f"/api/channel/?p={page}&page_size={page_size}",
                       token, timeout=timeout)
        if st != 200 or not (body or {}).get("success", True):
            raise RuntimeError(f"GET /api/channel/ p={page} -> {err_of(st, body)}")
        data = (body or {}).get("data") or {}
        items = data.get("items") or []
        out += [c for c in items
                if BASE_URL_SUBSTR in (c.get("base_url") or "") and not is_multi_key(c)]
        total = data.get("total")
        if not items or (isinstance(total, int) and page * page_size >= total):
            break
        page += 1
    return out


def enable_flags(base, token, cid, timeout):
    """把两个上游模型同步开关写进渠道 setting（幂等）。

    返回 (status, note)：status ∈ {"on","already-on","skip","fail"}。
    skip = 环境不允许安全写入（如拿不到 key），只是告警、不计失败。
    """
    st, body = api(base, "GET", f"/api/channel/{cid}", token, timeout=timeout)
    if st != 200 or not (body or {}).get("success", True):
        return "fail", f"GET 单条失败 {err_of(st, body)}"
    ch = (body or {}).get("data") or {}
    setting = parse_json_str(ch.get("setting"))
    if setting.get(FLAG_CHECK) and setting.get(FLAG_AUTO):
        return "already-on", "already-on"
    if not str(ch.get("key") or "").strip():
        # 本版 PUT 会用 payload 覆盖 key：拿不到 key 就宁可不写（不冒险清 key）
        return "skip", "单条 GET 未返回 key，放弃写入（避免误清 key）"
    setting[FLAG_CHECK] = True
    setting[FLAG_AUTO] = True
    patch = {k: v for k, v in ch.items()
             if k not in READONLY_SKIP and k != "status" and v is not None}
    patch["setting"] = json.dumps(setting, ensure_ascii=False)
    st, body = api(base, "PUT", "/api/channel/", token, payload=patch, timeout=timeout)
    if st == 200 and (body or {}).get("success", False):
        return "on", "on"
    return "fail", f"PUT 失败 {err_of(st, body)}"


def main():
    ap = argparse.ArgumentParser(description="Sync tokenrhythm channel model lists with upstream")
    ap.add_argument("--apply", action="store_true", help="真正写（默认 dry-run）")
    ap.add_argument("--remove", action="store_true",
                    help="同时应用「上游已不再提供」的删除（默认只加不删）")
    ap.add_argument("--enable-flags", action="store_true",
                    help="额外开启渠道的「上游模型更新检测+自动同步」开关（默认不动渠道配置）")
    ap.add_argument("--api-base", default=BASE_DEFAULT)
    ap.add_argument("--token", default=None, help="测试用；缺省走 celes_auth")
    ap.add_argument("--timeout", type=int, default=40)
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少条渠道（0=全部）")
    ap.add_argument("--page-size", type=int, default=PAGE_SIZE, help="渠道分页大小")
    ap.add_argument("--sleep", type=float, default=0.2, help="渠道之间的间隔秒（对上游友好）")
    args = ap.parse_args()

    try:
        token = get_token(args)
    except Exception as e:
        log(f"FATAL: 取管理 token 失败: {type(e).__name__}: {e}")
        return 1

    try:
        channels = discover(args.api_base, token, args.timeout, args.page_size)
    except Exception as e:
        log(f"FATAL: 渠道自发现失败: {type(e).__name__}: {e}")
        return 1
    if args.limit > 0:
        channels = channels[:args.limit]
    log(f"发现 tokenrhythm 渠道 {len(channels)} 条: {[c.get('id') for c in channels]}")
    if not channels:
        log("WARN: 未发现渠道，什么都不做（绝不因发现异常清空/误操作）")
        return 1

    pending, failed, applied, warned = 0, 0, 0, 0
    for ch in channels:
        cid, name = ch.get("id"), ch.get("name")
        if args.enable_flags:
            setting = parse_json_str(ch.get("setting"))
            if not (setting.get(FLAG_CHECK) and setting.get(FLAG_AUTO)):
                if not args.apply:
                    pending += 1
                    log(f"[{cid} {name}] 开关未开 -> 将启用 检测+自动同步")
                else:
                    status, note = enable_flags(args.api_base, token, cid, args.timeout)
                    if status == "fail":
                        failed += 1
                        log(f"[{cid} {name}] FAIL: 开关 {note}")
                        continue
                    if status == "skip":
                        warned += 1
                        log(f"[{cid} {name}] WARN: 开关 {note}")
                    else:
                        log(f"[{cid} {name}] 开关: {note}")
        st, body = api(args.api_base, "POST", "/api/channel/upstream_updates/detect",
                       token, payload={"id": cid}, timeout=args.timeout)
        data = (body or {}).get("data") or {}
        if st != 200 or not (body or {}).get("success", False):
            failed += 1
            log(f"[{cid} {name}] FAIL: detect -> {err_of(st, body)}")
            if args.sleep:
                time.sleep(args.sleep)
            continue
        add = [m for m in (data.get("add_models") or []) if m]
        rem = [m for m in (data.get("remove_models") or []) if m]
        if args.sleep:
            time.sleep(args.sleep)   # detect 已打过上游，渠道之间歇一下
        if not add and not rem:
            continue
        pending += 1
        log(f"[{cid} {name}] 上游差异: +{add} -{rem}")
        if not args.apply:
            continue
        payload = {"id": cid, "add_models": add,
                   "remove_models": rem if args.remove else [],
                   "ignore_models": []}
        st, body = api(args.api_base, "POST", "/api/channel/upstream_updates/apply",
                       token, payload=payload, timeout=args.timeout)
        if st != 200 or not (body or {}).get("success", False):
            failed += 1
            log(f"[{cid} {name}] FAIL: apply -> {err_of(st, body)}")
            continue
        d = (body or {}).get("data") or {}
        applied += 1
        log(f"[{cid} {name}] 已应用: +{d.get('added_models')} -{d.get('removed_models')}"
            + ("" if args.remove else f"（删除未应用，剩 {d.get('remaining_remove_models')}）"))
    log(f"汇总: 渠道 {len(channels)} / 待同步 {pending} / 已应用 {applied} / "
        f"失败 {failed} / 告警 {warned}")
    if failed:
        return 1
    if pending and not args.apply:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
