// @vitest-environment jsdom
/**
 * W862 · 降级提示「可切换到」清单按 id 去重 —— 真实模块 + jsdom 夹具。
 *
 * 真人用户报的案件：Studio 的 IMAGE_UNSUPPORTED 提示出现
 *   「可切换到：glm-5.3-flash、deepseek-flash、deepseek-v4-pro-0813、deepseek-v4-flash、deepseek-flash」
 * 而同一条 deepseek-flash 在 GET /api/providers 里出现两次（Celestea 网关 / 基元各一条）。
 *
 * 本用例走**真实模块** apps/web/src/ui/attachments.ts（pathToFileURL 动态 import，不复刻逻辑），
 * 用与线上同形的 providers 响应驱动，断言：
 *   ① imageCapableModels() 每个 id 只出现一次，且保留首次出现顺序；
 *   ② downgradeNotice() 的「可切换到」行同样零重复，仍如实排除本次肇事模型；
 *   ③ 同 id 的后续 provider 仍覆盖能力位（modalities.set 语义不变，不引入能力位回退）；
 *   ④ 同名 provider 覆盖为纯文本时，该 id 不因去重而被误判为可看图。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

interface ModelRow {
  id: string;
  input_modalities?: string[];
}
interface ProviderRow {
  id: string;
  models: ModelRow[];
}
interface AttMod {
  loadAttachmentCapabilities(): Promise<void>;
  imageCapableModels(): string[];
  downgradeNotice(p: { message?: unknown; hint?: unknown; model?: unknown }): string;
  modelAllowsImages(m: string): boolean;
}

/** 线上同形：两个 provider 各有一条 deepseek-flash（用户实测 total 6 / dupe ×2）。 */
const PROVIDERS_SHAPE = [
  {
    id: "celestea-gw",
    models: [
      { id: "glm-5.3-flash", input_modalities: ["text", "image"] },
      { id: "deepseek-flash", input_modalities: ["text", "image"] },
      { id: "deepseek-v4-pro-0813" },
    ],
  },
  {
    id: "jiyuan",
    models: [
      { id: "deepseek-flash", input_modalities: ["text", "image"] },
      { id: "deepseek-v4-flash" },
      { id: "deepseek-v4-flash-0731", input_modalities: ["text"] },
    ],
  },
] as ProviderRow[];

/** 用户实际收到的那条降级帧（服务端定稿文案 + 肇事模型）。 */
const REAL_DOWNGRADE = {
  phase: "error",
  reason: "IMAGE_UNSUPPORTED",
  model: "deepseek-v4-flash-0731",
  message:
    '模型 "deepseek-v4-flash-0731" 拒绝了图像输入（上游 400），本轮已自动降级为「仅文本 + 图片占位」继续，图片内容未送达模型。',
  hint: '下一步：切换到支持图像输入的模型，或确认该模型 input_modalities 含 "image"。',
};

let providers: ProviderRow[] = [];

function stubNet(): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    const payload = u.startsWith("/api/health")
      ? { ok: true, capabilities: { multimodal: true } }
      : u.startsWith("/api/config")
        ? { ok: true, model: "glm-5.3-flash" }
        : { ok: true, providers };
    return { ok: true, status: 200, json: async () => payload };
  });
}

async function loadAtt(): Promise<AttMod> {
  const mod = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as unknown as AttMod;
  await mod.loadAttachmentCapabilities();
  return mod;
}

/** 第 2 次及以后出现的 id（空数组 = 零重复）。 */
const dupes = (ids: readonly string[]): string[] => ids.filter((id, i) => ids.indexOf(id) !== i);
const countOf = (s: string, needle: string): number => s.split(needle).length - 1;
const suggestLine = (text: string): string =>
  text.split("\n").find((l) => l.startsWith("可切换到：")) ?? "";

describe("W862 · 降级清单按 id 去重（真实 providers 形状）", () => {
  beforeEach(() => {
    (globalThis as unknown as { document: { body: { innerHTML: string } } }).document.body.innerHTML =
      '<div id="app"></div>';
    vi.resetModules();
    providers = JSON.parse(JSON.stringify(PROVIDERS_SHAPE)) as ProviderRow[];
    stubNet();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imageCapableModels()：同名 id 只保留首次出现，清单零重复", async () => {
    const att = await loadAtt();
    const list = att.imageCapableModels();
    expect(list.length).toBe(4);
    expect(dupes(list)).toEqual([]);
    expect(countOf(list.join("、"), "deepseek-flash")).toBe(1);
    expect(list).toEqual([
      "glm-5.3-flash",
      "deepseek-flash",
      "deepseek-v4-pro-0813",
      "deepseek-v4-flash",
    ]);
  });

  it("downgradeNotice()：可切换到行零重复、不含肇事模型，正文仍保留服务端原文", async () => {
    const att = await loadAtt();
    const text = att.downgradeNotice(REAL_DOWNGRADE);
    const suggest = suggestLine(text);
    expect(suggest).not.toBe("");
    const list = suggest.replace("可切换到：", "").split("、");
    expect(dupes(list)).toEqual([]);
    expect(countOf(suggest, "deepseek-flash")).toBe(1);
    expect(suggest).not.toContain("deepseek-v4-flash-0731");
    // 正文（服务端定稿 message）仍如实保留肇事模型名，只有建议行排除它。
    expect(text).toContain('模型 "deepseek-v4-flash-0731" 拒绝了图像输入');
  });

  it("肇事模型本身就在清单里时也被排除（既有 debris 过滤不许删）", async () => {
    const att = await loadAtt();
    const text = att.downgradeNotice({
      ...REAL_DOWNGRADE,
      model: "glm-5.3-flash",
      message: "模型拒绝了图像输入（上游 400）。",
    });
    const suggest = suggestLine(text);
    expect(suggest).toContain("deepseek-flash");
    expect(countOf(suggest, "glm-5.3-flash")).toBe(0);
  });

  it("同 id 后续 provider 的能力位仍生效：先 image 后 text ⇒ 视为纯文本（无回退）", async () => {
    providers = [
      { id: "a", models: [{ id: "dual", input_modalities: ["text", "image"] }] },
      { id: "b", models: [{ id: "dual", input_modalities: ["text"] }] },
    ];
    const att = await loadAtt();
    expect(att.modelAllowsImages("dual")).toBe(false);
    expect(att.imageCapableModels()).not.toContain("dual");
  });

  it("同 id 后续 provider 的能力位仍生效：先 text 后 image ⇒ 放行且只出现一次", async () => {
    providers = [
      { id: "a", models: [{ id: "dual", input_modalities: ["text"] }] },
      { id: "b", models: [{ id: "dual", input_modalities: ["text", "image"] }] },
    ];
    const att = await loadAtt();
    expect(att.modelAllowsImages("dual")).toBe(true);
    expect(att.imageCapableModels()).toEqual(["dual"]);
  });
});
