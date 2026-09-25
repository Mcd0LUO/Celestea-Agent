// @vitest-environment jsdom
/**
 * W858 · 权限预设 UI（设置页「权限预设」pane + statusline 会话档位选择器）。
 *
 * 权威依据：contracts/endpoints.json 的 permissions 组六个端点 + 任务书 A/B 两节。
 * 加载**真实模块**（不是复刻逻辑）：ui/permissions/index.ts 的 loadPermissionsSection、
 * statusline.ts 的会话档位徽标；请求经 tests/lib/w795-dom.ts 的真实 fetch 路径打桩。
 *
 * 覆盖：
 *   ① pane 渲染内置 3 档 + 读到运行时封顶 max（内置档无编辑/删除入口）；
 *   ② 新建自定义预设的 POST 请求体字段齐全（8 个字段逐一对拍）；
 *   ③ 422 时后端 error 原文就地在表单旁显示，坏档先乐观插入、失败后回滚移除；
 *   ④ 会话选择器点选当帧改徽标 + PUT 成功保持 + 422 回滚并说明原因；
 *   ⑤ 新增 CSS 不引入 dashed/dotted、圆角一律走 token。
 *
 * 未覆盖（诚实边界）：真机浏览器的点击命中、CSS 观感、Esc 关闭；删除确认弹窗
 * （走既有 confirmDialog，另有 W792 覆盖）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  all,
  at,
  bootGrants,
  click,
  confirmOk,
  doc,
  el,
  Ev,
  flush,
  permStub,
  resetHarness,
  stub,
  tierText,
  type ElLike,
} from './lib/w795-dom.js';

const PANE = '#settingsPermissions';
/**
 * W1517（权限入口合并）：档位不再有自己的弹层 —— 列表/切换住**唯一**的盾牌面板
 * （#statusline .grant-popup）的 §1；断言内容逐条未改，只换了面板与入口的选择器。
 */
const POPUP = '#statusline .grant-popup';
type CheckLike = ElLike & { checked: boolean };
interface SlMod {
  statusline: { setSession(id: string): void; stop(): void };
}
interface PaneMod {
  loadPermissionsSection(): Promise<void>;
}
interface GrantsMod {
  stopGrants(): void;
}

/** 表单/菜单查询助手（断言全部留在 it 里）。 */
const findRow = (sel: string, textSel: string, text: string): ElLike | null =>
  all(sel).find((r) => (r.querySelector(textSel)?.textContent ?? '') === text) ?? null;
function setText(label: string, value: string): void {
  const input = findRow(PANE + ' .cfg-field', '.cfg-label', label)?.querySelector('input');
  if (input) input.value = value;
}
function setSwitch(label: string, on: boolean): void {
  const input = findRow(PANE + ' .perm-switch', '.perm-switch-label', label)?.querySelector(
    'input',
  ) as CheckLike | null;
  if (input) input.checked = on;
}
function setTool(name: string, on: boolean): void {
  const input = findRow(PANE + ' .perm-tool', '.perm-tool-name', name)?.querySelector(
    'input',
  ) as CheckLike | null;
  if (input) {
    input.checked = on;
    input.dispatchEvent(new Ev('change'));
  }
}
function press(label: string): void {
  click(all(PANE + ' button').find((b) => (b.textContent ?? '').trim() === label) ?? null);
}
function callsTo(url: string, method: string): { url: string; method: string; body: string }[] {
  return stub.calls.filter((c) => c.url === url && c.method === method);
}
const cardIds = (): (string | undefined)[] =>
  all(PANE + ' .perm-card').map((c) => c.dataset['id']);

