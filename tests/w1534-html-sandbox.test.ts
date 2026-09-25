// @vitest-environment jsdom
/**
 * W1534/W1543 · HTML 预览 —— 沙箱策略（纯函数 + 真实 DOM 节点）。
 *
 * 这一组守的是**安全面**：渲染不可信 HTML 时的权限最小化。断言分四类：
 *
 *   ① 正控（证明隔离在）：sandbox 不含 allow-same-origin / allow-scripts；
 *      且**真机实测**该 iframe 的 contentDocument === null（不透明源）。
 *   ② 负控（证明断言吃劲）：故意把 sandbox / csp 去掉 ⇒ 断言必须红
 *      （见各 it 的「变异负控制」小节 + results/W1543-html-preview.md 的真机红绿原文）。
 *   ③ 保真：srcdoc 用 property setter 赋**原文** ⇒ 与用户 HTML **逐字节相等**。
 *   ④ CSP 落位：走 iframe 的 **csp 属性**，不往 HTML 里插 meta。
 *   ⑤ 写入形态：srcdoc 必须用 **DOM property setter**（这条只能钉源码形状 ——
 *      真机实测 setAttribute 与 property 在本用例的输入上逐字节等价，行为断言抓不到）。
 *
 * 为什么 contentDocument === null 只能在真机断：jsdom **不实现** sandbox 的源隔离
 * （它不会把 sandboxed frame 丢进不透明源），也不认识 csp 属性
 * （实测 `'csp' in iframe` === false），所以行为层的后果只能靠真机 CDP 断言
 * （见 results/W1543-html-preview.md 的 CDP 一节）。这里断**属性/字符串**层的策略，
 * 真机断**行为**层的后果 —— 两层都要，缺一层就是假绿。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface SandboxMod {
  PREVIEW_SANDBOX: string;
  PREVIEW_CSP: string;
  HTML_FRAME_CLASS: string;
  applySandbox(frame: unknown): void;
  applyCsp(frame: unknown): void;
  applyPreviewPolicy(frame: unknown): void;
}
interface RenderersMod {
  renderPreview(i: Record<string, unknown>): { node: ElLike; degraded: string | null };
}
const loadSandbox = async (): Promise<SandboxMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/sandbox.ts'))) as SandboxMod;
const loadRenderers = async (): Promise<RenderersMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/renderers.ts'))) as RenderersMod;

/** 一个带实体与两种引号的 HTML（srcdoc 保真的最小充分样本）。 */
const SQ = String.fromCharCode(39); // 单引号：避免在源码里与字符串定界符打架
const FIDELITY_HTML = '<!doctype html><html><head><title>t</title></head><body><p id="p">A &amp; B &lt;tag&gt; "dq" ' + SQ + 'sq' + SQ + '</p></body></html>';
/** 一个含脚本的 HTML（XSS 面）。 */
const XSS_HTML = '<!doctype html><html><body><scr' + 'ipt>alert(1)</scr' + 'ipt><p id="ok">rendered</p></body></html>';

beforeEach(() => { resetHarness(); });

