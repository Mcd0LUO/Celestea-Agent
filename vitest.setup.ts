/**
 * W880 test isolation: point CELESTEA_HOME at a throwaway directory so no test
 * ever writes into the developer's (or CI user's) real data root. A FRESH
 * directory per test also keeps the canonical container (keyed by workspace
 * basename) from leaking sessions between tests that reuse a basename.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * i18n（P0/P1）：前端既有断言写的是**中文文案**（产品默认语言）。jsdom 的
 * navigator.language 是 en-US、Node 21+ 也带 navigator.language ⇒ i18n 会判成英文，
 * 与既有断言冲突。这里把 navigator.language 固定为 zh-CN，让 i18n 默认中文。
 * （i18n 自己的单测会显式 stub navigator / 清 localStorage，不受影响。）
 */
try {
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN", languages: ["zh-CN", "zh"] },
    configurable: true,
    writable: true,
  });
} catch {
  /* 环境不允许覆盖 navigator：i18n 回落默认中文 */
}

let home: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "celestea-home-test-"));
  process.env.CELESTEA_HOME = home;
});

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