describe('W858 ① pane：内置三档 + 运行时封顶', () => {
  let pane: PaneMod;
  beforeEach(async () => {
    resetHarness();
    pane = (await import(/* @vite-ignore */ at('ui/permissions/index.ts'))) as PaneMod;
  });

  it('渲染内置 3 档、读到 max，内置档不可改不可删且 toolDeny 用中文 chip', async () => {
    await pane.loadPermissionsSection();
    await flush(4);
    expect(cardIds()).toEqual(['read-only', 'write-read', 'full-access']);
    expect(all(PANE + ' .perm-badge').map((n) => n.textContent)).toEqual(['内置', '内置', '内置']);
    expect(doc.querySelector(PANE + ' .perm-max')?.textContent ?? '').toContain(
      '运行时封顶：full-access',
    );
    expect(all(PANE + ' .perm-card[data-builtin="1"] .perm-card-ops')).toHaveLength(0);
    const ro = doc.querySelector(PANE + ' .perm-card[data-id="read-only"]');
    expect(ro?.textContent ?? '').toContain('禁写文件');
    const fa = doc.querySelector(PANE + ' .perm-card[data-id="full-access"]');
    expect(fa?.textContent ?? '').toContain('CELESTEA_GRANTS_UNSANDBOXED');
    // W864：整机可读写是 full-access 的显式能力，卡片与只读档都要如实呈现。
    expect(fa?.textContent ?? '').toContain('全部目录可读写');
    expect(ro?.textContent ?? '').toContain('限定在授权目录');
  });

  it('max 低于所选档时也如实展示（不替用户修正成 full-access）', async () => {
    permStub.max = 'write-read';
    await pane.loadPermissionsSection();
    await flush(4);
    expect(doc.querySelector(PANE + ' .perm-max')?.textContent ?? '').toContain(
      '运行时封顶：write-read',
    );
  });
});

describe('W858 ②③ 自定义预设编辑器：请求体 + 422 回滚', () => {
  let pane: PaneMod;
  beforeEach(async () => {
    resetHarness();
    pane = (await import(/* @vite-ignore */ at('ui/permissions/index.ts'))) as PaneMod;
    await pane.loadPermissionsSection();
    await flush(4);
    click(el('btnNewPreset'));
    await flush(3); // 工具清单（GET /api/tools）落定
  });

  it('② 新建：POST 请求体的 preset 九个字段齐全（含 W864 allPaths）', async () => {
    setText('预设 id', 'deploy-docs');
    setText('显示名', '部署文档');
    setSwitch('网络访问', true);
    setSwitch('工作区可写', true);
    setSwitch('工具根可写', false);
    setSwitch('全部目录可读写', true); // W864：开关必须进提交体
    setSwitch('免沙箱（声明）', false);
    const rootInput = doc.querySelector(PANE + ' .perm-addrow input');
    if (rootInput) rootInput.value = '/srv/data';
    press('添加');
    setTool('write_file', true);

    press('保存');
    const body = callsTo('/api/permissions/presets', 'POST')[0]?.body ?? '{}';
    const preset = (JSON.parse(body) as { preset: Record<string, unknown> }).preset;
    expect(preset).toEqual({
      id: 'deploy-docs',
      label: '部署文档',
      network: true,
      workspaceWritable: true,
      toolRootsWritable: false,
      writeRoots: ['/srv/data'],
      allPaths: true,
      unsandboxed: false,
      toolDeny: ['write_file'],
    });
    expect(Object.keys(preset).sort()).toEqual([
      'allPaths',
      'id',
      'label',
      'network',
      'toolDeny',
      'toolRootsWritable',
      'unsandboxed',
      'workspaceWritable',
      'writeRoots',
    ]);
    await flush(4);
    expect(cardIds()).toContain('deploy-docs');
  });

  it('③ 422：错误原文就地显示、坏档先乐观插入后回滚移除', async () => {
    permStub.createStatus = 422;
    permStub.createError = 'invalid preset: writeRoots[0] must be absolute';
    setText('预设 id', 'bad-one');
    setText('显示名', '坏档');
    press('保存');
    // 乐观：同一帧（同步、未 await 网络）卡片已经在列表里
    expect(cardIds()).toContain('bad-one');
    await flush(4);
    expect(cardIds()).not.toContain('bad-one'); // 失败回滚：坏档不许留在列表
    const status = doc.querySelector(PANE + ' .perm-editor-status');
    expect(status?.textContent ?? '').toContain('invalid preset: writeRoots[0] must be absolute');
    expect(status?.classList.contains('err')).toBe(true);
    // 编辑器留在屏幕上（可改后重试），没有「保存中」这类占位
    expect(doc.querySelector(PANE + ' .perm-editor')?.classList.contains('hidden')).toBe(false);
    expect(doc.querySelector(PANE + ' .perm-editor')?.textContent ?? '').not.toMatch(/保存中|正在/);
  });
});

