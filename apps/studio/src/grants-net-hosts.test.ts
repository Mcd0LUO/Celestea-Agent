/**
 * W757: `net_hosts` 的生效性 —— 单元判定 + `GET /api/sessions/{id}/grants` 契约。
 *
 * 单独成文件而不是塞进 `grants.test.ts`：后者已顶到单文件 400 行上限（ESLint
 * `max-lines`），而这一组断言只关心一件事 —— 「这份站点清单在本部署下算不算数」。
 * 判定必须复用引擎挂载工具时的同一条构造路径（`httpOptions` →
 * `HttpTargetPolicy.fromEnv` → `netHostsIneffective`），所以这里既断言辅助函数，
 * 也断言 HTTP 面把它如实报了出来。
 */

import { afterAll, describe, expect, it } from "vitest";
import { getJson, grant, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { EMPTY_GRANTS, netHostsEffective, type EffectiveGrants } from "./runtime/engine-grants.js";

const S1 = "sample-ws%2Fs1";
const harnesses: StudioHarness[] = [];

/** A throwaway app; `env` replaces the process env the grants layer sees. */
function make(env?: NodeJS.ProcessEnv): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" }, ...(env === undefined ? {} : { env }) });
  harnesses.push(h);
  return h;
}

afterAll(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("netHostsEffective — net_hosts 在本部署下算不算数（W757）", () => {
  /** The effective snapshot, reduced to the one field the verdict reads. */
  const view = (hosts: string[]): EffectiveGrants => ({ ...EMPTY_GRANTS, netHosts: hosts });

  it("空清单恒为 true；非空清单由进程级站点策略决定", () => {
    const bare: NodeJS.ProcessEnv = {};
    expect(netHostsEffective(bare, view([]))).toBe(true); // 没有可被丢弃的清单
    expect(netHostsEffective(bare, view(["localhost"]))).toBe(false);
    expect(netHostsEffective(bare, view(["10.1.2.3", "localhost"]))).toBe(false);
    // 两个环境变量任一被设置，策略即 active → 并集生效（deny 依旧恒优先）。
    expect(netHostsEffective({ CELESTEA_HTTP_ALLOW: "10.0.0.0/8" }, view(["localhost"]))).toBe(true);
    expect(netHostsEffective({ CELESTEA_HTTP_DENY: "10.0.0.0/8" }, view(["localhost"]))).toBe(true);
  });
});

describe("GET /api/sessions/{id}/grants — net_hosts_effective（W757 §6.1）", () => {
  const scope = { hosts: ["localhost", "127.0.0.1"] };

  it("未配置站点策略：字段为 false，warnings 追加一条可读提示", async () => {
    const h = make();
    const empty = await getJson(h.app, `/api/sessions/${S1}/grants`);
    expect(empty.body["net_hosts_effective"]).toBe(true);
    expect(empty.body["warnings"]).toBeUndefined();

    expect((await grant(h, S1, { cap: "net_hosts", scope, ttl_sec: 600 })).status).toBe(200);
    const off = await getJson(h.app, `/api/sessions/${S1}/grants`);
    // 清单确实进了生效快照 —— 它只是到不了策略，这正是该字段要说的事。
    expect(off.body["effective"]).toMatchObject({ net_hosts: ["localhost", "127.0.0.1"] });
    expect(off.body["net_hosts_effective"]).toBe(false);
    expect(off.body["warnings"]).toEqual([expect.stringContaining("net_hosts_ineffective")]);
    expect(String(off.body["warnings"])).toContain("CELESTEA_HTTP_ALLOW");
  });

  it("站点策略已启用（allow / deny 任一）：字段为 true 且无提示", async () => {
    for (const env of [{ CELESTEA_HTTP_ALLOW: "10.0.0.0/8" }, { CELESTEA_HTTP_DENY: "10.0.0.0/8" }]) {
      const h = make(env);
      expect((await grant(h, S1, { cap: "net_hosts", scope, ttl_sec: 600 })).status).toBe(200);
      const body = (await getJson(h.app, `/api/sessions/${S1}/grants`)).body;
      expect(body["net_hosts_effective"]).toBe(true);
      expect(body["warnings"]).toBeUndefined();
    }
  });
});
