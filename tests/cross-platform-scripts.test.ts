// @vitest-environment node
/**
 * W891 — 跨平台脚本门禁：Windows 上「跑不起来」的写法不许进 package.json。
 *
 * 起因：给本仓加 CI（ubuntu + windows）时发现 `pnpm check` 在 Windows 上**必然失败**，
 * 原因不是代码而是脚本写法：
 *   `CELESTEA_BUNDLE_STRICT=1 pnpm …`
 * 这是 POSIX shell 的「命令前置赋值」。pnpm 在 Windows 用 cmd.exe 跑脚本（shell-emulator
 * 默认关闭），cmd.exe 不认识它，直接报「不是内部或外部命令」。
 *
 * 这类问题只有干净机器/别的 OS 才现形，所以必须机械判定，不能靠人记得。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** 仓库里所有会跑脚本的 manifest。 */
function manifests(): string[] {
  const out = ['package.json', 'apps/studio/package.json', 'apps/web/package.json', 'apps/cli/package.json'];
  for (const name of readdirSync(join(ROOT, 'packages'))) {
    const p = 'packages/' + name + '/package.json';
    if (existsSync(join(ROOT, p))) out.push(p);
  }
  return out;
}

/** `KEY=value cmd`（命令前置赋值）——cmd.exe 不支持。 */
const INLINE_ENV = /(?:^|&&\s*)[A-Z_][A-Z0-9_]*=/;

describe('W891 跨平台脚本', () => {
  it('package.json 里没有 cmd.exe 不支持的「命令前置赋值」', () => {
    const offenders: string[] = [];
    for (const manifest of manifests()) {
      const scripts = (JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const [name, body] of Object.entries(scripts)) {
        // `cross-env` 一类包装器自身会用 KEY=value 作**参数**，故只查命令位置的形态。
        if (INLINE_ENV.test(body)) offenders.push(manifest + ' :: ' + name + ' => ' + body);
      }
    }
    expect(
      offenders,
      '用 scripts/run-with-env.mjs KEY=value -- <cmd> 代替（POSIX 前置赋值在 Windows 上必失败）',
    ).toEqual([]);
  });

  it('scripts/run-with-env.mjs 存在且真的把变量传下去', () => {
    const runner = join(ROOT, 'scripts/run-with-env.mjs');
    expect(existsSync(runner), 'scripts/run-with-env.mjs 必须存在').toBe(true);
    const text = readFileSync(runner, 'utf8');
    expect(text, '必须真的写入子进程 env').toContain('process.env');
  });

  it('CI 同时测 Linux 与 Windows，并且跑的是全量 check', () => {
    const ci = join(ROOT, '.github/workflows/ci.yml');
    expect(existsSync(ci), '.github/workflows/ci.yml 必须存在（门禁不能只在人记得跑时存在）').toBe(true);
    const text = readFileSync(ci, 'utf8');
    expect(text, '必须覆盖 windows').toContain('windows-latest');
    expect(text, '必须覆盖 ubuntu').toContain('ubuntu-latest');
    expect(text, '必须跑全量 check').toContain('pnpm check');
    // 版本号由 git describe --tags 派生：浅检出会让版本门禁失去意义。
    expect(text, 'checkout 必须取全历史与 tag').toContain('fetch-depth: 0');
  });

  it('CI 在 tag 推送时也跑 —— 发布产物的身份必须自带 CI 结论', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    // W1519 的真实事故：v2.7.5 打在 825e88a 上，而该提交的 CI 在 windows-latest 上是红的
    // （测试文件里的 gitdir 解析在 win32 失效）。发布产物 @celestea/studio 的
    // webdist/build-meta.json 记着 sha=825e88a —— 用户可见地指向一个 CI 红的提交。
    // 当时 ci.yml 只监听 push.branches=[main]，**不含 tags**，所以「这个 tag 绿不绿」
    // 在 tag 上查不到，只能回溯是哪次 main push 恰好带了同一个 sha。
    // 这条断言钉住「tag 推送必须触发 CI」，删掉触发就红。
    const push = /push:\s*\n\s*branches:\s*\[main\][\s\S]*?tags:\s*\[([^\]]+)\]/.exec(ci);
    expect(push, 'ci.yml 的 push 触发必须同时覆盖 branches:[main] 与 tags:[v*]').not.toBeNull();
    const tags = (push?.[1] ?? '').split(',').map((t) => t.trim().replace(/['"]/g, ''));
    expect(tags, 'tag 触发必须覆盖 v* 版本 tag').toContain('v*');
  });

  it('CI 测量 Node 支持带的两端，不跟随 .nvmrc 的单值', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    // .nvmrc 只有一个数：拿它当 CI 输入 = 「声称支持整条带，只测过一个点」。
    expect(ci, 'CI 不得把 .nvmrc 的单值当成支持带的测量').not.toContain('node-version-file');
    const matrix = /matrix:[\s\S]*?node:\s*\[([^\]]+)\]/.exec(ci);
    expect(matrix, 'CI 必须有 node 矩阵').not.toBeNull();
    const versions = (matrix?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/['"]/g, ''))
      .filter((part) => part !== '');
    expect(versions.length, 'CI 至少测两个 Node 版本').toBeGreaterThanOrEqual(2);
    // 矩阵必须锚在 engines.node 的下界上（根 package.json 是唯一真源）。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } };
    const minMajor = /^>=\s*(\d+)/.exec(pkg.engines?.node ?? '')?.[1] ?? '';
    expect(minMajor, 'engines.node 必须声明下界').not.toBe('');
    expect(versions, 'CI 矩阵必须覆盖 engines.node 的下界').toContain(minMajor);
  });
});
