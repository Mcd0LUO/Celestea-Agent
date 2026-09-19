// ============================================================================
// ui/workbench/browser.ts — G4：浏览器面板（iframe 指向用户输入的 URL）。
// ----------------------------------------------------------------------------
// P0：一个 iframe + URL 输入 + 「打开」+「在新标签打开」。跨域站点若用
//   X-Frame-Options / CSP frame-ancestors 拒绝被嵌入，父页面**读不到原因**
//   （跨域），所以用「加载超时 ⇒ 可读提示」的保守判定：超时未 load 就提示
//   「这个网站可能不允许被嵌入」并给「在新标签打开」出口，不留白屏、不静默。
// 竞态：每次导航取面板新 seq；晚到的旧 load/超时事件丢弃。
// ============================================================================
import { el } from '../../utils/dom';
import { nextSeq, type PanelState } from './state';

let loadTimeoutMs = 4000;

/** 测试可调：加载超时阈值（毫秒）。 */
export function setLoadTimeout(ms: number): void {
  loadTimeoutMs = ms;
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (t === '') return '';
  if (/^https?:\/\//i.test(t)) return t;
  return 'https://' + t;
}

/** 渲染浏览器面板内容。 */
export function renderBrowserPanel(body: HTMLElement, panel: PanelState, isCurrent: (id: string, seq: number) => boolean): void {
  const data = panel.data as unknown as { url?: string } | undefined;
  const current = data && typeof data.url === 'string' ? data.url : '';
  const off = document.createElement('div');
  const row = el('div', 'wb-url-row');
  const input = el('input', 'wb-url-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = '输入网址，例如 example.com';
  input.value = current;
  const open = el('button', 'wb-btn wb-url-open', '打开') as HTMLButtonElement;
  open.type = 'button';
  row.appendChild(input);
  row.appendChild(open);
  off.appendChild(row);
  const notice = el('div', 'wb-notice hidden');
  off.appendChild(notice);
  const frame = el('iframe', 'wb-frame') as HTMLIFrameElement;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
  off.appendChild(frame);
  const external = el('button', 'wb-btn wb-url-external hidden', '在新标签打开') as HTMLButtonElement;
  external.type = 'button';
  off.appendChild(external);
  body.replaceChildren(...Array.from(off.childNodes));

  const show = (text: string, url: string): void => {
    notice.textContent = text;
    notice.classList.remove('hidden');
    external.classList.remove('hidden');
    external.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  };

  const navigate = (raw: string): void => {
    const url = normalizeUrl(raw);
    if (url === '') return;
    panel.data = { url } as unknown as Record<string, unknown>;
    const seq = nextSeq(panel.id);
    notice.classList.add('hidden');
    external.classList.add('hidden');
    let done = false;
    frame.addEventListener('load', () => {
      if (!isCurrent(panel.id, seq)) return;
      done = true;
    });
    frame.src = url;
    window.setTimeout(() => {
      if (!isCurrent(panel.id, seq) || done) return;
      // 跨域下无法读具体原因：保守提示「可能不允许被嵌入」并给出口。
      show('这个网站可能不允许被嵌入（页面安全策略），可点「在新标签打开」', url);
    }, loadTimeoutMs);
  };

  open.addEventListener('click', () => navigate(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(input.value);
    }
  });
  if (current !== '') navigate(current);
}