describe('W858 ② 编辑/删除自定义档：乐观替换与回滚', () => {
  let pane: PaneMod;
  beforeEach(async () => {
    resetHarness();
    permStub.custom = [
      {
        id: 'deploy-docs',
        label: '部署文档',
        network: false,
        workspaceWritable: true,
        toolRootsWritable: false,
        writeRoots: ['/srv/data'],
        allPaths: false,
        unsandboxed: false,
        toolDeny: [],
      },
    ];
    pane = (await import(/* @vite-ignore */ at('ui/permissions/index.ts'))) as PaneMod;
    await pane.loadPermissionsSection();
    await flush(4);
  });

  const cardButton = (label: string): void => {
    const card = doc.querySelector(PANE + ' .perm-card[data-id="deploy-docs"]');
    const buttons = Array.from(card?.querySelectorAll('button') ?? []);
    click(buttons.find((b) => (b.textContent ?? '').trim() === label) ?? null);
  };

  it('编辑：id 锁定、保存走 PUT、卡片当帧换成新值', async () => {
    cardButton('编辑');
    await flush(3);
    const idInput = findRow(PANE + ' .cfg-field', '.cfg-label', '预设 id')?.querySelector('input');
    expect(idInput?.disabled).toBe(true);
    expect(idInput?.value).toBe('deploy-docs');
    setText('显示名', '部署文档（新）');
    press('保存');
    // 乐观：同一帧卡片标题已是新值
    expect(
      doc.querySelector(PANE + ' .perm-card[data-id="deploy-docs"] .perm-card-title')?.textContent,
    ).toBe('部署文档（新）');
    await flush(4);
    const call = callsTo('/api/permissions/presets/deploy-docs', 'PUT')[0];
    const preset = (JSON.parse(call?.body ?? '{}') as { preset: Record<string, unknown> }).preset;
    expect(preset['id']).toBe('deploy-docs');
    expect(preset['label']).toBe('部署文档（新）');
    expect(preset['writeRoots']).toEqual(['/srv/data']);
    expect(
      doc.querySelector(PANE + ' .perm-card[data-id="deploy-docs"] .perm-card-title')?.textContent,
    ).toBe('部署文档（新）');
  });

  it('删除：确认后乐观移除；服务端拒绝则把卡片插回并说明原因', async () => {
    permStub.deleteStatus = 409;
    permStub.deleteError = "'deploy-docs' is a built-in preset";
    cardButton('删除');
    await flush(2);
    click(confirmOk());
    // 只排空微任务（confirm 的续体）：乐观移除已发生，DELETE 的响应还没回来
    await Promise.resolve();
    expect(cardIds()).not.toContain('deploy-docs'); // 乐观：确认后卡片立刻消失
    await flush(4);
    expect(cardIds()).toContain('deploy-docs'); // 409 ⇒ 插回
    expect(doc.querySelector(PANE + ' .perm-status')?.textContent ?? '').toContain(
      'is a built-in preset',
    );
  });
});

