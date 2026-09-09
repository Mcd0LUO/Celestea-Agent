# run_code SDK 与父 broker 协议

> 本文是 [`DEVELOPMENT.md`](./DEVELOPMENT.md) §3 的展开：`run_code` 工具（W255）的**使用者视角**
> （怎么写程序）与**维护者视角**（协议、限额、事件映射、如何本地验证）。
> 设计背景与取舍见 [`run-code-mode-eval.md`](./run-code-mode-eval.md)；本文只描述**已落地实现**。
>
> 源码：`crates/tools/src/run_code.rs`（实现 + SDK 前导 + runner + 测试）。

---

## 1. 它解决什么问题

一次 `run_code` 调用 = 一个 Python 程序在沙箱内运行，程序里可以调用四个工具，**工具调用由父进程（引擎）
用与模型直调完全相同的管线执行**，程序结束后只把 `main()` 的返回值作为**一个**工具结果交回模型。

收益：多步“取数 → 处理 → 再取数”的流程折叠成**一轮**往返，中间结果不进入上下文（但仍写进会话日志备审计）。

```
模型 → run_code(code) ──────────────────────────────────────────► 模型只看到 main() 的返回值
                     │
                     ├─ tools.read_file(...)  ──► 父 broker ──► 真实 ToolRegistry（guard/sandbox/limits）
                     ├─ tools.run_shell(...)  ──► 父 broker ──► 同上
                     └─ ...
```

---

## 2. 怎么写程序

`code` 参数接受两种形式（`assemble_program`，`run_code.rs:388`）：

| 形式 | 判定 | 写法 |
| --- | --- | --- |
| **函数体** | 第一行非空行**有缩进** | 直接写 `async def main():` 的**函数体**（引擎自动包一层 `async def main():` 并整体缩进） |
| **完整脚本** | 第一行非空行无缩进 | 自己定义 `async def main()`（或同步 `def main()`） |

规则：

- 引擎拼装顺序 = **SDK 前导 + 你的代码 + runner**。runner 会调用 `main()`；若返回协程则 `asyncio.run` 它。
- `main()` 的返回值经 JSON 无损序列化，成为 `run_code` 的最终值（对象/数组/字符串/数字/布尔/null 都行）。
- **不要**写 `if __name__ == "__main__":`，**不要**读 `sys.stdin`——stdin 是父进程的协议回复通道。
- 只 `print()` 模型需要看到的东西：stdout 行进入 `render`（≤64KiB），**不会**自动进入会话上下文。
- 子调用是**同步阻塞**的（P0 串行）；不要用 `asyncio.gather` 并发发子调用。
- `main` 缺失 → runner 抛 `RuntimeError`，整个运行以 `__error__` 结束。

---

## 3. SDK 表面

SDK 前导只暴露一个对象 `tools`，以及异常类 `ToolCallError`。

| 方法 | 等价工具调用 | 返回 |
| --- | --- | --- |
| `tools.read_file(path=...)` | `read_file` | 文件文本（str） |
| `tools.write_file(path=..., content=...)` | `write_file` | `"ok"` |
| `tools.list_dir(path=...)` | `list_dir` | 文件名列表 |
| `tools.run_shell(command=..., workdir=..., timeout_ms=...)` | `run_shell` | `{stdout, stderr, exit_code, stdout_truncated, stderr_truncated, sandbox}` |

调用形式两种都支持（`_merge_args`）：

```python
tools.read_file(path="/tmp/a.txt")            # 关键字
tools.read_file({"path": "/tmp/a.txt"})       # 单个位置 dict
```

**白名单是硬性的**：只有上面四个名字会被父进程执行。任何其它名字（包括 `run_code` 自己、
`spawn_worker`、`session_send_message`、`process_control`、`http_request`）返回
`tool '<name>' not exposed in run_code SDK`，在 SDK 侧变成 `ToolCallError`。

---

## 4. 结果对象的双接口（`_Value` / `_AttrDict`）

模型写代码时两种风格都可能出现，SDK 让它们**完全等价**：

```python
s = tools.run_shell(command="echo hi")
s.stdout          # 属性访问
s["stdout"]       # 下标访问
len(s)            # 像 dict
s.get("stdout")   # dict 方法
s.stdout.splitlines()   # 方法透传

s = await tools.run_shell(command="echo hi")   # await 形式，结果同样支持上面所有写法
s.stdout
```

- `_Value` 包装返回值，实现下标/迭代/`len`/`bool`/`str`/`repr`/`==`/`get`/`__getattr__` 透传，
  并实现 `__await__`（**yield 空后 return 值**；这是 CPython asyncio 的 awaitable 协议要求）。
