// @vitest-environment node
/**
 * 文案门禁 · 护栏 A 的 console 口径：
 *   · console.warn/error 里的中文 = 开发诊断 ⇒ 不触发护栏 A（否则永远留在白名单里，虚高）；
 *   · 真正的用户可见中文仍必须被抓到（反例）；
 *   · throw new Error('中文') 不豁免（本仓多处 err.message 会渲染到界面）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface GateMod { runGate(root?: string): { problems: string[]; warnings: string[]; stats: Record<string, number> } }

const GATE = pathToFileURL(join(process.cwd(), 'apps', 'web', 'tools', 'check-ui-copy.mjs')).href;
const load = async (): Promise<GateMod> => (await import(/* @vite-ignore */ GATE)) as GateMod;

let dir = '';
function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'copy-gate-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf8');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'src', name), content, 'utf8');
  return dir;
}

describe('文案门禁 · 护栏 A 的 console 口径', () => {
  beforeEach(() => { dir = ''; });
  afterEach(() => { if (dir !== '') rmSync(dir, { recursive: true, force: true }); });

  it('console.warn 里的中文不触发护栏 A', async () => {
    const root = fixture({ 'a.ts': 'export function f(): void { console.warn("[x] 开发诊断：中文不该被算作文案"); }\n' });
    const { problems } = (await load()).runGate(root);
    expect(problems.filter((p) => p.includes('护栏 A')), 'console 实参不算用户可见').toEqual([]);
  });

  it('console.error / console.log 同样豁免', async () => {
    const root = fixture({ 'a.ts': 'console.log("中文日志");\nconsole.error("中文错误日志");\n' });
    const { problems } = (await load()).runGate(root);
    expect(problems.filter((p) => p.includes('护栏 A'))).toEqual([]);
  });

  it('反例：真正的用户可见中文仍必须被抓到', async () => {
    const root = fixture({ 'b.ts': 'export const label = "用户可见的中文按钮";\n' });
    const { problems } = (await load()).runGate(root);
    expect(problems.some((p) => p.includes('护栏 A') && p.includes('用户可见的中文按钮')), '用户可见中文必须被抓').toBe(true);
  });

  it('反例：throw new Error 的中文不豁免（err.message 会渲染）', async () => {
    const root = fixture({ 'c.ts': 'export function f(): void { throw new Error("目标没有保存：请稍后重试"); }\n' });
    const { problems } = (await load()).runGate(root);
    expect(problems.some((p) => p.includes('护栏 A')), 'throw 的中文仍属用户可见').toBe(true);
  });
});
