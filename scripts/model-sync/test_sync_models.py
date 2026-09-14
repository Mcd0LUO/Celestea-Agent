#!/usr/bin/env python3
"""sync-models.py 的离线验收：假网关 + 假 Studio，全走 127.0.0.1 回环。

跑法：python3 tools/test_sync_models.py   （无需网络、不碰真网关/真后端）
覆盖：dry-run 不写 / apply 删死模型+采纳新 deepseek id / 保留 name·note·base_url
      且不回传 api_key / UNKNOWN(429) 不误删 / default_model 失效自动切换 /
       幂等 / key 不泄漏 / 探针确实带 Authorization。
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "sync-models.py")
FAKE_KEY = "sk-TEST-KEY-DO-NOT-LEAK-1234"

CATALOG = [
    "deepseek-flash", "deepseek-v4-flash-0731", "deepseek-v4-flash", "deepseek-v4-pro",
    "deepseek-v4.1-flash-expires-on-0910", "deepseek-v4-pro-0813",
    "deepseek-v4-flash-vision-exp", "glm-5.3-flash", "mimo-v2.5",
    "deepseek-v4-pro-0901",  # 上游新出现的 id（应被自动采纳）
]

# 每个模型的探针行为：(http_status, body)
BEHAVIOR = {
    "deepseek-flash": (200, {"choices": [{"message": {"reasoning_content": "r"}}], "usage": {}}),
    "deepseek-v4-flash-0731": (200, {"choices": [{"message": {"reasoning_content": "r"}}], "usage": {}}),
    "deepseek-v4-flash": (200, {"choices": [{"message": {"content": "hi"}}], "usage": {}}),
    "deepseek-v4-pro": (200, {"choices": [{"message": {"reasoning_content": "r"}}], "usage": {}}),
    "deepseek-v4-pro-0901": (200, {"choices": [{"message": {"reasoning_content": "r"}}], "usage": {}}),
    "deepseek-v4.1-flash-expires-on-0910": (400, {"error": {"message": "模型已关闭：deepseek-v4.1-flash-expires-on-0910"}}),
    "deepseek-v4-pro-0813": (503, {"error": {"message": "No available channel for model deepseek-v4-pro-0813 under group ds"}}),
    "deepseek-v4-flash-vision-exp": (503, {"error": {"message": "No available channel for model deepseek-v4-flash-vision-exp"}}),
    "glm-5.3-flash": (429, {"error": {"message": "rate limited"}}),          # UNKNOWN -> 保留
    "mimo-v2.5": (200, {"choices": [{"message": {"content": "hi"}}], "usage": {}}),  # 非 deepseek -> 不采纳
}

STATE = {
    "store": {
        "default_model": "deepseek-v4.1-flash-expires-on-0910",  # DEAD -> 应切换
        "providers": [{
            "id": "celestea", "name": "Celestea 网关", "note": "本机 newapi 网关",
            "base_url": "http://127.0.0.1:__GW__/v1", "request_format": "chat_completions",
            "has_key": True,
            "models": [
                {"id": "deepseek-v4-flash-0731", "name": "DeepSeek V4 Flash", "reasoning_efforts": ["low", "high"], "context_window": 1000000, "max_output_tokens": None},
                {"id": "deepseek-v4-pro-0813", "name": "x", "reasoning_efforts": ["low"], "context_window": 1000000, "max_output_tokens": None},
                {"id": "deepseek-v4.1-flash-expires-on-0910", "name": "x", "reasoning_efforts": ["low"], "context_window": 1000000, "max_output_tokens": None},
                {"id": "glm-5.3-flash", "name": "GLM 5.3 Flash", "reasoning_efforts": [], "context_window": None, "max_output_tokens": None},
                {"id": "deepseek-flash", "name": "deepseek-flash", "reasoning_efforts": ["low", "high", "max"], "context_window": 1000000, "max_output_tokens": None},
            ],
        }],
    },
    "posts": [],           # 记录写回
    "default_posts": [],
    "seen_auth": [],       # (来源, Authorization 头前 7 字符)
}


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
        if self.path == "/v1/models":
            STATE["seen_auth"].append(("gw", self.headers.get("Authorization", "")[:7]))
            self._send(200, {"data": [{"id": i} for i in CATALOG]})
        elif self.path == "/api/providers":
            self._send(200, STATE["store"])
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/v1/chat/completions":
            STATE["seen_auth"].append(("gw", self.headers.get("Authorization", "")[:7]))
            code, body = BEHAVIOR.get(payload.get("model"), (404, {"error": {"message": "model not found"}}))
            self._send(code, body)
        elif self.path == "/api/providers":
            STATE["posts"].append(payload)
            merged = {k: v for k, v in payload.items() if k != "api_key"}
            merged["has_key"] = True
            STATE["store"]["providers"][0] = merged
            self._send(200, STATE["store"])
        elif self.path == "/api/providers/default":
            STATE["default_posts"].append(payload)
            STATE["store"]["default_model"] = payload["model"]
            self._send(200, STATE["store"])
        else:
            self._send(404, {"error": "not found"})


def start():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def run(args, expect_rc):
    r = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True)
    out = r.stdout + r.stderr
    ok = r.returncode == expect_rc
    print(f"--- rc={r.returncode} (expect {expect_rc}) {'OK' if ok else 'FAIL'}")
    print("\n".join("    " + l for l in out.strip().splitlines()))
    return out, ok


def main():
    gw_port = start()
    st_port = start()
    STATE["store"]["providers"][0]["base_url"] = f"http://127.0.0.1:{gw_port}/v1"
    studio = f"http://127.0.0.1:{st_port}"
    base = ["--studio", studio, "--providers-file", "/dev/null",
            "--api-key", FAKE_KEY, "--include", "^deepseek"]

    fails = []

    # 1) dry-run：有漂移 -> rc 2，且不写
    out, ok = run(base, 2)
    if not ok:
        fails.append("dry-run rc")
    if STATE["posts"]:
        fails.append("dry-run must not POST /api/providers")

    # 2) apply：写回并切 default
    out, ok = run(base + ["--apply"], 0)
    if not ok:
        fails.append("apply rc")
    if len(STATE["posts"]) != 1:
        fails.append(f"expected 1 write, got {len(STATE['posts'])}")
    else:
        p = STATE["posts"][0]
        ids = [m["id"] for m in p["models"]]
        want = ["deepseek-v4-flash-0731", "glm-5.3-flash", "deepseek-flash",
                "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro-0901"]
        if ids != want:
            fails.append(f"model list mismatch: {ids} != {want}")
        if "api_key" in p:
            fails.append("payload must NOT carry api_key (原 key 由后端保留)")
        if p.get("note") != "本机 newapi 网关" or p.get("name") != "Celestea 网关":
            fails.append("name/note must be preserved")
        if p.get("base_url") != f"http://127.0.0.1:{gw_port}/v1":
            fails.append("base_url must be preserved")
        for m in p["models"]:
            if m["id"] == "deepseek-v4-pro-0901":
                if m["reasoning_efforts"] != ["low", "high", "max"]:
                    fails.append("new model reasoning must be inferred from the probe")
                if m["name"] != "deepseek-v4-pro-0901":
                    fails.append("new model name falls back to id")
    if STATE["default_posts"] != [{"model": "deepseek-flash"}]:
        fails.append(f"default switch wrong: {STATE['default_posts']}")

    # 3) 幂等：再跑一次 -> rc 0，无新写
    out2, ok = run(base + ["--apply"], 0)
    if not ok:
        fails.append("idempotent rc")
    if len(STATE["posts"]) != 1:
        fails.append("idempotent run must not write again")

    # 4) key 泄漏检查
    if FAKE_KEY in out or FAKE_KEY in out2 or FAKE_KEY in json.dumps(STATE["posts"]):
        fails.append("api_key leaked!")

    # 5) key 真的送到了网关
    if not any(src == "gw" and pre == "Bearer " for src, pre in STATE["seen_auth"]):
        fails.append("probe did not send Authorization header")

    print("\n==== RESULT ====")
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
