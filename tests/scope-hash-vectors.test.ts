/**
 * W745 · 前端/服务端 scope_hash 漂移守护（服务端侧）。
 *
 * 契约（设计 §6.4 / W516）：前端 `security/scope-hash.ts` 的 canonicalScopeJson +
 * SHA-256 与服务端 `apps/studio/src/store/grants.ts` 的 canonicalScopeJson /
 * canonicalScopeHash 必须**逐字一致**。二者不同 ⇒ 一次性确认令牌绑定的是前端哈希、
 * 提交时服务端按自己的公式重算 ⇒ 每次授予都被判 403（历史事故 commit 692f19c；
 * 前端把形状抽成纯函数并加了真源 `contracts/scope-hash-vectors.json`）。
 *
 * 本文件做两件事，任一失败即门禁失败：
 *   1) 服务端管线（validateScope → canonicalScopeHash）必须复现冻结向量的
 *      canonical_json 与 sha256 —— 服务端自己改了形状/算法就红。
 *   2) **直接导入前端纯函数**逐字对拍同一组向量（跨仓 direct check）—— 前端漂移
 *      在服务端侧也能被看到，而不仅是前端 `pnpm check` 里那条。
 *
 * 冻结向量是唯一真源，两端都不得各留一份副本；新增/修改向量必须同时让两侧门禁重新变绿。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalScopeHash, canonicalScopeJson, validateScope } from "../apps/studio/src/store/grants.js";
/**
 * 前端纯函数（跨仓）：零 import / 零 DOM，可直接被 node/vitest 加载（无需构建产物）。
 * 用 URL 形式的动态 import 而不是静态 import —— 它跨出了本仓的包边界，
 * 静态深层相对导入会被本仓的 `no-restricted-imports` 与 NodeNext 的扩展名规则拦住，
 * 而这里要的正是「**同一份前端源码**在服务端侧被逐字对拍」，不是一条普通依赖。
 */
interface FrontendScopeHash {
  canonicalScopeJson(cap: string, scope: Record<string, string[]>): string;
  scopeHashOf(cap: string, scope: Record<string, string[]>): Promise<string>;
  sha256Hex(bytes: Uint8Array): string;
}
const FRONTEND_MODULE_URL = new URL("../../celestea_studio/frontend/src/security/scope-hash.ts", import.meta.url).href;
const frontend = (await import(/* @vite-ignore */ FRONTEND_MODULE_URL)) as FrontendScopeHash;

interface Vector {
  name: string;
  why: string;
  cap: string;
  scope: Record<string, string[]>;
  canonical_json: string;
  sha256: string;
}

interface VectorDoc {
  kind: string;
  source_of_truth: string;
  vectors: Vector[];
}

const VECTORS_PATH = fileURLToPath(new URL("../contracts/scope-hash-vectors.json", import.meta.url));
const doc = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorDoc;
/** 服务端 `knownSecretsOf` 用空集：向量的值都不是凭据形状（见文件 shared_domain）。 */
const NO_KNOWN_SECRETS: readonly string[] = [];

describe("contracts/scope-hash-vectors.json — scope_hash 冻结向量", () => {
  it("向量文件是漂移守护的真源（不是随手写的期望值）", () => {
    expect(doc.kind).toBe("scope-hash-frozen-vectors");
    expect(doc.source_of_truth).toContain("canonicalScopeHash");
    expect(doc.vectors.length).toBeGreaterThanOrEqual(15);
    const names = doc.vectors.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of doc.vectors) {
      expect(v.name).toBeTruthy();
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
      // 冻结文件自洽：json 与 sha256 必须是一对（挡住「只改了一处」的坏向量）
      expect(createHash("sha256").update(v.canonical_json, "utf8").digest("hex")).toBe(v.sha256);
    }
  });

  for (const v of doc.vectors) {
    it(`服务端管线复现冻结向量：${v.name}`, () => {
      const validated = validateScope(v.cap as never, v.scope, NO_KNOWN_SECRETS);
      expect(validated.ok, `validateScope 拒绝了向量（向量超出共享定义域）：${v.name}`).toBe(true);
      if (!validated.ok) return;
      expect(canonicalScopeJson(v.cap, validated.scope)).toBe(v.canonical_json);
      expect(canonicalScopeHash(v.cap, validated.scope)).toBe(v.sha256);
    });

    it(`前端纯函数与服务端逐字一致：${v.name}`, async () => {
      const validated = validateScope(v.cap as never, v.scope, NO_KNOWN_SECRETS);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      // 前端拿到的是用户提交的形状；服务端拿到的是校验后的形状 —— 两者必须同一哈希。
      expect(frontend.canonicalScopeJson(v.cap, v.scope)).toBe(canonicalScopeJson(v.cap, validated.scope));
      expect(await frontend.scopeHashOf(v.cap, v.scope)).toBe(canonicalScopeHash(v.cap, validated.scope));
      // 非安全上下文的回落实现（自带 SHA-256）也必须给出同一摘要。
      expect(frontend.sha256Hex(new TextEncoder().encode(v.canonical_json))).toBe(v.sha256);
    });
  }

  it("布尔类 cap 与无关 scope 键：两侧的**端到端管线**都收敛成 {cap, scope:{}}", async () => {
    // 注意口径：服务端的白名单/收敛发生在 validateScope，而 canonicalScopeJson 只是
    // 序列化器（直接喂给它 {roots:[…]} 会原样保留该键）。前端把两步折进了同一个纯函数。
    // 线上契约比的是**端到端管线**，所以这里必须走 validateScope。
    for (const cap of ["network", "unsandboxed"]) {
      const validated = validateScope(cap as never, { roots: ["/ignored"] }, NO_KNOWN_SECRETS);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      expect(canonicalScopeJson(cap, validated.scope)).toBe(`{"cap":"${cap}","scope":{}}`);
      expect(frontend.canonicalScopeJson(cap, { roots: ["/ignored"] })).toBe(`{"cap":"${cap}","scope":{}}`);
      expect(canonicalScopeHash(cap, validated.scope)).toBe(await frontend.scopeHashOf(cap, { roots: ["/ignored"] }));
    }
  });
});
