// @vitest-environment node
/**
 * `lib/checkout-path` 的单测：门禁⑤ 的**判据来源**必须是仓库身份，不是 cwd。
 *
 * 为什么值得单独测：这条门禁的失效形态是**静默空转**（在链接工作树里一条也不报），
 * 它不会红、只会假绿 —— 所以「它在正确的时候会报」必须由断言钉住，不能靠人记得。
 * 真实事故：W1518 交付时发现门禁⑤ 在 worker 工作树里全程空转（原实现取 cwd 的 basename）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ownCheckoutPath, repoDirName, repoDirNameFrom, WIN32_FLAVOR } from './checkout-path.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory shaped like a checkout. */
function fakeCheckout(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'w1519-'));
  made.push(root);
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

describe('repoDirNameFrom（纯函数：.git 形态 → 仓库名）', () => {
  it('主工作树：.git 是目录 ⇒ 仓库名 = 该目录的 basename', () => {
    expect(repoDirNameFrom(true, '', '/src/celestea_studio-ts')).toBe('celestea_studio-ts');
  });

  it('链接工作树：.git 是文件 ⇒ 从 gitdir 路径反推**主** checkout 的 basename', () => {
    const content = 'gitdir: /src/celestea_studio-ts/.git/worktrees/w1516-cpu-sync\n';
    // 关键：入参 repo 是工作树目录，答案必须是**主**仓库名 —— 这正是修掉的那个 bug。
    expect(repoDirNameFrom(false, content, '/opt/celestea/dev-workspaces/w1516-cpu-sync')).toBe('celestea_studio-ts');
  });

  it('相对 gitdir 也认（按 repo 解析）', () => {
    expect(repoDirNameFrom(false, 'gitdir: ../main/.git/worktrees/x\n', '/w/trees/x')).toBe('main');
  });

  it('嵌套仓库取**最近**的 .git 组件（modules 场景）', () => {
    expect(repoDirNameFrom(false, 'gitdir: /a/.git/modules/b/.git/worktrees/c\n', '/x')).toBe('b');
  });

  it('畸形内容 / 无 gitdir 行 ⇒ null（由调用方回落，不假装成功）', () => {
    expect(repoDirNameFrom(false, 'not a gitdir file\n', '/x')).toBeNull();
    expect(repoDirNameFrom(false, 'gitdir: /no/git/component\n', '/x')).toBeNull();
  });
});

/**
 * Windows 分隔符回归（CI windows-latest 当场抓到的真 bug）。
 *
 * 第一版按 `'/'` 手工切分 gitdir，在 `C:\repo\.git\worktrees\x` 上一个 `/` 都没有 ⇒
 * 切出来是整串 ⇒ 找不到 `.git` 组件 ⇒ `null` ⇒ 回落 cwd 的 basename ⇒ **假绿又回来了**。
 * 现在走 `node:path` 的 `dirname`/`basename`，它们按运行平台的分隔符工作。
 *
 * 这两条用例在 Linux 上跑时用的是 posix 语义，因此**不能**证明 win32 行为 ——
 * 但它们能钉住「不退回手工 `split('/')`」这件事；真正的 win32 证明由 CI 的
 * windows-latest 矩阵承担（本仓 CI 是 ubuntu + windows 双平台，见 AGENT.md §8）。
 */
describe('平台缝：win32 语义在 Linux 上就能测（AGENT.md §8）', () => {
  // 这一组是 CI windows-latest 那次红的**回归测试**：第一版按 '/' 手工切分，Windows 的
  // gitdir 上一个 '/' 都没有 ⇒ null ⇒ 回落 cwd ⇒ 假绿复发。现在注入 WIN32_FLAVOR，
  // 同一条 Windows 分支不必等 CI 就能在 Linux 上断言。
  const REPO = 'C:\\repo\\celestea_studio-ts';
  const GITDIR = 'C:\\repo\\celestea_studio-ts\\.git\\worktrees\\w1516-cpu-sync';

  it('反斜杠 gitdir ⇒ 反推出主仓库名（旧实现返回 null）', () => {
    expect(repoDirNameFrom(false, `gitdir: ${GITDIR}\n`, 'C:\\trees\\w1516', WIN32_FLAVOR)).toBe('celestea_studio-ts');
  });

  it('正斜杠的 Windows 路径也认（win32 两种分隔符都收）', () => {
    const fwd = 'C:/repo/celestea_studio-ts/.git/worktrees/w1516';
    expect(repoDirNameFrom(false, `gitdir: ${fwd}\n`, 'C:/trees/w1516', WIN32_FLAVOR)).toBe('celestea_studio-ts');
  });

  it('嵌套 modules 取**最近**的 .git 组件（win32）', () => {
    const nested = 'C:\\a\\.git\\modules\\b\\.git\\worktrees\\c';
    expect(repoDirNameFrom(false, `gitdir: ${nested}\n`, 'C:\\trees\\c', WIN32_FLAVOR)).toBe('b');
  });

  it('.git 是目录时取 repo 的 basename（win32）', () => {
    expect(repoDirNameFrom(true, '', REPO, WIN32_FLAVOR)).toBe('celestea_studio-ts');
  });

  it('win32 语义下路径不存在时如实回落（不编造仓库名）', () => {
    // `ownCheckoutPath` 会**读文件系统**，所以在 Linux 上给一个不存在的 Windows 路径，
    // 它只能走回落分支 —— 这是诚实的降级，不是失败。win32 的端到端由 CI 的
    // windows-latest 矩阵断言（本仓 CI 是 ubuntu + windows 双平台）。
    expect(ownCheckoutPath('C:\\trees\\w1516', WIN32_FLAVOR)).toBe('/src/w1516');
  });

  it('没有 .git 组件 ⇒ null（不编造仓库名）', () => {
    expect(repoDirNameFrom(false, 'gitdir: C:\\no\\git\\component\n', 'C:\\trees\\x', WIN32_FLAVOR)).toBeNull();
  });
});

describe('repoDirName（读真实文件系统）', () => {
  it('主工作树目录（.git 是目录）', () => {
    const repo = fakeCheckout('myrepo');
    mkdirSync(join(repo, '.git'));
    expect(repoDirName(repo)).toBe('myrepo');
  });

  it('链接工作树（.git 是文件）⇒ 与 cwd 无关，得到主仓库名', () => {
    const repo = fakeCheckout('main-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const tree = fakeCheckout('worker-tree');
    writeFileSync(join(tree, '.git'), `gitdir: ${repo}/.git/worktrees/worker-tree\n`);
    expect(repoDirName(tree)).toBe('main-repo');
  });

  it('没有 .git ⇒ 回落到 basename（与修之前一致）', () => {
    const plain = fakeCheckout('exported');
    expect(repoDirName(plain)).toBe('exported');
  });
});

describe('ownCheckoutPath', () => {
  it('产出 /src/<repo> 形态，且**与 cwd 无关**', () => {
    const repo = fakeCheckout('the-repo');
    mkdirSync(join(repo, '.git'));
    const tree = fakeCheckout('some-worktree');
    writeFileSync(join(tree, '.git'), `gitdir: ${repo}/.git/worktrees/some-worktree\n`);
    expect(ownCheckoutPath(repo)).toBe('/src/the-repo');
    // 同一仓库的两个工作树必须给出同一个答案 —— 这正是门禁⑤ 之前搞错的地方。
    expect(ownCheckoutPath(tree)).toBe(ownCheckoutPath(repo));
  });
});