describe('W858 ④ statusline 会话档位选择器（W1517：住合并后的盾牌面板）', () => {
  let sl: SlMod;
  let grants: GrantsMod;
  beforeEach(async () => {
    resetHarness();
    sl = (await import(/* @vite-ignore */ at('statusline.ts'))) as SlMod;
    // W1517：入口与面板都归提权通道（能力位决定显隐），所以夹具按**真实装配顺序**
    // 起：statusline（档位徽标 + 注册档位宿主）→ grants（能力位 + 盾牌面板）。
    grants = await bootGrants('ws/s1');
    sl.statusline.setSession('ws/s1'); // 聚焦会话（档位徽标与面板共用同一份）
    await flush(4);
  });
  afterEach(() => {
    grants?.stopGrants();
    sl?.statusline.stop();
  });

  it('徽标 = 当前档位；面板列出三档 + 封顶 + 风险行；点选当帧换徽标', async () => {
    // W1517：唯一入口是盾牌；它的显隐由能力位决定（这里 grants=true ⇒ 可见），
    // 档位名住在同一徽标区（#slGrantTier），与授权计数同处一格。
    expect(el('slGrant').classList.contains('hidden')).toBe(false);
    expect(tierText()).toBe('Full access');
    click(el('slGrant'));
    await flush(3);
    const rows = all(POPUP + ' .sl-opt');
    expect(rows.map((r) => r.dataset['preset'])).toEqual([
      'read-only',
      'write-read',
      'full-access',
    ]);
    const popupText = doc.querySelector(POPUP)?.textContent ?? '';
    expect(popupText).toContain('运行时封顶：full-access');
    expect(popupText).toContain('此档允许网络访问'); // full-access 含 network 的静态风险行
    expect(popupText).toContain('CELESTEA_GRANTS_UNSANDBOXED');
    permStub.putStatus = 422;
    permStub.putError = "unknown preset 'read-only'";
    click(rows[0] ?? null);
    // 当帧（同步、未 await 网络）：徽标已经是目标档
    expect(tierText()).toBe('Read only');
    await flush(4);
    expect(tierText(), 'PUT 失败 ⇒ 回滚到原档').toBe('Full access');
    const status = doc.querySelector(POPUP + ' .sl-popup-status');
    expect(status?.textContent ?? '').toContain("unknown preset 'read-only'");
    expect(status?.textContent ?? '').toContain('已恢复原档位');
    expect(el('slHint').textContent).toContain('已恢复原档位');
    expect(doc.querySelector(POPUP), '菜单留着，用户可重选').not.toBeNull();
  });

  it('PUT 成功：徽标保持新档、面板留着（还承载精细授权）、轻提示可见且无占位文案', async () => {
    click(el('slGrant'));
    await flush(3);
    click(all(POPUP + ' .sl-opt')[1] ?? null); // write-read
    expect(tierText()).toBe('Write + read (workspace)');
    expect(el('slHint').textContent).not.toMatch(/切换中|正在/);
    await flush(4);
    expect(tierText()).toBe('Write + read (workspace)');
    // W1517：面板不再因切档而收起 —— 同一个面板还装着 §2 精细授权，
    // 切一档就收起会让用户「再授予还得重新点开」。
    expect(doc.querySelector(POPUP), '面板留着').not.toBeNull();
    expect(permStub.sessionPreset).toBe('write-read');
  });

  it('无活动会话：档位徽标留空，面板说明并禁用全部档位（入口本身仍可用）', async () => {
    // 会话切空（面板与徽标共用同一份聚焦会话：statusline.session → viewctx）
    sl.statusline.setSession('');
    await flush(3);
    // W1517：入口的显隐真源只剩能力位（这里 grants=true ⇒ 入口仍可见）——
    // 否则「档位端点/会话缺失」会把精细授权一起藏掉（设计 §4 I2）。
    expect(el('slGrant').classList.contains('hidden')).toBe(false);
    expect(tierText()).toBe('');
    click(el('slGrant'));
    await flush(3);
    const rows = all(POPUP + ' .sl-opt');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.disabled)).toBe(true);
    expect(doc.querySelector(POPUP)?.textContent ?? '').toContain('当前没有打开的会话');
  });
});

describe('W858 ⑤ 样式机械门禁', () => {
  const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'styles');
  beforeEach(() => {
    resetHarness();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('apps/web/src/styles 下不得出现 dashed / dotted', () => {
    const bad: string[] = [];
    for (const name of readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort()) {
      const lines = readFileSync(join(STYLES, name), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/\b(dashed|dotted)\b/.test(lines[i] ?? '')) bad.push(name + ':' + String(i + 1));
      }
    }
    expect(bad).toEqual([]);
  });

  it('permissions.css 的圆角一律走 --r-*（无硬编码 px；999px 胶囊除外）', () => {
    const text = readFileSync(join(STYLES, 'permissions.css'), 'utf8');
    const radii = Array.from(text.matchAll(/border-radius\s*:\s*([^;]+);/g), (m) => (m[1] ?? '').trim());
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.filter((v) => /\d+px/.test(v) && !v.includes('999px'))).toEqual([]);
  });
});
