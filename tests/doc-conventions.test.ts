// @vitest-environment node
/**
 * 文档不变量：把 `docs/AGENT.md` §7 的散文规则变成机械判定（W890 学 DSH 的结论：
 * 规则不弱，弱在「规则到执行的最后一公里」——它只是散文，于是漂移过：
 *   · 迭代 F/G/H 三篇漏登记；
 *   · `feature-multimodal-attachments.md` 自称「未实现」而地图写「已实现 P0」；
 *   · `docs/README.md` 的端点数字从 47 漂到 64。
 *
 * 七条断言：
 *   ① 登记：每篇现行文档（根文档 + 分册索引）必须在地图里，地图链接必须可达；
 *   ② 状态：每篇必须声明状态、与地图同属一个类别（闭集），且现行文档不得是历史类；
 *   ③ 链接：现行文档的相对链接可达，带锚点的必须命中目标标题；
 *   ④ 行数：任何文档（含归档）单篇 ≤ 700 行；
 *   ⑤ 本机事实：提交进仓的文档不得含本机 git 提交身份；
 *   ⑥ 归档：`docs/archive/**` 每篇必须带 `📦` 横幅与历史类状态；
 *   ⑦ 可达：分册目录里的非索引文档必须被该目录的 `README.md` 链接。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();
const DOCS = join(REPO, 'docs');
const MAP = join(DOCS, 'README.md');
const ARCHIVE = join(DOCS, 'archive');
const MAX_LINES = 700;
const LOCAL_ONLY = 'AGENT.local.md'; // 本机文件，gitignore，永不提交

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

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

function relDocs(p: string): string {
  return relative(DOCS, p).split(sep).join('/');
}
function isArchived(p: string): boolean {
  return relDocs(p).startsWith('archive/');
}

/** 现行文档：`docs/**` 里除归档、总索引与本机文件之外的 markdown。 */
function activeDocs(): string[] {
  return walkMd(DOCS).filter(
    (p) => !isArchived(p) && relDocs(p) !== 'README.md' && !p.endsWith(LOCAL_ONLY),
  );
}
/** 需要在总索引登记的：根文档 + 分册索引（`docs/<名字>/README.md`）。 */
function registeredDocs(): string[] {
  return activeDocs().filter((p) => !relDocs(p).includes('/') || p.endsWith('/README.md'));
}
function archiveDocs(): string[] {
  return walkMd(ARCHIVE);
}

/** 文档自己声明的状态原文（`> 状态：…` 或表格 `| 状态 | … |`）。 */
function declaredStatus(file: string): string | null {
  const text = readFileSync(file, 'utf8');
  const line = /^>\s*状态[：:](.+)$/m.exec(text);
  if (line) return line[1]!.trim();
  const cell = /^\|\s*状态\s*\|\s*([^|]+?)\s*\|/m.exec(text);
  if (cell) return cell[1]!.trim();
  return null;
}

interface MapRow { name: string; target: string; status: string; line: number }

/** 地图表格行：`| [名](目标) | 状态 | 一句话 | 权威入口 |`（含归档小节）。 */
function mapRows(): MapRow[] {
  const out: MapRow[] = [];
  const lines = readFileSync(MAP, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|/.exec(lines[i]!);
    if (m) out.push({ name: m[1]!, target: m[2]!, status: m[3]!.trim(), line: i + 1 });
  }
  return out;
}

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

