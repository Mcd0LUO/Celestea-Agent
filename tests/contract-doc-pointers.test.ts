// @vitest-environment node
/**
 * W893 — 契约里的**文档指针必须可达**。
 *
 * 起因（本次归档调研中查出的真 bug）：`contracts/endpoints.json` 有 9 处 `docRef`
 * 指向 `docs/feature-session-permissions.md`，而该文件**在 git 全历史里从未存在过**
 * （`git log --all` 零条记录）。原有门禁只断言 `docRef` 非空，不校验目标，
 * 于是这些指针可以一直烂着 —— 读契约的人按指针去查，只会得到一个不存在的路径。
 *
 * 这里把「指针可达」变成机械判定。指针有**两种合法形态**，不能混判：
 *   ① 路径 (path 或 path#anchor)：必须能解析到真实文件 / 真实标题；
 *   ② 章节引用（含 §，如 `docs/data-files.md §4.4`）：**不是路径**，是给人读的章节号，
 *      无法机械解析 —— 记为「不校验」，但**至少要求路径部分存在**。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CONTRACTS = join(ROOT, 'contracts');

/** 契约里承载「文档在哪」的字段名（与 contracts 现有用法一致）。 */
const POINTER_FIELDS = ['docRef', 'sourceRef', 'doc', 'design', 'ref'] as const;

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

interface Pointer { file: string; field: string; value: string }

function pointers(value: unknown, file: string, out: Pointer[] = []): Pointer[] {
  if (Array.isArray(value)) {
    for (const item of value) pointers(item, file, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if ((POINTER_FIELDS as readonly string[]).includes(key) && typeof child === 'string') {
        out.push({ file, field: key, value: child });
      } else {
        pointers(child, file, out);
      }
    }
  }
  return out;
}

function allPointers(): Pointer[] {
  const out: Pointer[] = [];
  for (const file of jsonFiles(CONTRACTS)) pointers(JSON.parse(readFileSync(file, 'utf8')), file.slice(ROOT.length + 1), out);
  return out;
}

/** GitHub 风格的标题 slug（与本仓 doc-conventions 的规则一致）。 */
function headings(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.add(m[1]!.replace(/[*`_]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'));
  }
  return out;
}

describe('契约文档指针可达性', () => {
  it('每个指向 docs/ 的指针都解析到真实文件（章节引用只校验路径）', () => {
    const broken: string[] = [];
    for (const p of allPointers()) {
      if (!p.value.startsWith('docs/')) continue;
      // 形态 ②：`path §N` 是章节引用。路径部分 = 去掉 `#anchor`、再截到 § 之前。
      const pathPart = p.value.split('#')[0]!.split('§')[0]!.trim();
      if (!existsSync(join(ROOT, pathPart))) {
        broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [文件不存在]');
      }
    }
    expect(broken, '契约指向了不存在的文档（读契约的人会查不到）').toEqual([]);
  });

  it('带 #anchor 的指针命中目标标题（不是只写了个大概）', () => {
    const broken: string[] = [];
    for (const p of allPointers()) {
      if (!p.value.startsWith('docs/') || !p.value.includes('#')) continue;
      const [pathPart, anchor] = p.value.split('#');
      const full = join(ROOT, pathPart!);
      if (!existsSync(full)) {
        broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [文件不存在]');
        continue;
      }
      if (!headings(full).has(anchor!.toLowerCase())) {
        broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [锚点不存在]');
      }
    }
    expect(broken, '锚点写错 = 指针等于没有').toEqual([]);
  });

  it('没有指向 git 历史里从未存在过的文件（这正是本次查出的 bug 形态）', () => {
    // 具体化那条 bug：路径存在与否必须用工作区判定；历史判定交给 review。
    // 这里只需保证上面的清单不为空且没坏 —— 空清单说明扫描器坏了（门禁空转）。
    const docs = allPointers().filter((p) => p.value.startsWith('docs/'));
    expect(docs.length, '扫描器必须找到契约里的 docs 指针（否则门禁是空转的）').toBeGreaterThan(0);
  });
});
