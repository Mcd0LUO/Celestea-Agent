/**
 * W782 — 提示词「自我描述」漂移守护。
 *
 * 背景（两个真实事故，同一个根因）：系统提示词里的部署事实曾经**手写**在模板
 * 字面量里 —— 一个事实同时存在于「真实部署」和「提示词散文」两处，二者独立演化：
 *   · W768：提示词说一个 workspace，`pwd` 是另一个（模板跟着改漏了）；
 *   · W781：仓改名 `celestea_studio` → `celestea_studio-ts`、前端并入
 *     `frontend/` → `apps/web`，模板是**手工**跟着改的 —— 下次再挪目录/换端口/
 *     改 unit 名，又会静默说错话。
 *
 * 本文件是那道机械门禁，四层断言：
 *   1) 反向：`builtin-sections.ts` 的**任何**模板字符串（含两种模式的 `tool_access`
 *      变体、含源码文本行）都不得出现绝对路径字面量；
 *   2) 正面：`assembleSystemPromptFor()` 渲染出的文本含**派生**值，且不含老字面量；
 *   3) 单一真源：换一份 config / 换一个 env → 渲染随之变（证明值来自运行时，
 *      而不是本文件又抄了一份期望值 —— 否则门禁自己就是第二处真源）；
 *   4) 环境段不得因为变量化而丢掉任何一个事实（逐条在位检查）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENV_SERVICE_NAME,
  PUBLIC_SITE,
  SERVICE_FALLBACK,
  deploymentFacts,
  studioRepoRoot,
  systemdUnitNameFromCgroup,
} from "../deployment.js";
import { assembleSystemPromptFor } from "../handlers/config-shape.js";
import { getJson, jsonRequest, makeHarness } from "../harness.test-util.js";
import { BUILTIN_SECTIONS, TOOL_ACCESS_VARIANTS, builtinRowsFor } from "./builtin-sections.js";
import { SESSION_MODES } from "./mode.js";
import { toPromptVars } from "./prompts-compose.js";
import { renderTemplate } from "./prompts-template.js";

const REPO_ROOT = studioRepoRoot();
const FRONTEND_DIR = join(REPO_ROOT, "apps", "web");
const BUILTIN_SECTIONS_FILE = fileURLToPath(new URL("./builtin-sections.ts", import.meta.url));

/**
 * 绝对路径字面量：`/src/…`、`/opt/…`、`/var/…`、`/home/…`、`/etc/…`。
 * 前置边界 `(?:^|[^\w])` 避免误伤；`apps/web/dist` 这类相对路径不命中。
 */
const ABS_PATH = /(?:^|[^\w])\/(?:src|opt|var|home|etc)\//;

/** 老仓库目录（W781 已删除）：提示词里再出现它一定是手写残留。 */
const RETIRED_DIR = /\/src\/celestea_studio(?![-\w])/;

/** 一份形状真实的注入值；`/derived/...` 只用来验证渲染管道。 */
const FIXTURE_VARS = toPromptVars({
  model: "m-1",
  provider: "Gateway",
  base_url: "http://x/v1",
  workspace: "ws",
  workspace_dir: "/tmp/ws",
  session: "ws/s1",
  tools: "read_file",
  context_window: 1_000_000,
  max_output_tokens: null,
  date: "2026-09-14",
  studio_repo: "/derived/repo",
  studio_frontend_dir: "/derived/repo/apps/web",
  studio_static_root: "/derived/repo/apps/web/dist",
  studio_service: "derived.service",
  studio_bind: "127.0.0.1:3777",
  studio_site: PUBLIC_SITE,
});

