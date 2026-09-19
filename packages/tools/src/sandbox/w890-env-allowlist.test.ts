// @vitest-environment node
/**
 * W890 — 子进程环境白名单是**平台问题**。
 *
 * Windows 实测报告（Windows 11 / Node 26）：ENV_ALLOWLIST 只有 POSIX 一份，
 * 于是子进程只拿到 PATH 和寥寥几个变量 —— `cmd.exe` 没有 SystemRoot（它自己的 DLL）、
 * 没有 ComSpec、没有 PATHEXT（`foo` 永远不会解析成 `foo.exe`）、没有 TEMP，
 * 受害的正是 `run_shell`。
 *
 * `platform` 可注入，所以 Windows 的答案在 Linux 上就能断言（W885 的缝）。
 */
import { describe, expect, it } from 'vitest';
import { ENV_ALLOWLIST, ENV_ALLOWLIST_WIN32, envAllowlist, sanitizedEnv } from './config.js';
import type { SandboxConfig } from '@celestea/core';

/** 一个只带 extraEnv 的最小 config（sanitizedEnv 只读这个字段）。 */
const cfg = { extraEnv: [] } as unknown as SandboxConfig;

describe('W890 子进程环境白名单', () => {
  it('win32 带齐 cmd.exe 启动所需的名字', () => {
    const w = envAllowlist('win32');
    for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'SystemDrive', 'windir']) {
      expect(w, name + ' 必须能到达 Windows 子进程').toContain(name);
    }
  });

  it('posix 保持历史清单，不掺 Windows 专有名', () => {
    expect(envAllowlist('linux')).toEqual([...ENV_ALLOWLIST]);
    expect(envAllowlist('darwin')).toEqual([...ENV_ALLOWLIST]);
    expect(envAllowlist('linux')).not.toContain('SystemRoot');
    expect(ENV_ALLOWLIST_WIN32).not.toEqual(ENV_ALLOWLIST);
  });

  it('sanitizedEnv 按平台选清单，且仍是白名单（HOME 与任意变量都不漏）', () => {
    const env = { PATH: '/x', SystemRoot: 'C:\\Windows', HOME: '/home/me', SECRET: 'nope' };
    const posix = sanitizedEnv(cfg, env, 'linux');
    expect(posix['PATH']).toBe('/x');
    expect(posix['SystemRoot']).toBeUndefined();
    expect(posix['HOME']).toBeUndefined();
    expect(posix['SECRET']).toBeUndefined();

    const win = sanitizedEnv(cfg, env, 'win32');
    expect(win['SystemRoot']).toBe('C:\\Windows');
    expect(win['PATH']).toBe('/x');
    expect(win['SECRET']).toBeUndefined();
  });

  it('operator 的 extraEnv 在两个平台上都生效（显式覆盖优先）', () => {
    const c = { extraEnv: [['MY_VAR', 'v']] } as unknown as SandboxConfig;
    expect(sanitizedEnv(c, {}, 'linux')['MY_VAR']).toBe('v');
    expect(sanitizedEnv(c, {}, 'win32')['MY_VAR']).toBe('v');
  });
});