function lineCount(file: string): number {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

describe('文档不变量', () => {
  it('① 每篇现行文档都登记在地图里，且地图链接都指向存在的东西', () => {
    const rows = mapRows();
    const registered = new Set(rows.map((r) => r.target.replace(/^\.\//, '')));
    const missing = registeredDocs()
      .map(relDocs)
      .filter((f) => !registered.has(f));
    expect(missing, '这些文档没登记进 docs/README.md 的地图（地图自己写着「必须登记」）').toEqual([]);

    const dead: string[] = [];
    for (const r of rows) {
      if (/^https?:/.test(r.target)) continue;
      const p = resolve(DOCS, r.target.replace(/#.*$/, ''));
      if (!existsSync(p)) dead.push('docs/README.md:' + r.line + ' -> ' + r.target);
    }
    expect(dead, '地图里的链接指向了不存在的东西').toEqual([]);
  });

  it('② 每篇都声明状态、与地图同类（闭集），且现行文档不得是历史类', () => {
    const byTarget = new Map(mapRows().map((r) => [r.target.replace(/^\.\//, ''), r]));
    const problems: string[] = [];
    for (const p of registeredDocs()) {
      const f = relDocs(p);
      const declared = declaredStatus(p);
      if (declared === null) {
        problems.push(f + ': 没有状态行（应为「> 状态：**当前**」之类）');
        continue;
      }
      const cls = classifyStatus(declared);
      if (cls === null) {
        problems.push(f + ': 状态无法归类（需含 当前/已实现/设计/历史参考/已废弃 之一）：' + declared.slice(0, 40));
        continue;
      }
      if (cls === '历史参考' || cls === '已废弃') {
        problems.push(f + ': 现行文档不能是「' + cls + '」——历史文档要 git mv 进 docs/archive/');
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
    // W893: 归档文档也在范围内 —— 归档最容易留下指向「原来那个位置」的死链。
    const files = [MAP, ...activeDocs(), ...archiveDocs()];
    const problems: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const rel = relDocs(file);
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i]!.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = m[1]!;
          if (/^(https?:|mailto:|#)/.test(target)) continue;
          // A documented prose example in a research note writes `[名](路径)`;
          // that is a placeholder, not a link. Skip it explicitly (and only it).
          if (target === '路径') continue;
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

  it('④ 任何文档单篇 ≤ 700 行（超了就拆进同名子目录）', () => {
    const over = [...activeDocs(), ...archiveDocs()]
      .map((p) => ({ f: relDocs(p), n: lineCount(p) }))
      .filter((x) => x.n > MAX_LINES)
      .map((x) => x.f + ' = ' + x.n + ' 行');
    expect(over, '这些文档超了 ' + MAX_LINES + ' 行硬上限').toEqual([]);
  });

  it('⑤ 提交进仓的文档不含本机 git 提交身份', () => {
    const problems: string[] = [];
    const files = [...activeDocs(), ...archiveDocs(), join(REPO, 'README.md')];
    for (const p of files) {
      const text = readFileSync(p, 'utf8');
      if (text.includes('users.noreply.github.com')) {
        problems.push(relDocs(p) + ' 含本机提交身份（应写进 docs/AGENT.local.md）');
      }
    }
    expect(problems, '机器相关的事实不进提交进仓的文档').toEqual([]);
  });

  it('⑥ 归档文档带 `📦` 横幅与历史类状态', () => {
    const problems: string[] = [];
    for (const p of archiveDocs()) {
      const f = relDocs(p);
      const text = readFileSync(p, 'utf8');
      if (!text.includes('📦')) problems.push(f + ': 缺 `📦 历史文档` 横幅');
      const declared = declaredStatus(p);
      if (declared === null) {
        problems.push(f + ': 没有状态行');
        continue;
      }
      const cls = classifyStatus(declared);
      if (cls !== '历史参考' && cls !== '已废弃') {
        problems.push(f + ': 归档文档的状态必须是 历史参考/已废弃，现在是「' + String(cls) + '」');
      }
    }
    expect(problems, '归档目录不是垃圾桶：每篇都要有横幅与历史状态').toEqual([]);
  });

  it('⑦ 分册目录里的非索引文档必须被该目录的 README 链接', () => {
    const problems: string[] = [];
    const dirs = new Set(
      activeDocs()
        .map((p) => relDocs(p).split('/')[0]!)
        .filter((d) => d !== undefined && !d.endsWith('.md')),
    );
    for (const d of dirs) {
      const index = join(DOCS, d, 'README.md');
      if (!existsSync(index)) {
        problems.push('docs/' + d + '/ 缺 README.md 索引');
        continue;
      }
      const idx = readFileSync(index, 'utf8');
      for (const p of activeDocs()) {
        const r = relDocs(p);
        if (!r.startsWith(d + '/') || r.endsWith('/README.md')) continue;
        const base = r.slice(d.length + 1);
        if (!idx.includes('(./' + base + ')') && !idx.includes('(' + base + ')')) {
          problems.push('docs/' + d + '/README.md 没有链接到 ' + base);
        }
      }
    }
    expect(problems, '分册必须从它的索引可达').toEqual([]);
  });
});