- `_AttrDict` 是 `dict` 子类，键同时可当属性用（`s.stdout == s["stdout"]`）；`_attr()` 会**递归**
  把任意深度的 dict（含 list 内元素）转成 `_AttrDict`。
- 最终返回值经 `_plain()` 递归解包再序列化，所以 `return tools.list_dir(...)` 也是合法的。

---

## 5. 错误处理

### 5.1 `ToolCallError`（可捕获）

子调用失败（guard 拒绝、未知工具、子调用限额、工具自身报错、协议异常）都会抛 `ToolCallError`，
程序可以捕获后继续做别的事：

```python
async def main():
    try:
        text = tools.read_file(path="/etc/shadow")
    except ToolCallError as e:
        return {"skipped": str(e)}
    return {"len": len(text)}
```

异常消息形如 `tool 'read_file' failed: denied: toolguard: code=path_forbidden`；
`e.tool_name` 保存工具名。

### 5.2 程序异常（不可捕获到“继续”）

`main()` 抛出的未捕获异常（含 `SystemExit`）由 runner 兜底：把 traceback 打到 stdout，
再输出 `{"__error__": "<Type>: <msg>"}` 并以退出码 1 结束。引擎把这条消息作为 `run_code` 的**错误**
返回，并在消息尾部附上最近的日志（≤2048 字符）。

### 5.3 基础设施错误（`run_code: code=...`）

不是程序的问题，是运行环境的问题，形状固定为 `run_code: code=<code> msg="..."`：

| code | 触发 |
| --- | --- |
| `invalid_arg` | `code` 为空；`timeout_ms` 不是整数 / <1 / >120000 |
| `registry` | `RegistryHandle` 未绑定（嵌入方装配错误） |
| `config` | 无法创建/写 `.celestea/` 目录或程序文件 |
| `spawn` | 沙箱里 `python3 -uB` 起不来 / 没有 stdin 管道 |
| `protocol` | stdout 读取失败、回复写回失败（子进程提前关闭 stdin） |
| `timeout` | 超过墙钟，已杀进程组；消息含 pid 与已捕获日志字节数 |
| `aborted` | 程序结束但既没有 `__final__` 也没有 `__error__`（例如被信号杀死） |

---

## 6. 限额

| 项 | 值 | 说明 |
| --- | --- | --- |
| 子调用数 | 20 | 第 21 次回 `ok:false`（`sub-call limit exceeded`），**不计入** dispatch |
| 整体墙钟 | 120s（默认 = 硬上限） | `timeout_ms` 可下调；上调超过 120000 直接 `invalid_arg`。`CELAESTEA_RUN_CODE_TIMEOUT_MS` 只能调默认值，clamp 到 `[1,120000]` |
| 子调用输出累计 | 256 KiB | 字符串截 UTF-8 安全前缀；对象/数组无法无损切割 → 占位串；回复带 `truncated:true` + `warning` |
| stdout 日志 | 64 KiB | 超出截断并追加提示；只影响 `render`，不影响最终值 |
| stderr | 64 KiB | 同上 |
| 单行长度 | 1 MiB | 超长行 drain 后丢弃，按日志处理 |

父进程对每个限额都有对应测试（`sub_call_limit_twenty_rejects_twenty_first`、
`sub_call_output_budget_truncates_with_warning`、`stdout_logs_are_capped_at_64_kib`、
`wall_clock_timeout_kills_the_program` 等）。

---

## 7. 协议（维护者视角）

```
child (python) → parent (engine)   {"id": <int>, "tool": "<name>", "args": {...}}
parent → child                     {"id": <int>, "ok": true, "value": <json>}
                                   {"id": <int>, "ok": true, "value": <json>, "truncated": true, "warning": "..."}
                                   {"id": <int>, "ok": false, "error": "<message>"}
child → parent                     {"__final__": <json>}
                                   {"__error__": "<message>"}
```

- 一行一个 JSON 对象（`\n` 结尾，无其它分帧）；`stdout` 走协议，`stderr` 只当日志收集。
- 父进程逐行读取；**不是**请求/最终/错误行的 JSON 与任何非 JSON 行都当日志。
- 程序文件写到 `<sandbox workdir>/.celestea/run_code_<pid>_<n>.py`，用 `python3 -uB` 启动
  （`-u` 无缓冲、`-B` 不写 `__pycache__`）；stdin 保持打开作为回复通道。
- 每次子调用映射成两条会话事件（id `<parent>:c<n>`，`parent_id = <parent>`），
  `derive_messages` 会跳过它们（模型只看外层往返）。
