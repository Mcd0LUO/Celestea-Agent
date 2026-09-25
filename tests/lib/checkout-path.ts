/**
 * 本机 checkout 路径的**解析**（供 `tests/doc-conventions.test.ts` 的门禁⑤使用）。
 *
 * 为什么单独一个文件：门禁⑤ 要判断「文档里写的 `/src/<X>` 是不是**本仓自己**的
 * checkout 路径」。原来的实现是 `'/src/' + basename(REPO)`，而 `REPO = process.cwd()`
 * —— 在**链接工作树**（`git worktree add`）里 cwd 的 basename 是**工作树目录名**
 * （如 `w1516-cpu-sync`），不是仓库名。于是这条门禁在 worker 工作树里**静默空转**：
 * 它比对的是 `/src/w1516-cpu-sync`，而文档里写的是 `/src/celestea_studio-ts`，
 * 永远不相等 ⇒ 一条也不会报。这是**假绿**，比漏报更危险（W1518 交付时发现）。
 *
 * 修法：仓库名从 **`<repo>/.git` 文件本身**读，不问 cwd，也不起 git 子进程。
 *   · `.git` 是**目录** → 本目录就是 checkout ⇒ 仓库名 = `basename(repo)`；
 *   · `.git` 是**文件**（链接工作树 / 子模块）→ 内容形如
 *     `gitdir: /src/celestea_studio-ts/.git/worktrees/<name>` ⇒ 找到路径里的
 *     `.git` 组件，取它**父目录**的 basename = 仓库名。
 *
 * 为什么不起 `git rev-parse`：实测（W1519）在 worker 工作树里 git **根本跑不起来** ——
 * `.git/worktrees/<name>` 的属主可能是 root，而跑测试的用户是 celestea，git 直接
 * `fatal: detected dubious ownership`（exit 128）。纯读文件不受这个影响，也不依赖
 * git 在 PATH 里。取不到时回落到 `basename(repo)`（= 修之前的行为，不假装成功）。
 *
 * **平台是参数，不是常量**（AGENT.md §8）：路径切分走可注入的 [PathFlavor]。
 * 第一版按 `'/'` 手工切分，在 Windows 的 `C:\repo\.git\worktrees\x` 上一个 `/` 都没有 ⇒
 * 找不到 `.git` 组件 ⇒ `null` ⇒ 回落 cwd 的 basename ⇒ **假绿又回来了**；CI 的
 * windows-latest 当场抓到（5 条单测红）。现在默认取运行平台的语义，同时**可注入 win32**
 * —— 于是那条 Windows 分支能在 Linux 上被测到，不必等 CI。
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve, win32 } from "node:path";

/**
 * 路径语义（可注入的**平台缝**）。只用到两个原语，足以覆盖 win32 与 posix 的差异：
 * win32 同时认 `\` 与 `/` 且带盘符，posix 只认 `/`。
 */
export interface PathFlavor {
  /** 绝对化（相对于 `from`；posix 的 `/` 与 win32 的 `C:\` 各自为根）。 */
  resolve(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string): string;
}

/** 运行平台的语义（默认）；测试注入 [WIN32_FLAVOR] 以在 Linux 上验证 Windows 分支。 */
export const HOST_FLAVOR: PathFlavor = {
  resolve: (from, to) => resolve(from, to),
  dirname: (p) => dirname(p),
  basename: (p) => basename(p),
};

/**
 * win32 语义的注入版：全部委托给 `node:path` 的 `win32` 实现，**不是**手写复刻 ——
 * 手写复刻会变成「测试测的是复刻，不是真实现」。`win32.resolve` 以当前盘为基准补全，
 * 因此这里显式给它一个盘符起点，让结果确定。
 */
export const WIN32_FLAVOR: PathFlavor = {
  resolve: (from, to) => win32.resolve(from, to),
  dirname: (p) => win32.dirname(p),
  basename: (p) => win32.basename(p),
};

/**
 * 从 `.git` 的形态与内容解析仓库目录名（**纯函数**，不碰文件系统）。
 *
 * `gitIsDir` = `.git` 是目录（主工作树）；否则 `gitFileContent` 是它的文本内容。
 * 两者都给不出答案时返回 `null`，由调用方回落。
 */
export function repoDirNameFrom(
  gitIsDir: boolean,
  gitFileContent: string,
  repo: string,
  flavor: PathFlavor = HOST_FLAVOR,
): string | null {
  if (gitIsDir) return flavor.basename(flavor.resolve(repo, '.')) || null;
  const target = parseGitdirLine(gitFileContent);
  if (target === null) return null;
  const main = checkoutOfGitdir(flavor.resolve(repo, target), flavor);
  return main === null ? null : flavor.basename(main) || null;
}

/** `gitdir: <path>` → `<path>`；不是该形态返回 `null`。 */
function parseGitdirLine(content: string): string | null {
  for (const line of content.split('\n')) {
    const m = /^\s*gitdir:\s*(.+?)\s*$/.exec(line);
    if (m !== null) return m[1]!;
  }
  return null;
}

/**
 * `<main>/.git/worktrees/<name>` → `<main>`：逐级上溯，取**最后一个** `.git` 组件的父目录。
 * 用最后一个而不是第一个，是为了让 `/a/.git/modules/b/.git/worktrees/c` 这类嵌套也落在
 * 最近的那个仓库上。到根仍找不到 `.git` 组件时返回 `null`。
 *
 * 用 `dirname`/`basename` 而不是 `split(sep)`：前者按 flavor 的分隔符工作，
 * Windows 上 `\` 与 `/` 都认（见模块头「平台是参数」）。
 */
function checkoutOfGitdir(gitdir: string, flavor: PathFlavor): string | null {
  let current = gitdir;
  for (;;) {
    const parent = flavor.dirname(current);
    if (parent === current) return null; // 到根了，路径里没有 .git 组件
    if (flavor.basename(current) === '.git') return parent === '' ? null : parent;
    current = parent;
  }
}

/** 仓库目录名（= `<checkout>/docs` 的父目录名），与 cwd 无关。 */
export function repoDirName(repo = process.cwd(), flavor: PathFlavor = HOST_FLAVOR): string {
  const git = flavor.resolve(repo, '.git');
  try {
    const isDir = statSync(git).isDirectory();
    const content = isDir ? '' : readFileSync(git, 'utf8');
    const name = repoDirNameFrom(isDir, content, repo, flavor);
    if (name !== null) return name;
  } catch {
    // 没有 .git（导出目录 / 非仓库）：回落到 cwd 的 basename，与修之前一致。
  }
  return flavor.basename(flavor.resolve(repo, '.')) || repo;
}

/**
 * 本机 checkout 的 `/src/<repo>` 形态。
 *
 * 判据是**仓库目录名**而不是 cwd：文档里写死本机绝对路径这件事本身就是要拦的，
 * 而「哪条路径算本机的」必须由仓库身份决定，不能由「我在哪个目录里跑测试」决定。
 */
export function ownCheckoutPath(repo = process.cwd(), flavor: PathFlavor = HOST_FLAVOR): string {
  return "/src/" + repoDirName(repo, flavor);
}
