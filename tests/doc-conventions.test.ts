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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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

/**
 * ③b 的实现：现行文档里的 `file:line` 锚点必须落在真实文件的**非空行**上。
 *
 * 抽成模块级函数而不是留在 `it()` 里：`it()` 的回调有 150 行上限（AGENT.md §7），
 * 而这段含两段 WHY 注释，直接写进去会超（真实踩到：187 > 150）。
 *
 * 两个刻意的范围收窄（都由实测决定，不是图省事）：
 *   · **不含归档**：归档是冻结的历史快照，锚点本来就该停在写下那天（§7 规则 7
 *     「归档不是删除，不删正文」）。纳入会逼人改历史 —— 比锚点漂移更糟。
 *   · **跳过围栏代码块**：块里是「当时跑过的命令 + 当时的输出」（grep 结果、探针
 *     输出），那是**记录**不是引用，必须原样保留才能被追溯。
 */
function anchorProblems(): string[] {
  const problems: string[] = [];
  for (const p of activeDocs()) {
    let inFence = false;
    const text = readFileSync(p, 'utf8')
      .split('\n')
      .map((line) => {
        if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
        return inFence ? '' : line;
      })
      .join('\n');
    for (const m of text.matchAll(/([a-zA-Z0-9_@/.-]+\.(?:ts|mjs|js|css)):(\d+)/g)) {
      const target = m[1]!;
      const line = Number(m[2]);
      const candidates = [target, target.replace(/^@celestea\//, ''), 'packages/' + target, 'apps/' + target];
      const real = candidates.find((c) => existsSync(join(REPO, c)));
      if (real === undefined) continue; // 不是仓内文件：外部引用/包名，跳过
      const body = readFileSync(join(REPO, real), 'utf8').split('\n');
      if (line > body.length) {
        problems.push(relDocs(p) + ': ' + m[0] + ' 越界（该文件只有 ' + body.length + ' 行）');
      } else if ((body[line - 1] ?? '').trim() === '') {
        problems.push(relDocs(p) + ': ' + m[0] + ' 指向空行');
      }
    }
  }
  return problems;
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

  it('①b 地图表格的每一行都是完整的 4 列（防行错位/合并）', () => {
    // WHY: `mapRows()` 的正则只认「行首有 | [链接](目标) | 状态 |」这一形状，于是
    // **两行被误合并成一行**时它照样匹配（取到第一个状态列就停），坏行静默通过
    // 全部 7 条断言 —— 真实发生过：feature-display-components 与
    // feature-dynamic-tool-disclosure 两行被并成一行，多出的两列挂在行尾。
    // 机械判据：索引表里每个数据行的**段数**必须与表头一致。
    const lines = readFileSync(MAP, 'utf8').split('\n');
    const header = lines.find((l) => /^\|\s*文件\s*\|/.test(l));
    expect(header, 'docs/README.md 里找不到索引表的表头').toBeDefined();
    const width = header!.split('|').length;
    const bad: string[] = [];
    let inTable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === header) { inTable = true; continue; }
      if (!inTable) continue;
      if (!line.startsWith('|')) break; // 表结束
      const cells = line.split('|').length;
      if (cells !== width) bad.push('第 ' + (i + 1) + ' 行有 ' + cells + ' 段，表头是 ' + width + ' 段');
    }
    expect(bad, '地图索引表的行错位了（多半是两行被合并）').toEqual([]);
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

  it('③b 文档里的 `file:line` 锚点指向真实存在的非空行', () => {
    // WHY: 172 个锚点靠人眼不可能维护。真实漂移过：`routes.ts:48` 在文件只有 44 行
    // 时指向空行、`turn-id.ts:25-47` 在内容搬到 core 后指向一个 16 行的重导出垫片。
    // 判据与两处范围收窄见 `anchorProblems()` 的注释。
    expect(anchorProblems(), '文档里的 file:line 锚点漂了（文件搬走/行号变了）').toEqual([]);
  });

});

/**
 * ⑤ 的一部分：现行文档不得把**本仓的 checkout 绝对路径**当成契约来写。
 *
 * 为什么单独抽出来：`it()` 回调有 150 行上限、控制流嵌套有 4 层上限
 * （AGENT.md §7），内联写会同时踩到两条（真实踩到：嵌套 5 层）。
 *
 * 只钉**本仓自己的** checkout 路径，不钉别的绝对路径：
 *   · `/var/lib/celestea-agent` 是产品默认值（configuration.md 必须写它）；
 *   · `/api/...`、`/compact` 是路由字面量；
 *   · `/src/celestea_harness`、`/src/dsh_plugins` 是**外部仓库的引用**（已删除的
 *     参照实现 / 兄弟项目）—— 那是引述，不是本机的路径事实。
 *   把后三类也钉上会逼着人删掉有用的交叉引用，是更糟的交换。
 *
 * 两处范围收窄（与 ③b 的锚点检查同一取舍）：归档是冻结的历史快照；围栏代码块里
 * 是样例载荷与当时的命令输出（记录，不是叙述）。
 */
function checkoutPathProblems(p: string, text: string): string[] {
  if (isArchived(p)) return [];
  const ownDir = '/src/' + basename(REPO);
  const problems: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(/\/src\/[A-Za-z0-9_.-]+/g)) {
      if (m[0] === ownDir) problems.push(relDocs(p) + ' 含本机 checkout 路径：' + m[0] + '（本仓用相对路径表达）');
    }
  }
  return problems;
}

describe('文档不变量 · 规模与机器事实', () => {
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
      // W893: an ABSOLUTE machine path is the same class of mistake as a hardcoded
      // identity — it resolves on the author's box and breaks on every other
      // checkout. GitHub CI caught exactly this in docs/archive (3 links).
      for (const m of text.matchAll(/\]\((\/[^)\s]+)\)/g)) {
        if (m[1]!.startsWith('/src/')) problems.push(relDocs(p) + ' 含本机绝对路径链接：' + m[1]);
      }
      // W895: AGENT.md §7 rule 6 says a committed doc carries NO machine facts
      // (identity / absolute paths / ports / credential locations) — but the check
      // only covered the identity, so raw `id` output and home paths slipped through
      // (one of each was found committed). These two patterns are unambiguous.
      for (const m of text.matchAll(/\b(?:uid|gid)=\d+\(/g)) {
        problems.push(relDocs(p) + ' 含本机运行身份输出：' + m[0]);
      }
      for (const m of text.matchAll(/\/home\/[a-z][a-z0-9_-]*\//g)) {
        problems.push(relDocs(p) + ' 含本机绝对 home 路径：' + m[0] + '（用 ~ 表达）');
      }
      // W1505: the earlier checks only caught ABSOLUTE PATHS IN MARKDOWN LINKS
      // (`](/src/...)`) and `/home/<user>/`. A bare `code-span` path therefore slipped
      // through — docs/README.md listed THIS CHECKOUT's directory as if it were part
      // of the contract. A committed doc must describe the repo RELATIVELY.
      //
      problems.push(...checkoutPathProblems(p, text));
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