- 调用结束（正常/超时/取消）都会杀掉整个进程组并删除程序文件；父 future 被 drop 时由
  `ChildKillGuard::Drop` 兜底杀进程。

---

## 8. 可运行示例

以下示例均已用真实 SDK 前导 + runner 实测（模拟 broker 按协议回包）。

### 8.1 读文件并取第一行

```python
async def main():
    text = tools.read_file(path="/tmp/notes.txt")
    return text.splitlines()[0]
```

### 8.2 列目录 + 跑命令，混合两种访问风格

```python
async def main():
    listing = tools.list_dir(path=".")
    first = listing[0]

    s = tools.run_shell(command="printf 'a\\nb\\n'")
    lines = s.stdout.splitlines()          # s.stdout == s['stdout']
    return {"first_entry": first, "line_count": len(lines), "stdout": s['stdout']}
# 实测（broker 回假数据）：{"first_entry": "alpha.txt", "line_count": 2, "stdout": "a\nb\n"}
```

### 8.3 `await` 形式

```python
async def main():
    s = await tools.run_shell(command="echo hi")
    return s.stdout.strip()                # 实测："hi"
```

### 8.4 失败可恢复

```python
async def main():
    try:
        tools.read_file(path="/etc/shadow")   # PathGuard 拒绝
    except ToolCallError as e:
        return f"denied: {e}"
    return "unexpectedly allowed"
# 实测："denied: tool 'read_file' failed: denied: toolguard: code=path_forbidden"
```

### 8.5 完整脚本形式（自己定义 main）

```python
import json

async def main():
    names = tools.list_dir(path="/tmp")
    txt = [n for n in names if n.endswith(".txt")]
    return {"txt_count": len(txt), "names": txt}
```

---

## 9. 本地验证（不跑完整引擎）

想快速验证一段程序，可用“模拟 broker”：提取 `run_code.rs` 里的 `RUN_CODE_SDK` + `RUN_CODE_RUNNER`
拼成文件，再用 Python 起子进程、按协议回包。

```python
import json, re, subprocess, sys

src = open("crates/tools/src/run_code.rs").read()
def block(name):
    return re.search('(?:pub )?const ' + name + ': &str = r##"(.*?)"##;', src, re.S).group(1)

program = block("RUN_CODE_SDK") + "\n\n# user\n" + '''
async def main():
    s = tools.run_shell(command="echo hi")
    return s.stdout.strip()
''' + block("RUN_CODE_RUNNER")

open("/tmp/prog.py", "w").write(program)
p = subprocess.Popen([sys.executable, "-uB", "/tmp/prog.py"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
while True:
    line = p.stdout.readline()
    if not line:
        break
    obj = json.loads(line)
    if "__final__" in obj:
        print("FINAL:", obj["__final__"]); break
    if "__error__" in obj:
        print("ERROR:", obj["__error__"]); break
    if "id" in obj and "tool" in obj:                     # 模拟父 broker
        p.stdin.write(json.dumps({"id": obj["id"], "ok": True,
                                  "value": {"stdout": "hi\n", "stderr": "", "exit_code": 0}}) + "\n")
        p.stdin.flush()
```

> 注意：这只是**协议级**验证，不覆盖真实沙箱、guard 与真实工具。端到端行为以
> `crates/tools/tests/run_code_e2e.rs`（真实注册表）与 `cargo test -p celestea-tools run_code` 为准。

---

## 10. 相关测试

| 测试 | 覆盖 |
| --- | --- |
| `crates/tools/tests/run_code_e2e.rs` | 真实 builtin 注册表上的端到端：读文件取首行 + 子调用事件 id/parent_id |
| `run_code::tests::parent_broker_echo_round_trip` | JSON-RPC 回环、kwargs/位置 dict/await 三种调用形式、事件日志 |
| `run_code::tests::sdk_whitelist_rejects_other_tools` | 非白名单工具被拒 |
| `run_code::tests::sub_call_limit_twenty_rejects_twenty_first` | 子调用限额 |
| `run_code::tests::sub_call_output_budget_truncates_with_warning` | 输出账本截断 |
| `run_code::tests::stdout_logs_are_capped_at_64_kib` | 日志预算 |
| `run_code::tests::wall_clock_timeout_kills_the_program` | 墙钟超时杀进程 |
| `run_code::tests::non_json_return_value_is_a_program_error` | 返回值不可序列化 |
| `run_code::tests::program_exception_becomes_error_with_log_tail` | 程序异常 + 日志尾部 |
| `run_code::tests::assemble_program_*` | 函数体 / 完整脚本两种拼装 |
