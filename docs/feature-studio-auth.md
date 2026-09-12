# Studio 自己的登录 cookie 门（W767）

> 目标：`studio.celestea.top` 不再依赖 nginx HTTP Basic（无 cookie、每天重登），改由 **Studio 自己**签发 30 天登录 cookie。
>
> ⛔ 本篇只描述 **Studio 自己**的机制：凭据文件 `DEFAULT_AUTH_HTPASSWD_FILE`（`/etc/nginx/.htpasswd-studio`）是 Studio 自己的只读输入，secret 落在 Studio 自己的数据目录。不引用、不读取任何其它服务的凭据或门户机制。

## 1. 三个端点

| 端点 | 方法 | 作用 | 免认证？ |
|---|---|---|---|
| `/login` | GET | 后端直接返回的**自包含**登录页（内联 CSS，不依赖 Vite 构建） | 是（nginx `location = /login`） |
| `/auth/login` | POST | 校验用户名/密码 → `200` + `Set-Cookie` + 页内跳转 | 是（nginx `location = /auth/login`） |
| `/auth/check` | GET | 校验 cookie：`200` / `401`，供 nginx `auth_request` 调用 | 是（nginx `internal`） |

三者都进 `contracts/endpoints.json`（`API_ENDPOINT_COUNT` 44 → **47**）。`/login` 与 `/auth/login` 有意**不**放在 `/api/` 下：它们是给人看的页面入口，`tests/contracts.test.ts` 里为此保留了一条显式例外（`NON_API_PATHS`）。

### 1.1 `POST /auth/login`

- 请求体：`application/x-www-form-urlencoded`（浏览器表单）或 `application/json`（`{username, password}`）。
- 校验：`htpasswd -vbi <password file> <user>`，**密码走 stdin**（`-i`），不进 argv、不写日志；`-v` 只做校验，Studio 从不写该文件。用户名字符集限制为 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（argv 安全）。
- 退出码判定：`0` → 通过；`3`（密码不符）/ `6`（用户不存在）→ **一律 401**（不可区分，避免用户名枚举）；其它（`4` 文件错误、超时、信号）→ **500 `credential store unavailable`**（运维问题，绝不伪装成"密码错误"）。
- 成功：`200`（**不是 302** —— 部分移动端会在重定向响应上丢掉 `Set-Cookie`）+ 同一个响应里给出跳转：

  ```
  Set-Cookie: studio_auth=<token>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax
  ```

  表单提交得到一页 `<script>location.replace("/")</script>`；JSON 客户端得到 `{ok:true,user}`。
- 失败限流：同一**用户名**与同一**客户端 IP**（`X-Real-IP` / `X-Forwarded-For`，否则 `local`）各计一次失败，60s 固定窗口内 **5 次**后 `429`；成功登录清空这两个键。

### 1.2 token 格式与 secret

```
studio_auth = <b64url(user)> . <b64url(rand16)> . <expUnix> . <b64url(HMAC-SHA256(secret, 前三段))>
```

- 签名覆盖前三段的原样拼接，因此 user / nonce / 过期时间都不可篡改；`rand16` 让每个 token 唯一（抓到的 cookie 不能"复制"成第二个会话）。
- 校验顺序：形状 → HMAC（`timingSafeEqual` 常量时间）→ 过期。
- secret：`<data dir>/studio-auth.secret`，32 随机字节、base64url 存盘、**0600**，首次使用时创建；`<data dir>` 与 `workspaces.json` 同目录（`createStudioEngine` 用同一个推导），可用 `CELESTEA_AUTH_SECRET_FILE` 覆盖。重启复用同一文件 → 不会把所有人踢下线；文件过短/损坏则重新生成。
- 密码文件路径可用 `CELESTEA_AUTH_HTPASSWD_FILE` 覆盖（默认 `DEFAULT_AUTH_HTPASSWD_FILE`）。

## 2. nginx（`/etc/nginx/sites-available/studio.celestea.top.ssl`）

- 去掉 `auth_basic` / `auth_basic_user_file`。
- `location = /login`、`location = /auth/login`：免认证，`proxy_pass http://127.0.0.1:3777`。
- `location = /__auth_check`（`internal`）：`proxy_pass http://127.0.0.1:3777/auth/check`，并把 `Cookie $http_cookie` 透传给子请求。
- `location /`：`auth_request /__auth_check;` + `error_page 401 = @need_login;`，其余 proxy 参数（http1.1 / Host / X-Real-IP / X-Forwarded-* / `proxy_buffering off` / read+send timeout / chunked）保持原样。
- `location @need_login { return 302 /login; }`。

**回滚**：备份文件 `…/studio.celestea.top.ssl.bak-w767-<时间戳>`，回滚即

```bash
sudo cp /etc/nginx/sites-available/studio.celestea.top.ssl.bak-w767-<时间戳> /etc/nginx/sites-available/studio.celestea.top.ssl
sudo nginx -t && sudo systemctl reload nginx
```

reload 之后旧 worker 仍可能按旧配置服务数十秒，验证前需确认新 worker 已接管。

## 3. 代码落点

| 文件 | 内容 |
|---|---|
| `apps/studio/src/auth/token.ts` | token 铸造/校验、cookie 头、secret 文件（0600） |
| `apps/studio/src/auth/htpasswd.ts` | `htpasswd -vbi` 校验（stdin、退出码映射） |
| `apps/studio/src/auth/rate-limit.ts` | 60s 窗口失败限流器（用户名 + IP） |
| `apps/studio/src/auth/page.ts` | 自包含登录页 + 成功页（`location.replace`） |
| `apps/studio/src/handlers/auth.ts` | 三个端点 |
| `apps/studio/src/config.ts` | `paths.authSecretFile` / `paths.authHtpasswdFile` |

测试：`apps/studio/src/auth/auth.test.ts`（token/secret/限流/密码助手/页面）、`apps/studio/src/auth-http.test.ts`（三端点 HTTP 面、cookie 往返、401/429、secret 0600）。
