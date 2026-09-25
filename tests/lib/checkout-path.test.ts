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

import { ownCheckoutPath, repoDirName, repoDirNameFrom } from './checkout-path.js';

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
