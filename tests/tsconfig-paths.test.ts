// @vitest-environment node
/**
 * W891 — 「源码直跑」必须真的跑源码。
 *
 * 起因：CI 加上 windows/ubuntu 全新检出后立刻暴露——`pnpm --dir apps/studio start`
 * （= `tsx src/main.ts`，cwd 在 apps/studio）会就近读 `apps/studio/tsconfig.json`。
 * 该文件原先只继承 `tsconfig.base.json`（**没有** `paths`），于是 `@celestea/core`
 * 被解析到 gitignored 的 `packages/core/dist/`：所谓源码直跑其实跑的是**上一次构建的产物**，
 * 全新检出直接 `ERR_MODULE_NOT_FOUND`。这条断言把这个陷阱钉死。
 *
 * 为什么不能只靠「跑一次试试」：本机 `dist/` 常年存在，缺失只在别人机器/CI 上出现——
 * 正是「门禁只在人记得跑时存在」的那类问题。
 *
 * 实现说明：**不做 JSON.parse**。tsconfig 允许注释，而天真的注释剥离会连
 * include 的 glob 一起吃掉（真踩过）。这里按文本提取。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** `"extends": "…"` 的值（单行或数组形式的第一个元素）。 */
function extendsOf(tsconfig: string): string | null {
  const text = readFileSync(tsconfig, 'utf8');
  const single = /"extends"\s*:\s*"([^"]+)"/.exec(text);
  if (single !== null) return single[1]!;
  const array = /"extends"\s*:\s*\[\s*"([^"]+)"/.exec(text);
  return array === null ? null : array[1]!;
}

/** 文件里出现的所有 `@celestea/*` paths 映射（跨行数组也认）。 */
function pathsOf(tsconfig: string): Array<{ key: string; targets: string[] }> {
  const text = readFileSync(tsconfig, 'utf8');
  const out: Array<{ key: string; targets: string[] }> = [];
  const re = /"(@celestea\/[a-z0-9-]+)"\s*:\s*\[([\s\S]*?)\]/g;
  for (const m of text.matchAll(re)) {
    const targets = [...m[2]!.matchAll(/"([^"]+)"/g)].map((t) => t[1]!);
    out.push({ key: m[1]!, targets });
  }
  return out;
}

/** 顺着 extends 链收集 paths（子配置优先，和 tsc 一致）。 */
function resolvedPaths(tsconfig: string): Array<{ key: string; targets: string[]; from: string }> {
  const out = new Map<string, { targets: string[]; from: string }>();
  const seen = new Set<string>();
  let current: string | null = tsconfig;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    for (const { key, targets } of pathsOf(current)) {
      if (!out.has(key)) out.set(key, { targets, from: current });
    }
    const next = extendsOf(current);
    current = next === null ? null : resolve(dirname(current), next);
  }
  return [...out].map(([key, v]) => ({ key, targets: v.targets, from: v.from }));
}

/** 以源码直跑（tsx）的入口配置，不是先构建再跑。 */
const RUN_FROM_SOURCE = ['apps/studio/tsconfig.json', 'apps/cli/tsconfig.json'];

describe('W891 源码直跑必须解析到 src，而不是 dist', () => {
  it.each(RUN_FROM_SOURCE)('%s 的 extends 链里有 @celestea/* 的 paths', (rel) => {
    const paths = resolvedPaths(join(ROOT, rel));
    expect(paths.length, rel + ' 的 extends 链里没有任何 @celestea/* paths').toBeGreaterThan(0);
    const core = paths.find((p) => p.key === '@celestea/core');
    expect(core, rel + ' 必须能解析 @celestea/core（否则 tsx 会落到 packages/core/dist）').toBeDefined();
    for (const { key, targets } of paths) {
      expect(targets.length, rel + ' 的 ' + key + ' 是空数组').toBeGreaterThan(0);
      for (const target of targets) {
        expect(target, rel + ' 的 ' + key + ' 不得指向 dist（那正是本断言要防的陷阱）').not.toContain('dist');
        expect(existsSync(resolve(ROOT, target)), rel + ' 的 ' + key + ' -> ' + target + ' 必须存在').toBe(true);
      }
    }
  });

  it('构建配置仍然不带 paths（构建要按依赖顺序解析各自 dist）', () => {
    for (const rel of ['apps/studio/tsconfig.build.json', 'apps/cli/tsconfig.build.json']) {
      expect(pathsOf(join(ROOT, rel)).length, rel + ' 不应带 paths').toBe(0);
    }
  });

  it('子进程跑 tsx 的地方固定了 tsconfig（cwd 是临时目录时否则找不到）', () => {
    const spawnSite = readFileSync(join(ROOT, 'apps/studio/src/main.test.ts'), 'utf8');
    expect(spawnSite, 'main.test.ts 的 cwd 是 tmpdir：不固定 tsconfig 就会去解析 dist').toContain('TSX_TSCONFIG_PATH');
  });
});
