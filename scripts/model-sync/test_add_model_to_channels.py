#!/usr/bin/env python3
"""add-model-to-channels.py 的离线验收：假 NewAPI（127.0.0.1 回环）。

跑法：python3 tools/test_add_model_to_channels.py
覆盖：分页自发现 / 只碰目标上游渠道（排除他人上游 + is_multi_key 池）/ dry-run 零写 /
      apply 追加 models（逗号串）+ 幂等 / --map-to 写 model_mapping /
      **PUT 不带 status**、剔只读字段、回带 key（服务端模拟真实拒绝规则）/
      拿不到 key -> FAIL 跳过 / 回读校验 / --limit / key 不泄漏。
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "add-model-to-channels.py")
FAKE_KEY = "sk-TEST-ADD-MODEL-KEY-777"
NEW_MODEL = "deepseek-v4.1-flash"

ALL_CHANNELS = [
    {"id": 58, "name": "基元律动x-001", "base_url": "https://tokenrhythm.studio",
     "key": FAKE_KEY, "models": "deepseek-v4-flash-0731,deepseek-flash", "status": 1,
     "setting": "{}", "other_info": json.dumps({"keep": "me"}),
     "model_mapping": json.dumps({"deepseek-v4-flash": "deepseek-v4-flash-0731"})},
    {"id": 62, "name": "基元律动x-004", "base_url": "https://tokenrhythm.studio/",
     "key": FAKE_KEY, "models": "deepseek-v4-flash-0731", "status": 1,
     "setting": "{}", "model_mapping": ""},
    {"id": 41, "name": "opencode-001", "base_url": "https://opencode.ai",
     "key": FAKE_KEY, "models": "x", "status": 1, "setting": "{}"},
    {"id": 30, "name": "基元律动-池", "base_url": "https://tokenrhythm.studio",
     "key": FAKE_KEY, "models": "x", "status": 1, "setting": "{}",
     "channel_info": json.dumps({"is_multi_key": True})},
    {"id": 31, "name": "基元律动-nokey", "base_url": "https://tokenrhythm.studio",
     "key": "", "models": "z", "status": 1, "setting": "{}"},
]

UPSTREAM_IDS = ["deepseek-v4-flash-0731", "deepseek-flash", "glm-5.3-flash"]  # 不含 NEW_MODEL

STATE = {"puts": [], "pages": [], "gets": []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/channel/fetch_models/"):
            cid = int(self.path.rsplit("/", 1)[1])
            self._send(200, {"success": True, "data": UPSTREAM_IDS})
        elif self.path.startswith("/api/channel/?"):
            q = dict(kv.split("=", 1) for kv in self.path.split("?", 1)[1].split("&") if "=" in kv)
            page = int(q.get("p", 1))
            size = int(q.get("page_size", 100))
            STATE["pages"].append(page)
            items = ALL_CHANNELS[(page - 1) * size: page * size]
            self._send(200, {"success": True, "data": {"items": items,
                                                      "total": len(ALL_CHANNELS)}})
        elif self.path.startswith("/api/channel/"):
            cid = int(self.path.rsplit("/", 1)[1])
            STATE["gets"].append(cid)
            ch = next((c for c in ALL_CHANNELS if c["id"] == cid), None)
            self._send(200, {"success": True, "data": ch} if ch
                       else {"success": False, "message": "not found"})
        else:
            self._send(404, {"success": False})

    def do_PUT(self):
        n = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(n) or b"{}")
        if "status" in payload:          # 真实规则：带 status 直接判非法参数
            self._send(200, {"success": False, "message": "参数错误"})
            return
        STATE["puts"].append(payload)
        for c in ALL_CHANNELS:           # 模拟落库
            if c["id"] == payload["id"]:
                c["models"] = payload.get("models", c["models"])
                if "model_mapping" in payload:
                    c["model_mapping"] = payload["model_mapping"]
                c["key"] = payload.get("key", c["key"])
        self._send(200, {"success": True, "data": payload})


def start():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def run(base, args, expect_rc):
    r = subprocess.run([sys.executable, SCRIPT, "--api-base", base, "--token", "tkn",
                        "--timeout", "10", "--page-size", "2", "--sleep", "0"] + args,
                       capture_output=True, text=True)
    out = r.stdout + r.stderr
    ok = r.returncode == expect_rc
    print(f"--- rc={r.returncode} (expect {expect_rc}) {'OK' if ok else 'FAIL'}")
    print("\n".join("    " + l for l in out.strip().splitlines()))
    return out, ok


def main():
    port = start()
    base = f"http://127.0.0.1:{port}"
    fails = []

    # 1) dry-run：rc2、零写、分页 3 页、范围只含 58/62/31
    out1, ok = run(base, ["--model", NEW_MODEL], 2)
    if not ok:
        fails.append("dry-run rc")
    if STATE["puts"]:
        fails.append("dry-run 不得写")
    if [1, 2, 3] != sorted(set(STATE["pages"])):
        fails.append(f"分页应抓 1/2/3 页: {sorted(set(STATE['pages']))}")

    # 2) apply：只写 58/62；31 无 key -> WARN 跳过（rc0）
    STATE["puts"].clear()
    out2, _ = run(base, ["--model", NEW_MODEL, "--apply"], 0)
    ids = [p["id"] for p in STATE["puts"]]
    if ids != [58, 62]:
        fails.append(f"应只写 58/62: {ids}")
    else:
        for p in STATE["puts"]:
            if "status" in p:
                fails.append("PUT 不得带 status")
            for k in ("created_time", "test_time", "response_time", "balance",
                      "balance_updated_time", "used_quota", "status_code_mapping", "channel_info"):
                if k in p:
                    fails.append(f"PUT 回带只读字段 {k}")
            if p.get("key") != FAKE_KEY:
                fails.append(f"PUT 必须回带 key: {p.get('key')!r}")
            if NEW_MODEL not in p.get("models", "").split(","):
                fails.append(f"models 未追加 {NEW_MODEL}: {p.get('models')!r}")
        p58 = next(p for p in STATE["puts"] if p["id"] == 58)
        if p58.get("other_info") != json.dumps({"keep": "me"}):
            fails.append("other_info 应原样回带")
        p62 = next(p for p in STATE["puts"] if p["id"] == 62)
        if p62["models"] != f"deepseek-v4-flash-0731,{NEW_MODEL}":
            fails.append(f"顺序应保持追加: {p62['models']!r}")
    if "拿不到 key" not in out2 or "WARN" not in out2:
        fails.append("无 key 的渠道应告警并跳过")
    if "告警 1" not in out2:
        fails.append("汇总应记 1 条告警")

    # 3) 幂等：再跑 -> rc0，零写
    STATE["puts"].clear()
    out3, ok = run(base, ["--model", NEW_MODEL, "--apply"], 0)
    if not ok:
        fails.append("幂等 rc")
    if STATE["puts"]:
        fails.append(f"幂等跑不得再写: {[p['id'] for p in STATE['puts']]}")

    # 4) --map-to：写 model_mapping 且保留原映射
    STATE["puts"].clear()
    out4, ok = run(base, ["--model", NEW_MODEL, "--map-to", "deepseek-v4.1-flash-upstream",
                          "--limit", "1", "--apply"], 0)
    if not ok:
        fails.append("map-to rc")
    if [p["id"] for p in STATE["puts"]] != [58]:
        fails.append(f"--limit 1 应只写一条: {[p['id'] for p in STATE['puts']]}")
    else:
        m = json.loads(STATE["puts"][0].get("model_mapping") or "{}")
        if m.get(NEW_MODEL) != "deepseek-v4.1-flash-upstream":
            fails.append(f"映射未写入: {m}")
        if m.get("deepseek-v4-flash") != "deepseek-v4-flash-0731":
            fails.append(f"原映射被破坏: {m}")

    # 5) --probe-upstream：上游不含该模型 -> 告警（进日志，不阻断）
    STATE["puts"].clear()
    out5, _ = run(base, ["--model", NEW_MODEL, "--probe-upstream"], 2)
    if "上游 /v1/models 不含" not in out5:
        fails.append("--probe-upstream 应告警上游不含该模型")
    if "deepseek-flash" not in out5:
        fails.append("告警应打印上游模型列表（便于核对正确 id）")

    # 6) key 不泄漏
    for out in (out1, out2, out3, out4, out5):
        if FAKE_KEY in out:
            fails.append("key 泄漏到输出!")

    print("\n==== RESULT ====")
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
