// @vitest-environment jsdom
/**
 * W1517 · 权限入口合并（档位 + 精细授权 → 一个盾牌）。
 *
 * 权威依据：`docs/feature-permission-entry-merge.md` §3（目标交互）、§4（不变量）、
 * §5（验收 B1–B6）。本文件把「只能有一个入口」「一个面板两块内容」「两块都真落到后端」
 * 「隐藏语义不变」「不留旧 id 别名」钉成机械断言；像素级几何与真机截图见报告
 * `/server-center/runtime/worker-exec/results/W1517-权限入口合并.md`。
 *
 * 加载**真实模块**（不是复刻逻辑）：真实 index.html 骨架 + statusline.ts（档位徽标）
 * + ui/grants.ts（能力位与唯一入口）+ ui/grants/panel/body.ts（合并面板）；
 * 请求经 tests/lib/w795-dom.ts 的真实 fetch 路径打桩。
 *
 * 未覆盖（诚实边界）：真机浏览器里的点击命中与观感（另有 CDP 实测）、Esc 关闭
 * （overlays 层级栈已有 W871/W795 覆盖）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  all,
  at,
  bootGrants,
  click,
  doc,
  el,
  flush,
  grantViaUi,
  health,
  panel,
  resetHarness,
  stub,
  tierText,
  WEB,
  type ElLike,
} from './lib/w795-dom.js';

const indexHtml = (): string => readFileSync(join(WEB, 'index.html'), 'utf8');
const src = (rel: string): string => readFileSync(join(WEB, 'src', rel), 'utf8');
/** 盾牌图标路径（W701 的既有图标；合并**不新画**图标，逐字沿用）。 */
const SHIELD_PATH = 'M8 1.6 13.2 3.4v4.2c0 3.1-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.7-5.2-6.8V3.4z';

interface SlMod {
  statusline: { setSession(id: string): void; stop(): void };
}
interface GrantsMod {
  stopGrants(): void;
}

/** 真实 index.html 的 <body>（与运行时同构，非自造夹具）。 */
function useRealBody(): void {
  const raw = indexHtml();
  doc.body.innerHTML = raw.slice(raw.indexOf('<body>') + 6, raw.indexOf('</body>'));
}

/** 按真实装配顺序起：statusline（档位徽标 + 注册档位宿主）→ grants（能力位 + 入口）。 */
async function boot(): Promise<{ sl: SlMod; grants: GrantsMod }> {
  const sl = (await import(/* @vite-ignore */ at('statusline.ts'))) as SlMod;
  sl.statusline.setSession('ws/s1');
  const grants = (await bootGrants('ws/s1')) as unknown as GrantsMod;
  await flush(4);
  return { sl, grants };
}

