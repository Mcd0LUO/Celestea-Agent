/**
 * W886 · check-ui-copy 门禁改造的机械测试。
 *
 * 用 runGate(root) 直接在**临时 fixture 树**上跑（不碰真实 apps/web/src，遵守
 * 「另一人在做 i18n 域」的约束），覆盖：
 *   · 真实树：绿（过渡白名单生效）；
 *   · 护栏 A：组件里出现中文（不在待迁移白名单）⇒ 红；
 *   · 规则：字典值（zh 与 en）含实现细节词 ⇒ 红；
 *   · 护栏 B：zh/en key 集合不一致 ⇒ 红；
 *   · copy-gate-allow 逃生标记仍有效；
 *   · RULES 数组未被删减。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface GateResult {
  problems: string[];
  warnings: string[];
  stats: { scanned: number; localeFiles: number; componentFiles: number; pending: number; remaining: number; stale: number; zhKeys: number; enKeys: number };
}
interface GateModule {
  runGate(root?: string): GateResult;
  RULES: ReadonlyArray<readonly [string, RegExp]>;
  PENDING_MIGRATION: readonly string[];
  isLocaleFile(rel: string): boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "..", "apps", "web", "tools", "check-ui-copy.mjs");
const REAL_ROOT = join(HERE, "..", "apps", "web");
const gate = (await import(pathToFileURL(GATE).href)) as GateModule;

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个最小 fixture 树：root/{index.html, src/...}。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "w886-copy-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><body><div id=\"app\">Studio</div></body>");
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, "src", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

/** 一份 key 一致的最小 zh/en 字典对。 */
function locales(zhBody: string, enBody: string): Record<string, string> {
  return {
    "i18n/locales/zh/index.ts": "export const zh = { ...common } as const;\n",
    "i18n/locales/zh/common.ts": zhBody,
    "i18n/locales/en/index.ts": "export const en = { ...common };\n",
    "i18n/locales/en/common.ts": enBody,
  };
}

