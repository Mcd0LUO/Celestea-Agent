// @vitest-environment node
/**
 * 文档不变量：**把文档规则变成机械判定**（W890 学 DSH 的结论）。
 *
 * 我们的规则文本不弱（`docs/README.md` 写着「新增文档必须在上表登记」、每篇有状态），
 * 弱在「规则到执行的最后一公里」——它只是散文，于是：
 *   · 迭代 F/G/H 三篇漏登记过；
 *   · `feature-multimodal-attachments.md` 自称「未实现」而地图写「已实现 P0」；
 *   · `iteration-f/g/h` 一度自称「未实现」而实际已发布。
 *
 * 这里把三件事钉死（都只看 `docs/*.md` 顶层；`research/`、`migration/` 是历史留痕，
 * 地图已声明「不逐篇登记」，故不在范围内）：
 *   ① 登记：每篇顶层文档必须出现在地图里，且地图里的链接必须指向存在的文件/目录；
 *   ② 状态：每篇必须声明状态，且**与地图状态列同属一个类别**（类别是闭集）；
 *   ③ 链接：相对链接必须可达；带锚点的必须命中目标文件的标题。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();
const DOCS = join(REPO, 'docs');
const MAP = join(DOCS, 'README.md');

/** 状态类别是**闭集**：自由文本一律先归类再比较，比较的是类别而不是原文。 */
type StatusClass = '当前' | '已实现' | '设计' | '历史参考' | '已废弃';

function classifyStatus(raw: string): StatusClass | null {
  const t = raw.replace(/[*`]/g, '');
  // 顺序即优先级：'未实现' 必须先于 '已实现' 判断（前者含「实现」二字）。
  if (t.includes('已废弃') || t.includes('废弃')) return '已废弃';
  if (t.includes('历史参考') || t.includes('历史')) return '历史参考';
  if (t.includes('未实现') || t.includes('只调研')) return '设计';
  if (t.includes('已实现')) return '已实现';
  if (t.includes('设计')) return '设计';
  if (t.includes('当前')) return '当前';
  return null;
}

/** 顶层文档（`docs/*.md`，不含地图自己）。 */
function topLevelDocs(): string[] {
  return readdirSync(DOCS).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
}

/** 文档自己声明的状态原文（`> 状态：…` 或表格 `| 状态 | … |`）。 */
function declaredStatus(file: string): string | null {
  const text = readFileSync(file, 'utf8');
  const line = /^>\s*状态：(.+)$/m.exec(text);
  if (line) return line[1]!.trim();
  const cell = /^\|\s*状态\s*\|\s*([^|]+?)\s*\|/m.exec(text);
  if (cell) return cell[1]!.trim();
  return null;
}

interface MapRow { name: string; target: string; status: string; line: number }

/** 地图表格行：`| [名](目标) | 状态 | 一句话 | 权威入口 |`。 */
function mapRows(): MapRow[] {
  const out: MapRow[] = [];
  const lines = readFileSync(MAP, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|/.exec(lines[i]!);
    if (m) out.push({ name: m[1]!, target: m[2]!, status: m[3]!.trim(), line: i + 1 });
  }
  return out;
}

describe('文档不变量', () => {
  it('① 每篇顶层文档都登记在地图里，且地图链接都指向存在的东西', () => {
    const rows = mapRows();
    const registered = new Set(rows.map((r) => r.target.replace(/^\.\//, '')));
    const missing = topLevelDocs().filter((f) => !registered.has(f));
    expect(missing, '这些文档没登记进 docs/README.md 的地图（地图自己写着「必须登记」）').toEqual([]);

    const dead: string[] = [];
    for (const r of rows) {
      if (/^https?:/.test(r.target)) continue;
      const p = resolve(DOCS, r.target.replace(/#.*$/, ''));
      if (!existsSync(p)) dead.push('docs/README.md:' + r.line + ' -> ' + r.target);
    }
    expect(dead, '地图里的链接指向了不存在的东西').toEqual([]);
  });

  it('② 每篇都声明状态，且与地图状态列同类（类别是闭集）', () => {
    const byTarget = new Map(mapRows().map((r) => [r.target.replace(/^\.\//, ''), r]));
    const problems: string[] = [];
    for (const f of topLevelDocs()) {
      const declared = declaredStatus(join(DOCS, f));
      if (declared === null) {
        problems.push(f + ': 没有状态行（应为「> 状态：**当前**」之类）');
        continue;
      }
      const cls = classifyStatus(declared);
      if (cls === null) {
        problems.push(f + ': 状态无法归类（需含 当前/已实现/设计/历史参考/已废弃 之一）：' + declared.slice(0, 40));
        continue;
      }
      const row = byTarget.get(f);
      if (row === undefined) continue; // ① 会报
      const mapCls = classifyStatus(row.status);
      if (mapCls !== cls) {
        problems.push(f + ': 文档说「' + cls + '」而地图说「' + String(mapCls) + '」（地图原文：' + row.status + '）');
      }
    }
    expect(problems, '状态必须在文档与地图之间一致（两处不一致就是漂移）').toEqual([]);
  });

  it('③ 相对链接可达；带锚点的必须命中目标标题', () => {
    const files = [MAP, ...topLevelDocs().map((f) => join(DOCS, f))];
    const problems: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const rel = file.slice(REPO.length + 1);
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i]!.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = m[1]!;
          if (/^(https?:|mailto:|#)/.test(target)) continue;
          const [pathPart, anchor] = target.split('#');
          const resolved = resolve(dirname(file), pathPart!);
          if (!existsSync(resolved)) {
            problems.push(rel + ':' + (i + 1) + ' -> ' + target + '（目标不存在）');
            continue;
          }
          if (anchor === undefined || anchor === '') continue;
          if (!statSync(resolved).isFile() || !resolved.endsWith('.md')) continue;
          if (!headingsOf(resolved).has(anchor.toLowerCase())) {
            problems.push(rel + ':' + (i + 1) + ' -> ' + target + '（锚点不存在）');
          }
        }
      }
    }
    expect(problems, '断链或死锚点').toEqual([]);
  });
});

/** GitHub 风格的标题 slug（够用于本仓的中英混排标题）。 */
function headingsOf(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const slug = m[1]!
      .replace(/[*`_]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    out.add(slug);
  }
  return out;
}
