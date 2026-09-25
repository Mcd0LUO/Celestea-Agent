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
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * 从 `.git` 的形态与内容解析仓库目录名（**纯函数**，不碰文件系统）。
 *
 * `gitIsDir` = `.git` 是目录（主工作树）；否则 `gitFileContent` 是它的文本内容。
 * 两者都给不出答案时返回 `null`，由调用方回落。
 */
export function repoDirNameFrom(gitIsDir: boolean, gitFileContent: string, repo: string): string | null {
  if (gitIsDir) return basename(resolve(repo)) || null;
  const target = parseGitdirLine(gitFileContent);
  if (target === null) return null;
  const main = checkoutOfGitdir(resolve(repo, target));
  return main === null ? null : basename(main) || null;
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
 * `/main/.git/worktrees/<name>` → `/main`：取路径里**最后一个** `.git` 组件的父目录。
 * 用最后一个而不是第一个，是为了让 `/a/.git/modules/b/.git/worktrees/c` 这类嵌套也落在
 * 最近的那个仓库上。找不到 `.git` 组件时返回 `null`。
 */
function checkoutOfGitdir(gitdir: string): string | null {
  const parts = gitdir.split('/');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] === '.git') {
      const parent = parts.slice(0, i).join('/');
      return parent === '' ? null : parent;
    }
  }
  return null;
}

/** 仓库目录名（= `<checkout>/docs` 的父目录名），与 cwd 无关。 */
export function repoDirName(repo = process.cwd()): string {
  const git = resolve(repo, '.git');
  try {
    const isDir = statSync(git).isDirectory();
    const content = isDir ? '' : readFileSync(git, 'utf8');
    const name = repoDirNameFrom(isDir, content, repo);
    if (name !== null) return name;
  } catch {
    // 没有 .git（导出目录 / 非仓库）：回落到 cwd 的 basename，与修之前一致。
  }
  return basename(resolve(repo));
}

/**
 * 本机 checkout 的 `/src/<repo>` 形态。
 *
 * 判据是**仓库目录名**而不是 cwd：文档里写死本机绝对路径这件事本身就是要拦的，
 * 而「哪条路径算本机的」必须由仓库身份决定，不能由「我在哪个目录里跑测试」决定。
 */
export function ownCheckoutPath(repo = process.cwd()): string {
  return "/src/" + repoDirName(repo);
}