describe("W886 · check-ui-copy", () => {
  it("RULES 数组完整（27 条，现有规则一条未删）", () => {
    expect(gate.RULES).toHaveLength(27);
    const labels = gate.RULES.map((r) => r[0]);
    for (const must of ["/api/", "SSE", "409", "热调", "后端", "前端", "接口", "加载中", "进行中（进度）"]) {
      expect(labels, must).toContain(must);
    }
  });

  it("isLocaleFile 只放行 i18n/locales/**", () => {
    expect(gate.isLocaleFile("i18n/locales/zh/common.ts")).toBe(true);
    expect(gate.isLocaleFile("i18n/index.ts")).toBe(false);
    expect(gate.isLocaleFile("ui/send.ts")).toBe(false);
  });

  it("真实树绿：过渡白名单生效", () => {
    const r = gate.runGate(REAL_ROOT);
    expect(r.problems).toEqual([]);
    expect(r.stats.pending).toBeGreaterThan(0);
    // 白名单里仍含中文的文件数（= 还剩多少文件没抽）不应超过名单总数。
    expect(r.stats.remaining).toBeLessThanOrEqual(r.stats.pending);
    expect(r.stats.remaining).toBeGreaterThan(0);
  });

  it("护栏 A：组件里出现中文（不在白名单）⇒ 红", () => {
    const root = fixture({ "ui/brand-new.ts": "export const x = '中文新文案';\n" });
    const r = gate.runGate(root);
    expect(r.problems.some((p) => p.includes("护栏 A"))).toBe(true);
  });

  it("护栏 A：白名单内的路径含中文仍放行", () => {
    const root = fixture({ "ui/quote/model.ts": "export const x = '中文旧文案';\n" });
    const r = gate.runGate(root);
    expect(r.problems).toEqual([]);
  });

  it("规则搬到字典：en 值含 SSE ⇒ 红（英文界面也不许）", () => {
    const root = fixture(locales("export const common = { 'k': '好的' } as const;\n", "export const common = { 'k': 'SSE stream' } as const;\n"));
    const r = gate.runGate(root);
    expect(r.problems.some((p) => p.includes("[SSE]"))).toBe(true);
  });

  it("规则搬到字典：zh 值含 409 ⇒ 红", () => {
    const root = fixture(locales("export const common = { 'k': '错误 409' } as const;\n", "export const common = { 'k': 'error' } as const;\n"));
    const r = gate.runGate(root);
    expect(r.problems.some((p) => p.includes("[409]"))).toBe(true);
  });

  it("护栏 B：zh/en key 集合不一致 ⇒ 红", () => {
    const root = fixture(locales("export const common = { 'a': '甲' } as const;\n", "export const common = { 'b': 'B' } as const;\n"));
    const r = gate.runGate(root);
    expect(r.problems.some((p) => p.includes("i18n key"))).toBe(true);
    expect(r.problems.some((p) => p.includes("只有 zh 有"))).toBe(true);
    expect(r.problems.some((p) => p.includes("只有 en 有"))).toBe(true);
  });

  it("copy-gate-allow 逃生标记仍有效（护栏 A + 规则都豁免）", () => {
    const root = fixture({ "ui/brand-new.ts": "export const x = '中文 409'; // copy-gate-allow\n" });
    const r = gate.runGate(root);
    expect(r.problems).toEqual([]);
  });

  /**
   * W9109 · 护栏 D：**HTML 里的 CJK**。
   *
   * 为什么需要：护栏 A 只扫 apps/web/src/** 的字符串字面量，不含 .html —— 静态骨架
   * index.html 里写死的中文因此完全逃过「必须走 i18n」的检查（本次实测 50 处）。
   * 下列用例把口径逐条钉住：文本节点 / 三个属性都拦、注释放行、逃生标记放行。
   */
  describe("W9109 · 护栏 D（index.html 的 CJK）", () => {
    /** 用给定的 index.html 正文建 fixture（其余同 fixture()）。 */
    function htmlFixture(indexHtml: string): string {
      const root = fixture({ "ui/keep.ts": "export const x = 1;\n" });
      writeFileSync(join(root, "index.html"), indexHtml, "utf8");
      return root;
    }

    it("文本节点含中文 ⇒ 红", () => {
      const r = gate.runGate(htmlFixture('<!doctype html><body><div id="app">通用设置</div></body>'));
      expect(r.problems.some((p) => p.includes("护栏 D") && p.includes("通用设置"))).toBe(true);
    });

    it("title / placeholder / aria-label 含中文 ⇒ 都红", () => {
      const r = gate.runGate(
        htmlFixture(
          '<!doctype html><body><div id="app">' +
            '<button title="重新载入">a</button>' +
            '<input placeholder="输入消息" />' +
            '<nav aria-label="设置导航"></nav>' +
            "</div></body>",
        ),
      );
      const d = r.problems.filter((p) => p.includes("护栏 D"));
      expect(d.some((p) => p.includes("重新载入"))).toBe(true);
      expect(d.some((p) => p.includes("输入消息"))).toBe(true);
      expect(d.some((p) => p.includes("设置导航"))).toBe(true);
    });

    it("HTML 注释里的中文不算文案（脚本先剥注释）⇒ 绿", () => {
      const r = gate.runGate(htmlFixture('<!doctype html><body><!-- 顶栏：通用设置 --><div id="app">Studio</div></body>'));
      expect(r.problems.filter((p) => p.includes("护栏 D"))).toEqual([]);
    });

    it("同行 copy-gate-allow ⇒ 豁免（与护栏 A 同语义，不新增口径）", () => {
      const r = gate.runGate(htmlFixture('<!doctype html><body><div id="app">通用设置</div><!-- copy-gate-allow --></body>'));
      expect(r.problems).toEqual([]);
    });

    it("真实 index.html：护栏 D 无问题（迁移后必须为 0）", () => {
      const r = gate.runGate(REAL_ROOT);
      expect(r.problems.filter((p) => p.includes("护栏 D"))).toEqual([]);
    });
  });
});
