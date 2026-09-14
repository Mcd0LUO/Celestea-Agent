#!/usr/bin/env python3
"""sync-upstream-models.py 的离线验收：假 NewAPI（127.0.0.1 回环）。

跑法：python3 tools/test_sync_upstream_models.py
覆盖：分页自发现 / 只碰 tokenrhythm 渠道（排除非该上游 + is_multi_key 池）/ dry-run 不写 /
      默认**不动渠道配置**（零 PUT）/ --enable-flags 的 PUT 合规（**不带 status**、剔除只读字段、
      回带 key，且服务端模拟「带 status = 非法参数」真实规则）/ 拿不到 key 时放弃写入 /
      apply 只加不删（--remove 才删）/ detect 失败 -> rc1 / key 不泄漏。
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "sync-upstream-models.py")
FAKE_KEY = "sk-TEST-UPSTREAM-KEY-9999"

# 假渠道目录（分页由请求的 page_size 决定：测试用 --page-size 2 -> 需抓 3 页）
ALL_CHANNELS = [
    {"id": 28, "name": "基元律动-001", "base_url": "https://tokenrhythm.studio",
     "key": FAKE_KEY, "models": "deepseek-v4-pro-0813,glm-5.3", "status": 1,
     "setting": json.dumps({"upstream_model_update_check_enabled": True,
                            "upstream_model_update_auto_sync_enabled": True}),
     "other_info": json.dumps({"note": "keep-me"})},
    {"id": 29, "name": "基元律动-002", "base_url": "https://tokenrhythm.studio/",
     "key": FAKE_KEY, "models": "deepseek-v4-pro-0813", "status": 1,
     "setting": "{}", "other_info": "{}"},
    {"id": 41, "name": "opencode-001", "base_url": "https://opencode.ai",
     "key": FAKE_KEY, "models": "y", "status": 1, "setting": "{}"},
    {"id": 30, "name": "基元律动-池", "base_url": "https://tokenrhythm.studio",
     "key": FAKE_KEY, "models": "x", "status": 1, "setting": "{}",
     "channel_info": json.dumps({"is_multi_key": True})},
    {"id": 31, "name": "nokey-基元律动", "base_url": "https://tokenrhythm.studio",
     "key": "", "models": "z", "status": 1, "setting": "{}"},
]

DETECT = {
    28: {"add_models": ["deepseek-flash"], "remove_models": ["deepseek-v4-pro-0813"]},
    29: {"add_models": [], "remove_models": []},
    31: {"add_models": [], "remove_models": []},
}

STATE = {"puts": [], "detect": [], "apply": [], "detect_fail": set(), "pages": []}


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
        if self.path.startswith("/api/channel/?"):
            q = dict(kv.split("=", 1) for kv in self.path.split("?", 1)[1].split("&") if "=" in kv)
            page = int(q.get("p", 1))
            size = int(q.get("page_size", 100))
            STATE["pages"].append(page)
            items = ALL_CHANNELS[(page - 1) * size: page * size]
            self._send(200, {"success": True, "data": {"items": items,
                                                       "total": len(ALL_CHANNELS)}})
        elif self.path.startswith("/api/channel/"):
            cid = int(self.path.rsplit("/", 1)[1])
            ch = next((c for c in ALL_CHANNELS if c["id"] == cid), None)
            if ch is None:
                self._send(404, {"success": False, "message": "not found"})
            else:
                self._send(200, {"success": True, "data": ch})
        else:
            self._send(404, {"success": False})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/channel/upstream_updates/detect":
            cid = payload["id"]
            STATE["detect"].append(cid)
            if cid in STATE["detect_fail"]:
                self._send(500, {"success": False, "message": "upstream timeout"})
                return
            d = DETECT.get(cid, {"add_models": [], "remove_models": []})
            self._send(200, {"success": True, "data": {"channel_id": cid,
                                                       "channel_name": "n", **d}})
        elif self.path == "/api/channel/upstream_updates/apply":
            STATE["apply"].append(payload)
            self._send(200, {"success": True, "data": {
                "id": payload["id"], "added_models": payload["add_models"],
                "removed_models": payload["remove_models"],
                "remaining_remove_models": []}})
        else:
            self._send(404, {"success": False})

    def do_PUT(self):
        n = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(n) or b"{}")
        # 真实规则：UpdateChannel 见到 requestData["status"] 就直接判非法参数
        if "status" in payload:
            self._send(200, {"success": False, "message": "参数错误"})
            return
        STATE["puts"].append(payload)
        self._send(200, {"success": True, "data": payload})


def start():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def run(base, args, expect_rc):
    r = subprocess.run([sys.executable, SCRIPT, "--api-base", base, "--token", "tkn",
                        "--timeout", "10", "--sleep", "0", "--page-size", "2"] + args,
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

    # 1) dry-run：有漂移 -> rc2，零写入，分页拉到第 2 页
    out1, ok = run(base, [], 2)
    if not ok:
        fails.append("dry-run rc")
    if STATE["puts"] or STATE["apply"]:
        fails.append("dry-run 不得写")
    if [1, 2, 3] != sorted(set(STATE["pages"])):
        fails.append(f"分页应抓 1/2/3 页（page_size=2, 共 5 条）: {sorted(set(STATE['pages']))}")
    if sorted(STATE["detect"]) != [28, 29, 31]:
        fails.append(f"detect 范围错（应 3 条 tokenrhythm 非池、含无 key 的那条）: {STATE['detect']}")

    # 2) --apply：应用 28 的新增；**不发任何 PUT**（默认不碰渠道配置）
    STATE["puts"].clear()
    STATE["apply"].clear()
    out2, ok = run(base, ["--apply"], 0)
    if not ok:
        fails.append("apply rc")
    if STATE["puts"]:
        fails.append(f"默认路径不得 PUT 渠道配置: {[p.get('id') for p in STATE['puts']]}")
    acts = {a["id"]: a for a in STATE["apply"]}
    if set(acts) != {28}:
        fails.append(f"apply 范围错: {list(acts)}")
    elif acts[28]["add_models"] != ["deepseek-flash"] or acts[28]["remove_models"] != []:
        fails.append(f"默认应只加不删: {acts[28]}")

    # 3) --apply --remove：删除被应用
    STATE["apply"].clear()
    out3, ok = run(base, ["--apply", "--remove"], 0)
    if not ok:
        fails.append("apply --remove rc")
    acts = {a["id"]: a for a in STATE["apply"]}
    if 28 not in acts or acts[28]["remove_models"] != ["deepseek-v4-pro-0813"]:
        fails.append(f"--remove 应带上删除: {acts}")

    # 4) --enable-flags：PUT 合规（不带 status / 剔除只读 / 回带 key / 保留 other_info）
    STATE["puts"].clear()
    out4, ok = run(base, ["--apply", "--enable-flags"], 0)
    if not ok:
        fails.append("enable-flags rc")
    put_ids = [p.get("id") for p in STATE["puts"]]
    if put_ids != [29]:
        fails.append(f"只有 29 需要开开关（28 已开；31 无 key 应放弃）: {put_ids}")
    else:
        p = STATE["puts"][0]
        if "status" in p:
            fails.append("PUT 不得带 status（服务端会判非法参数）")
        for k in ("created_time", "test_time", "response_time", "balance",
                  "balance_updated_time", "used_quota", "status_code_mapping", "channel_info"):
            if k in p:
                fails.append(f"PUT 回带了只读字段 {k}（会被清零）")
        if p.get("key") != FAKE_KEY:
            fails.append("PUT 必须回带 key")
        s = json.loads(p.get("setting") or "{}")
        if not (s.get("upstream_model_update_check_enabled") and s.get("upstream_model_update_auto_sync_enabled")):
            fails.append("PUT 未写入两个开关")
        if p.get("other_info") != "{}":
            fails.append(f"other_info 应原样回带: {p.get('other_info')!r}")
    if "未返回 key" not in out4 or "WARN" not in out4:
        fails.append("无 key 的渠道（31）应告警放弃写入（不计失败）")
    if "告警 1" not in out4:
        fails.append(f"汇总应记 1 条告警: {out4.strip().splitlines()[-1]!r}")

    # 5) detect 失败 -> rc1
    STATE["detect_fail"] = {28}
    out5, rc_ok = run(base, ["--apply"], 1)
    if rc_ok is False:
        fails.append("detect 失败应 rc1")
    STATE["detect_fail"] = set()

    # 6) key 不得出现在任何输出里
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
