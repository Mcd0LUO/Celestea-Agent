/**
 * W767 — Studio's OWN login page, rendered by the Studio backend.
 *
 * Self-contained on purpose: inline CSS, no external asset, no dependency on
 * the Vite build (so the login page keeps working while the SPA is being
 * rebuilt, and nginx can serve it as the one unauthenticated page).
 *
 * The form posts `application/x-www-form-urlencoded`, which every browser and
 * password manager understands; the JSON body form is accepted too (curl /
 * API clients). ALL pages returned here are `Cache-Control: no-store`.
 */

/** The page itself (the error slot is the only dynamic part). */
const HEAD = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Celestea Studio 登录</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0f1115;color:#e8eaed;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
main{width:100%;max-width:22rem;padding:2rem 1.5rem}
h1{margin:0 0 .25rem;font-size:1.35rem;font-weight:600}
p.sub{margin:0 0 1.5rem;color:#9aa0a6;font-size:.9rem}
label{display:block;margin:0 0 .35rem;font-size:.85rem;color:#bdc1c6}
input{width:100%;padding:.65rem .75rem;margin:0 0 1rem;border-radius:.5rem;border:1px solid #3c4043;
  background:#1a1d21;color:inherit;font-size:1rem}
input:focus{outline:2px solid #8ab4f8;outline-offset:1px;border-color:#8ab4f8}
button{width:100%;padding:.7rem;border:0;border-radius:.5rem;background:#8ab4f8;color:#202124;
  font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#aecbfa}
.err{margin:0 0 1rem;padding:.6rem .75rem;border-radius:.5rem;background:#3b1d1d;border:1px solid #8c2f2f;
  color:#f6aea9;font-size:.9rem}
footer{margin:1.5rem 0 0;color:#5f6368;font-size:.75rem;text-align:center}
</style>
</head>
<body><main>
<h1>Celestea Studio</h1>
<p class="sub">请登录后继续</p>
`;

/** `error === null` = a clean form; otherwise the message is shown above it. */
export function loginPage(error: string | null = null): string {
  const slot = error === null ? "" : `<p class="err">${escapeHtml(error)}</p>`;
  return `${HEAD}${slot}<form method="POST" action="/auth/login">
<label for="u">用户名</label>
<input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="p">密码</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">登录</button>
</form>
<footer>celestea-studio · 登录状态保持 30 天</footer>
</main></body></html>
`;
}

/**
 * The 200 answer to a SUCCESSFUL form login. It is a page (never a 302): a
 * redirect response is allowed to drop `Set-Cookie` on some mobile clients, so
 * the cookie and the navigation travel in the SAME 200 response.
 */
export const LOGIN_OK_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>已登录 · Celestea Studio</title></head>
<body><p>登录成功，正在进入…</p>
<script>location.replace("/")</script>
<noscript><a href="/">进入 Celestea Studio</a></noscript>
</body></html>
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