describe("W782 · builtin 模板不得硬编码部署位置", () => {
  it("反向断言：所有模板字符串（两种模式）零绝对路径字面量", () => {
    const hits: string[] = [];
    for (const section of BUILTIN_SECTIONS) {
      for (const [label, text] of [
        [`BUILTIN_SECTIONS[${section.id}].template`, section.template],
        ...Object.entries(TOOL_ACCESS_VARIANTS).map(([mode, t]) => [`TOOL_ACCESS_VARIANTS.${mode}`, t] as [string, string]),
      ] as Array<[string, string]>) {
        const m = ABS_PATH.exec(text);
        if (m !== null) hits.push(`${label}: …${text.slice(Math.max(0, m.index - 40), m.index + 60)}…`);
      }
    }
    expect(hits, `模板里出现绝对路径字面量（应改为 {{studio_*}} 变量）：\n${hits.join("\n")}`).toEqual([]);
  });

  it("反向断言：源码文本层面也零命中（含未来新增的行）", () => {
    const hits = readFileSync(BUILTIN_SECTIONS_FILE, "utf8")
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      // 注释行允许提到路径（它们解释「为什么不能写路径」），只查真正的代码行。
      .filter(([, line]) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .filter(([, line]) => ABS_PATH.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`);
    expect(hits, `builtin-sections.ts 代码行出现绝对路径字面量：\n${hits.join("\n")}`).toEqual([]);
  });

  it("每个内置模板（两种模式）渲染后仍不含绝对路径字面量", () => {
    for (const mode of SESSION_MODES) {
      for (const row of builtinRowsFor(mode)) {
        const rendered = renderTemplate(row.template, FIXTURE_VARS);
        expect(ABS_PATH.test(rendered), `${mode}/${row.id}`).toBe(false);
      }
    }
  });

  it("自证伪：把字面量塞回模板，上面那条断言必须红", () => {
    const polluted = renderTemplate("Code changes: the frontend is /src/celestea_studio-ts/apps/web and …", FIXTURE_VARS);
    expect(ABS_PATH.test(polluted), "门禁对硬编码字面量必须命中").toBe(true);
    // 同一句话变量化之后不再命中，且渲染出注入值。
    const clean = renderTemplate("Code changes: the frontend is {{studio_frontend_dir}} and …", FIXTURE_VARS);
    expect(ABS_PATH.test(clean)).toBe(false);
    expect(clean).toContain(FIXTURE_VARS.studio_frontend_dir as string);
  });
});

describe("W782 · 部署事实是运行时派生的（单一真源）", () => {
  const CFG = {
    name: "celestea-studio",
    bind: "127.0.0.1:3777",
    apiKeyEnv: "K",
    paths: { staticRoot: "/srv/custom-dist" },
  } as never;

  it("repo / frontend 从代码自身位置派生，staticRoot / bind 取自 config", () => {
    const facts = deploymentFacts(CFG, {});
    expect(facts.repo).toBe(REPO_ROOT);
    expect(facts.frontendDir).toBe(FRONTEND_DIR);
    expect(facts.staticRoot).toBe("/srv/custom-dist");
    expect(facts.bind).toBe("127.0.0.1:3777");
    expect(facts.publicSite).toBe(PUBLIC_SITE);
    // 本套件自身可能就跑在 systemd 下（cgroup 给得出 unit 名），所以这里只断言
    // 形状与回退常量二选一，具体优先级由下一条用例逐层钉死。
    expect(facts.service.endsWith(".service")).toBe(true);
  });

  it("unit 名优先级：env 覆盖 > cgroup > 常量回退", () => {
    expect(deploymentFacts(CFG, { [ENV_SERVICE_NAME]: "renamed.service" }).service).toBe("renamed.service");
    expect(systemdUnitNameFromCgroup("0::/system.slice/celestea-studio-ts.service\n")).toBe("celestea-studio-ts.service");
    expect(systemdUnitNameFromCgroup("0::/user.slice/user-1003.slice/session-1.scope\n")).toBeNull();
    expect(systemdUnitNameFromCgroup("")).toBeNull();
  });

  /**
   * 取出 environment 段。**不能**把整个 assembly 按 "\n\n" 切：环境段内部自己
   * 就有一个空行（两段话），按空行切只会拿到前半截。这里用「起始句 → 下一段
   * 起始句」定界。
   */
  function environmentSectionOf(assembled: string): string {
    const start = assembled.indexOf("The live Celestea Studio backend");
    expect(start, "environment 段必须在场").toBeGreaterThanOrEqual(0);
    const next = assembled.indexOf("Tool access: call tools directly", start);
    return assembled.slice(start, next < 0 ? undefined : next).trim();
  }

  /** 渲染一次真实会话的提示词（先激活，工作区变量才有值）。 */
  async function renderFor(h: ReturnType<typeof makeHarness>, id: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
    const activated = await h.app.request(`/api/sessions/${encodeURIComponent(id)}/activate`, jsonRequest("POST"));
    expect(activated.status).toBe(200);
    return assembleSystemPromptFor(h.studio.services, id, undefined, env);
  }

  it("正面断言：assembleSystemPromptFor 渲染出派生值且零老字面量", async () => {
    const h = makeHarness({ session: { name: "s1" } });
    try {
      const out = await renderFor(h, "sample-ws/s1");
      for (const expected of [REPO_ROOT, FRONTEND_DIR, h.staticRoot, PUBLIC_SITE, "127.0.0.1:3777", h.workspace]) {
        expect(out, `渲染文本缺少派生值 ${expected}`).toContain(expected);
      }
      // 注意：**不能**断言「不含 /src/celestea_studio-ts」——本仓今天的仓根恰好
      // 就是那个字符串，派生出来的值与当年的硬编码值在这里重合。真正有意义的是
      // 「值随运行时变」（见下面两条 config / env 覆盖用例）与「模板里没有字面量」
      // （见文件头的反向断言），以及 W781 之前那个**已退役**目录不许再出现。
      expect(out).not.toMatch(RETIRED_DIR);
    } finally {
      h.cleanup();
    }
  });

  it("单一真源：换一份 config，渲染文本随之改（不是又抄了一份期望值）", async () => {
    // W891: "/tmp/..." is POSIX-only; build the override under the host temp dir.
    const otherDist = join(tmpdir(), "w782-other-dist");
    const h = makeHarness({ session: { name: "s1" }, paths: { staticRoot: otherDist } });
    try {
      const out = await renderFor(h, "sample-ws/s1");
      expect(out).toContain(otherDist);
      expect(out).not.toContain(join(REPO_ROOT, "apps", "web", "dist"));
    } finally {
      h.cleanup();
    }
  });

  it("单一真源：env 覆盖 unit 名 → 渲染文本里就是那个名字", async () => {
    const h = makeHarness({ session: { name: "s1" } });
    try {
      const out = await renderFor(h, "sample-ws/s1", { [ENV_SERVICE_NAME]: "w782-probe.service" });
      expect(out).toContain("w782-probe.service");
      expect(out).not.toContain(SERVICE_FALLBACK);
    } finally {
      h.cleanup();
    }
  });

  it("环境段逐条在位：7 个事实一个都没丢，且工作目录仍是会话工作区", async () => {
    const h = makeHarness({ session: { name: "s1" } });
    try {
      const out = await renderFor(h, "sample-ws/s1");
      const text = environmentSectionOf(out);
      // ① 后端仓根 ② unit 名 ③ 监听地址 ④ 公开站点 ⑤ 工作目录（W768 语义）
      // ⑥ 前端目录 ⑦ 静态根。
      for (const expected of [REPO_ROOT, "127.0.0.1:3777", PUBLIC_SITE, h.workspace, FRONTEND_DIR, h.staticRoot]) {
        expect(text, `environment 段缺少 ${expected}`).toContain(expected);
      }
      expect(text).toMatch(/systemd unit [\w.@-]+\.service on 127\.0\.0\.1:3777/);
      // W768 红线：工作目录那句话给的必须是**会话工作区**，不是 studio_repo。
      const claim = /Your working directory IS this session's workspace directory, ([^ ]+)/.exec(text);
      expect(claim, "工作目录那句话必须在场").not.toBeNull();
      expect(claim![1]).toBe(h.workspace);
      expect(claim![1]).not.toBe(REPO_ROOT);
      expect(text).not.toMatch(RETIRED_DIR);
    } finally {
      h.cleanup();
    }
  });
});
