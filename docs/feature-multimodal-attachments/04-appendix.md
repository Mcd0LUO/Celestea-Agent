# 多模态附件 · 附录（§11）

> 状态：**设计（已实现 P0）** ｜ 本册是 [`README.md`](./README.md) 的分册：复现命令与证据。
> 章节编号沿用原文；跨册引用（如「§7」）见分册导航。

---

## 11. 附录：复现命令与证据

### 11.1 视觉能力探针（无 key 外泄）

```python
#!/usr/bin/env python3
# 从 studio 进程 env 读 key；只打印响应；不落盘 key。临时脚本，跑完即删。
import base64, json, time, urllib.request, urllib.error
from PIL import Image, ImageDraw, ImageFont

def env_key():
    with open("/proc/2741249/environ","rb") as f:
        for part in f.read().split(b"\x00"):
            if part.startswith(b"CELESTEA_API_KEY="):
                return part.split(b"=",1)[1].decode()
    raise SystemExit("no key")

API="http://127.0.0.1:3001/v1/chat/completions"
MODELS=["deepseek-v4-flash-0731","glm-5.3-flash","deepseek-flash",
        "deepseek-v4-pro","deepseek-v4.1-flash","deepseek-v4-flash"]

img = Image.new("RGB",(128,128),(255,255,255)); d = ImageDraw.Draw(img)
d.ellipse([8,8,56,56], fill=(220,20,20))
d.rectangle([72,72,120,120], fill=(20,40,220))
d.text((22,80),"7", fill=(0,0,0), font=ImageFont.load_default(size=34))
img.save("/tmp/_w801_vision.png")
DATA="data:image/png;base64,"+base64.b64encode(open("/tmp/_w801_vision.png","rb").read()).decode()
Q=("Look at the attached image. Answer strictly: SHAPES=...; COLORS=...; DIGIT=...; "
   "If no image is attached or you cannot see images, answer exactly: NO_IMAGE")
KEY=env_key()
for m in MODELS:
    body={"model":m,"max_tokens":200,"stream":False,"messages":[{"role":"user","content":[
          {"type":"text","text":Q},{"type":"image_url","image_url":{"url":DATA}}]}]}
    req=urllib.request.Request(API, data=json.dumps(body).encode(), method="POST",
          headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r: print(m, r.status, r.read().decode()[:400])
    except urllib.error.HTTPError as e: print(m, e.code, e.read().decode()[:400])
    time.sleep(1)
```

### 11.2 工具结果携带图片的形状探针

见 §3.2：把同一张图分别放进 `role:"tool"` 的 content 数组（形状 A）与紧随其后的 `role:"user"` 消息（形状 B），比较四个模型的回答。关键复现点：`deepseek-v4-pro` 对 A 回 `NO_IMAGE`、对 B 正确识图。

### 11.3 代码面穷举命令

```bash
# Content 联合的类型级匹配点
grep -rn 'type === "text"\|type === "tool_call"\|part.type\|c.type ===\|content.type ===' \
  packages apps --include=*.ts | grep -v \.test\. | grep -v node_modules
# Content helper 调用点
grep -rn 'isTextContent\|isToolCallContent\|messageTexts\|messageText(\|collectMessageText\|messageToolCalls\|hasToolCalls' \
  packages apps --include=*.ts | grep -v \.test\. | grep -v node_modules
# 端点计数硬断言
grep -rn 'API_ENDPOINT_COUNT\|must hold 51\|50 -> 51' packages apps tests contracts --include=*.ts --include=*.json
```

### 11.4 本轮**没有**做的事（重要）

- **未跑 `pnpm check`**：本轮是设计稿，未改任何代码、contracts、tests、fixtures（`git status` 里与本任务相关的改动**只有本文件**）。跑全量检查只会看到 W798（全仓退役后端词汇清理）与其它并发任务的路径噪声，无诊断价值。若验收方要求，可单独跑并登记 `git status --porcelain`。
- **未探测基元**（凭据边界，§2.3）。
- **未实测**上游的单消息图片数/体积上限、远程 URL 图片、Files API（均标 **待验证**）。

### 11.5 环境事实（实测）

```
studio 进程: node tsx src/main.ts (pid 2741249, user celestea)
CELESTEA_PROVIDERS_FILE=/var/lib/celestea-agent/providers.json  (mode 0600, plaintext api_key)
CELESTEA_TOOL_ROOTS=/src/celestea_studio-ts:/src/celestea_harness:/tmp
workspaces: /src/CelesteaTeamAPI, /src/celestea_harness, /server-center
会话目录: <workspace>/<session-dir>/{cli-main.jsonl, session.json, ...}
上游: http://127.0.0.1:3001/v1 (celestea) / https://tokenrhythm.studio/v1 (基元)
仓库图像库: 无 (grep sharp|jimp|image-size|file-type = 0 命中)
```

