// ============================================================================
// ui/workbench/terminal-api.ts — W1528：终端的线协议（打开 / 按键 / 关闭）。
// ----------------------------------------------------------------------------
// 为什么单独一个文件、而不是加进 api.ts：\`src/api.ts\` 已经**正好在 400 行**的
// 模块体积上限上（登记表里没有它的例外）。往一个到顶的文件里塞 40 行，只会让下
// 一个改它的人先撞门禁。先例是 \`plugins/server.ts\`（W895-C1）——同样是「功能局部
// 的传输层自带」。
//
// 面向用户的**错误词汇表不变**：这里不新造短语，失败一律经 api.ts 已导出的
// \`ApiError\` / \`userErrorText\`，与全站其它请求同一条口径（服务端原文只进 console）。
// ============================================================================
import { ApiError, userErrorText } from '../../api';
import { t } from '../../i18n';
import type {
  TerminalCloseResp,
  TerminalInputResp,
  TerminalOpenReq,
  TerminalOpenResp,
} from '../../types/terminal';

/** 状态码 → 与 api.ts 同款的用户短语（复用它的字典键，不新造词）。 */
function phrase(status: number): string {
  if (status === 0) return t('api.error.connect');
  if (status === 400 || status === 422) return t('api.error.badRequest');
  if (status === 401 || status === 403) return t('api.error.forbidden');
  if (status === 404 || status === 405) return t('api.error.unsupported');
  if (status === 409) return t('api.error.conflict');
  if (status === 429) return t('api.error.tooMany');
  if (status >= 500) return t('api.error.server');
  return t('api.error.generic');
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn('[terminal-api] ' + path + ' 网络层失败：' + detail);
    throw new ApiError(phrase(0), 0, null, detail);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const obj = data as { error?: unknown } | null;
    const detail = obj && typeof obj.error === 'string' && obj.error.trim() !== '' ? obj.error : 'HTTP ' + String(res.status);
    console.warn('[terminal-api] ' + path + ' → HTTP ' + String(res.status) + '：' + detail);
    // \`data\` 原样带上：调用方要读结构化拒绝码（shell_denied / terminal_unavailable /
    // terminal_limit / terminal_gone），那是它给用户写具体说明的依据。
    throw new ApiError(phrase(res.status), res.status, data, detail);
  }
  return (data ?? {}) as T;
}

/**
 * POST /api/terminal —— 在沙箱里开一个真 pty（util-linux script(1)）。
 * 403 \`shell_denied\` = 该会话档位不允许 shell；501 \`terminal_unavailable\` =
 * 本机没有 script(1)（Windows）；429 \`terminal_limit\` = 本进程终端数到顶。
 * 三种都是**结构化拒绝**，调用方按 code 给可读说明。
 */
export function terminalOpen(req: TerminalOpenReq): Promise<TerminalOpenResp> {
  return call<TerminalOpenResp>('/api/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/**
 * POST /api/terminal/{id}/input —— 原样写入 pty 的 stdin。
 *
 * body 是**裸文本**而不是 JSON：一次按键不该付 JSON 转义的代价，字面换行也必须
 * 逐字节原样到达 pty。服务端按 \`c.req.text()\` 读，body 就是那串字节本身。
 * **不追加换行**：回车是客户端发的字节（\r），服务端不替用户发明 —— 这正是
 * REPL 能工作的原因（同一个端点先送 'p'，再送 '\r'）。
 */
export function terminalInput(id: string, text: string): Promise<TerminalInputResp> {
  return call<TerminalInputResp>('/api/terminal/' + encodeURIComponent(id) + '/input', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
  });
}

/** POST /api/terminal/{id}/close —— 幂等关闭（连同整个进程组一起终止）。 */
export function terminalClose(id: string): Promise<TerminalCloseResp> {
  return call<TerminalCloseResp>('/api/terminal/' + encodeURIComponent(id) + '/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export { userErrorText };