/** 递归列出 apps/web/src 下的 .ts/.css 文件（源码面扫描用）。 */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSrc(p, out);
    else if (/\.(ts|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe('W1517 B1 · 状态栏只剩一个权限入口（图标是盾牌）', () => {
  beforeEach(() => resetHarness());
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('index.html：唯一入口是 #slGrant，图标逐字沿用已有盾牌路径，旧档位入口已删', () => {
    const html = indexHtml();
    expect(html, '旧档位入口 id 必须删掉（保留就是「两个入口」的假象）').not.toContain('id="slPerm"');
    expect(html, '旧档位类名一并删掉').not.toContain('sl-perm');
    expect(html).toContain('id="slGrant"');
    expect(html).toContain(SHIELD_PATH);
    expect(html, '档位名并入盾牌徽标区（与授权计数同处一格）').toContain('id="slGrantTier"');
  });

  it('真骨架：.sl-end 里只有这一个权限入口，且只有一个图标（没新画第二个）', () => {
    useRealBody();
    const end = doc.querySelector('.sl-end') as ElLike;
    const entries = Array.from(end.querySelectorAll('button')).filter((b) => /sl-grant|sl-perm/.test(b.className));
    expect(entries.map((b) => b.id)).toEqual(['slGrant']);
    expect(doc.getElementById('slPerm')).toBeNull();
    const btn = doc.getElementById('slGrant') as ElLike;
    expect(btn.querySelectorAll('svg')).toHaveLength(1);
    expect(btn.querySelector('svg path')?.getAttribute('d')).toBe(SHIELD_PATH);
    expect(btn.querySelector('#slGrantTier')).not.toBeNull();
  });

  it('源码面：apps/web 下不再有旧入口 id / 旧档位类名（不留别名）', () => {
    const offenders: string[] = [];
    const files = [...walkSrc(join(WEB, 'src')), join(WEB, 'index.html')];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/slPerm|sl-perm/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('W1517 B2 · 一个面板两块内容，两块都真落到后端', () => {
  let sl: SlMod;
  let grants: GrantsMod;
  beforeEach(async () => {
    resetHarness();
    ({ sl, grants } = await boot());
    click(el('slGrant'));
    await flush(4);
  });
  afterEach(() => {
    grants?.stopGrants();
    sl?.statusline.stop();
    doc.body.replaceChildren();
  });

  it('§1 档位行 + §2 授权行 / 快捷授权同住唯一面板', () => {
    expect(all('#statusline .grant-popup'), '有且只有一个权限面板').toHaveLength(1);
    expect(all('#statusline .perm-popup'), '旧档位弹层不复存在').toHaveLength(0);
    const popup = panel() as ElLike;
    expect(popup.querySelector('.sl-popup-title')?.textContent).toBe('本会话权限');
    expect(Array.from(popup.querySelectorAll('.perm-tier .sl-opt')).map((r) => r.dataset['preset'])).toEqual([
      'read-only',
      'write-read',
      'full-access',
    ]);
    expect(popup.querySelector('.grant-preset'), '§2 快捷授权').not.toBeNull();
    expect(popup.querySelector('.grant-row[data-cap="network"]'), '§2 逐项授权行').not.toBeNull();
    // 徽标区：档位名与授权计数同处一格（不是两行、不是两个元素层级上的两个入口）
    expect(tierText()).toBe('Full access');
  });

  it('§1 切换档位：PUT /api/sessions/{id}/permission 落到后端（请求体逐字）', async () => {
    click(all('#statusline .grant-popup .perm-tier .sl-opt')[1] ?? null); // write-read
    await flush(4);
    const puts = stub.calls.filter((c) => /\/permission$/.test(c.url) && c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe('/api/sessions/ws%2Fs1/permission');
    expect(JSON.parse(puts[0]?.body ?? '{}')).toEqual({ preset: 'write-read' });
    expect(tierText()).toBe('Write + read (workspace)');
  });

  it('§2 执行一次授权：POST /api/sessions/{id}/grants 落到后端（cap 逐字）', async () => {
    await grantViaUi('network');
    const posts = stub.calls.filter((c) => c.url.endsWith('/grants') && c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? '{}').cap).toBe('network');
    expect(stub.granted.has('network')).toBe(true);
  });

  it('I6 关闭面板只摘掉面板本身：背景与状态栏既有节点零改动', () => {
    const messages = doc.getElementById('messages') as ElLike;
    const before = messages.querySelectorAll('*').length;
    const row = doc.querySelector('#statusline .sl-row-main') as ElLike;
    const badge = doc.getElementById('slGrantBadge') as ElLike;
    click(el('slGrant')); // 收起
    expect(panel()).toBeNull();
    expect(messages.querySelectorAll('*').length, '开关面板不触发背景重渲染').toBe(before);
    // 状态栏自己的节点（行、徽标…）一个都没被重建：还是同一批对象
    expect(doc.querySelector('#statusline .sl-row-main')).toBe(row);
    expect(doc.getElementById('slGrantBadge')).toBe(badge);
  });
});

describe('W1517 B4/I1 · i18n 键与三态语义未改名', () => {
  beforeEach(() => resetHarness());
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    doc.body.replaceChildren();
  });

  it('grants.shield.* 与档位键在 zh/en 都在（合并只改入口，不改 key）', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as {
      localeDict(l: string): Record<string, string>;
    };
    const keys = [
      'grants.shield.default',
      'grants.shield.expiring',
      'grants.shield.granted',
      'grants.shield.withTier',
      'grants.body.tierLabel',
      'statusline.perm.title',
      'statusline.perm.noSession',
      'statusline.perm.badgeTitle',
    ];
    for (const locale of ['zh', 'en']) {
      const dict = i18n.localeDict(locale);
      for (const k of keys) expect(dict[k], locale + ' 缺 ' + k).toBeTruthy();
    }
  });

  it('入口标题同时说出三态与档位（同一个元素，单一写者）', async () => {
    const { sl, grants } = await boot();
    expect(el('slGrant').title).toBe('会话档位 Full access · 本会话权限：默认（仅工作区，无网络）');
    stub.granted.add('network');
    await flush(4); // 20s 轮询之外：面板打开会 force refresh 一次
    click(el('slGrant'));
    await flush(4);
    expect(el('slGrant').title).toContain('本会话已放宽 1 项权限');
    expect(el('slGrant').title).toContain('Full access');
    grants.stopGrants();
    sl.statusline.stop();
  });
});

describe('W1517 B5/I2 · 入口隐藏语义不变（能力位未就绪 ⇒ 保持 .hidden）', () => {
  beforeEach(() => resetHarness());
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('capabilities.grants = false：入口保持 .hidden，不置灰、不报错、不因档位而显形', async () => {
    health.value = { ok: true, capabilities: { grants: false, session_mode_tools: true, context: true } };
    const { sl, grants } = await boot();
    expect(el('slGrant').classList.contains('hidden')).toBe(true);
    expect(el('slGrant').disabled, '隐藏 ≠ 置灰禁用').toBe(false);
    expect(tierText(), '档位徽标照常写值（两处降级互不牵连）').toBe('Full access');
    grants.stopGrants();
    sl.statusline.stop();
  });
});