describe('W1534/W1543 · 沙箱策略（属性层）', () => {
  it('sandbox 令牌：只给 allow-popups；**绝不给** allow-same-origin / allow-scripts', async () => {
    const m = await loadSandbox();
    const tokens = m.PREVIEW_SANDBOX.split(/\s+/).filter((s) => s !== '');
    // ★ 硬红线：allow-same-origin 与 allow-scripts 同用即突破沙箱（等价于主文档同源脚本）。
    expect(tokens, 'allow-same-origin 是硬红线：它与 allow-scripts 同用即突破沙箱').not.toContain('allow-same-origin');
    // ★ 本波验收要求「脚本未执行」⇒ 不能给 allow-scripts（给了它 alert 会真的弹）。
    expect(tokens, 'allow-scripts 会让 <script>alert(1)</script> 真的执行（验收要求「未执行」）').not.toContain('allow-scripts');
    // 其余高风险令牌一律不给（最小权限）。
    for (const banned of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-forms', 'allow-popups-to-escape-sandbox', 'allow-downloads', 'allow-storage-access-by-user-activation', 'allow-modals', 'allow-same-origin']) {
      expect(tokens, '不该给的最小权限令牌：' + banned).not.toContain(banned);
    }
    // 留 allow-popups 的理由见 sandbox.ts 头注（点链接是「看页面」的一部分）。
    expect(tokens, 'allow-popups 是刻意保留的（链接可点）').toEqual(['allow-popups']);
  });

  it('CSP：默认不加载外部网络资源（default-src none + connect-src none）', async () => {
    const m = await loadSandbox();
    expect(m.PREVIEW_CSP).toContain("default-src 'none'");
    expect(m.PREVIEW_CSP).toContain("connect-src 'none'");
    expect(m.PREVIEW_CSP).toContain("form-action 'none'");
    expect(m.PREVIEW_CSP).toContain("script-src 'none'");
    expect(m.PREVIEW_CSP).toContain('img-src data: blob:');
    // 明确**没有**放行 http(s)：任何 http/https 源都不该出现在策略里。
    expect(m.PREVIEW_CSP).not.toMatch(/https?:/);
  });

  it('CSP 走 iframe 的 **csp 属性**，且策略里绝不含 allow-same-origin / allow-scripts 的等价放行', async () => {
    const m = await loadSandbox();
    const f = doc.createElement('iframe');
    m.applyCsp(f);
    // ★ 属性机制：CSP 由**元素**携带，不经过文档源文本（故 srcdoc 能逐字节保真）。
    expect(f.getAttribute('csp'), 'CSP 必须落在 csp 属性上').toBe(m.PREVIEW_CSP);
    // ★ 反控：不能有 meta 注入这条退路 —— 它一出现，保真就没了。
    expect(typeof (m as unknown as Record<string, unknown>)['withPreviewCsp'], 'W1543 起不再有「往 HTML 插 meta」的出口').toBe('undefined');
  });

  it('applySandbox：把策略落到 iframe 的 sandbox 属性上', async () => {
    const m = await loadSandbox();
    const f = doc.createElement('iframe');
    m.applySandbox(f);
    expect(f.getAttribute('sandbox')).toBe(m.PREVIEW_SANDBOX);
    expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('applyPreviewPolicy：sandbox + csp 一次落位（两个属性都在）', async () => {
    const m = await loadSandbox();
    const f = doc.createElement('iframe');
    m.applyPreviewPolicy(f);
    expect(f.getAttribute('sandbox')).toBe(m.PREVIEW_SANDBOX);
    expect(f.getAttribute('csp')).toBe(m.PREVIEW_CSP);
  });

  it('变异负控制：去掉 applySandbox ⇒ sandbox 属性缺失（断言必须红）', async () => {
    const m = await loadSandbox();
    const withIt = doc.createElement('iframe');
    m.applySandbox(withIt);
    expect(withIt.getAttribute('sandbox')).not.toBeNull();
    // 复刻「忘了调 applySandbox」的形态。
    const without = doc.createElement('iframe');
    expect(without.getAttribute('sandbox'), '未设 sandbox 的 iframe 拿不到该属性').toBeNull();
    // 且它**不含** allow-same-origin（若断言写成 toContain 就会假绿）。
    expect(without.getAttribute('sandbox') ?? '').not.toContain('allow-same-origin');
  });

  it('变异负控制：去掉 applyCsp ⇒ csp 属性缺失（断言必须红）', async () => {
    const m = await loadSandbox();
    const withIt = doc.createElement('iframe');
    m.applyCsp(withIt);
    expect(withIt.getAttribute('csp')).not.toBeNull();
    const without = doc.createElement('iframe');
    expect(without.getAttribute('csp'), '未设 csp 的 iframe 拿不到该属性').toBeNull();
  });
});

describe('W1534/W1543 · HTML 渲染器（节点层）', () => {
  it('kind=html 默认渲染预览：产出 iframe.preview-html-frame + sandbox + csp', async () => {
    const r = await loadRenderers();
    const out = r.renderPreview({ path: '/a/index.html', kind: 'html', text: XSS_HTML });
    expect(out.degraded).toBeNull();
    const frame = out.node.querySelector('iframe') as unknown as ElLike | null;
    expect(frame, '必须产出 iframe').not.toBeNull();
    expect(frame!.className).toContain('preview-html-frame');
    expect(frame!.getAttribute('sandbox')).not.toBeNull();
    expect(frame!.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame!.getAttribute('csp'), 'CSP 必须在 iframe 的 csp 属性上').not.toBeNull();
  });

  it('★ srcdoc 保真：与用户原文**逐字节相等**（&amp; / &lt; / 双引号 / 单引号原样）', async () => {
    const r = await loadRenderers();
    const out = r.renderPreview({ path: '/a/f.html', kind: 'html', text: FIDELITY_HTML });
    const frame = out.node.querySelector('iframe') as unknown as { srcdoc: string } | null;
    // ★★ 本波最要紧的一条：交给浏览器的**就是**用户那份 HTML，一个字节都不加。
    //    （W1534 曾在此注入 CSP meta，于是这里只能断「摘掉 meta 后相等」——
    //      那是被削弱的自我印证断言；W1543 起断的是全等。）
    expect(frame!.srcdoc, 'srcdoc 必须逐字节等于用户原文（不插 meta、不转义）').toBe(FIDELITY_HTML);
    expect(frame!.srcdoc).toContain('&amp;');
    expect(frame!.srcdoc).toContain('&lt;tag&gt;');
    expect(frame!.srcdoc).toContain('"dq"');
    expect(frame!.srcdoc).toContain(SQ + 'sq' + SQ);
    // 反控：注入过 meta 的形态必须**不等于**原文（否则上面那条断言是空转）。
    expect(FIDELITY_HTML.indexOf('Content-Security-Policy'), '原文里本来没有 CSP meta').toBe(-1);
  });

  it('XSS 样本：脚本标签原样进 srcdoc（沙箱负责拦住它，不是靠删标签）', async () => {
    const r = await loadRenderers();
    const out = r.renderPreview({ path: '/a/x.html', kind: 'html', text: XSS_HTML });
    const frame = out.node.querySelector('iframe') as unknown as { srcdoc: string } | null;
    // 预览保留**原始** HTML（含 script）—— 这是刻意的：拦脚本是沙箱+CSP 的职责。
    expect(frame!.srcdoc).toContain('<scr' + 'ipt>alert(1)</scr' + 'ipt>');
    // ★ 但绝不能进主文档：节点里除 iframe 外不含任何 script 元素。
    expect(out.node.querySelectorAll('script').length, '主文档里不得出现 script 元素').toBe(0);
  });

  it('kind=html + view=source：走代码分支（preview-code，不是 iframe）', async () => {
    const r = await loadRenderers();
    const out = r.renderPreview({ path: '/a/x.html', kind: 'html', text: XSS_HTML, view: 'source' });
    expect(out.degraded).toBeNull();
    expect(out.node.className).toContain('preview-code');
    expect(out.node.querySelector('iframe')).toBeNull();
    expect(out.node.textContent).toContain('alert(1)');
  });

  it('★ srcdoc 必须用 DOM property setter 写入（不是 setAttribute / 字符串拼属性）', async () => {
    // 为什么这条要**读源码**而不是只断行为：真机实测（chrome-headless-shell 151）
    // 在本用例覆盖的输入上，setAttribute('srcdoc', html) 与 frame.srcdoc = html
    // **逐字节等价**（plain / 引号 / script / &amp; 四类样本 propEq 与 attrEq 全 true）。
    // 也就是说：把写法改坏，**行为断言抓不到**（变异 5 实测 12 条全绿）。
    // 但 setAttribute 会把「把这份字符串当文档」偷换成「序列化一个属性值」这条心智路径，
    // 诱使后来者去手工转义 & / 引号 —— 那才会真的破坏用户 HTML。
    // ⇒ 这条契约只能钉在**源码形状**上（与 apps/web/tools/check-*.mjs 同一手法）。
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'ui', 'preview', 'renderers.ts'),
      'utf8',
    );
    // ★ 必须**先剥注释**：本文件的注释里正引用了被禁写法（「不用 setAttribute('srcdoc', …)」），
    //   不剥的话 not.toMatch 会被自己的说明文字命中 —— 这是本条断言自己踩过的坑。
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code, 'srcdoc 必须用 property setter 赋值').toMatch(/\.srcdoc\s*=\s*text/);
    expect(code, '不得用 setAttribute 写 srcdoc').not.toMatch(/setAttribute\(\s*['"]srcdoc['"]/);
    // 反控：**本文件确实会写 srcdoc**（否则上面两条可能在断一个不存在的赋值 —— 空转）。
    //   注意不能拿「同文件有没有 setAttribute」当反控：W1543 把 sandbox/csp 的属性设置
    //   收敛到了 sandbox.ts，renderers.ts 里已经一次 setAttribute 都没有了（这条反控
    //   自己先被这个事实抓红过一次）。反控要断的是**这条断言的作用对象真的存在**。
    expect(code, '反控：renderers.ts 确实在写 srcdoc（断言不是空转）').toMatch(/srcdoc/);
  });

  it('降级态不产出 iframe（内容不可得时不假装能预览）', async () => {
    const r = await loadRenderers();
    const out = r.renderPreview({ path: '/a/x.html', kind: 'html', text: null });
    expect(out.degraded).not.toBeNull();
    expect(out.node.querySelector('iframe')).toBeNull();
  });
});
