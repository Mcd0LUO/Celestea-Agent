/**
 * W750 · 前端内置模型图标（`model-icon.ts`）纯函数守护 —— 跨仓直测。
 *
 * 先例：tests/scope-hash-vectors.test.ts 用 URL 形式的动态 import 直接加载前端
 * 纯函数（跨出本仓包边界，绕开本仓 no-restricted-imports 与 NodeNext 扩展名规则）。
 * 前端仓没有测试栈，而本仓 `pnpm check` 已经跑 vitest —— 所以把这条不变量放在这里：
 * 前缀识别、大小写/分隔符容错、未知返回 null（不占位）、以及「图标自带零硬编码颜色」。
 */
import { describe, expect, it } from "vitest";

interface ModelIcon {
  key: string;
  svg: string;
}
interface ModelIconModule {
  modelIconFor(modelId: string): ModelIcon | null;
  modelIconKeyFor(modelId: string): string | null;
}

const MODULE_URL = new URL("../../celestea_studio/frontend/src/utils/model-icon.ts", import.meta.url).href;
const icons = (await import(/* @vite-ignore */ MODULE_URL)) as ModelIconModule;

describe("W750 modelIconFor — 家族识别", () => {
  const cases: Array<[string, string]> = [
    // deepseek：小写、驼峰、下划线、带 provider 前缀
    ["deepseek-chat", "deepseek"],
    ["DeepSeek-V3", "deepseek"],
    ["deepseek_v3", "deepseek"],
    ["deepseek-r1", "deepseek"],
    ["celestea/deepseek-v4-flash-0731", "deepseek"],
    ["deepseek-v4-pro-0813", "deepseek"],
    // openai：gpt / chatgpt / o 系列
    ["gpt-4o", "openai"],
    ["GPT-4", "openai"],
    ["openai/gpt-5", "openai"],
    ["chatgpt-4o-latest", "openai"],
    ["o1", "openai"],
    ["O1-Preview", "openai"],
    ["o3-mini", "openai"],
    ["o3-deep-research", "openai"],
    ["o4-mini", "openai"],
    // glm
    ["glm-5.3-flash", "glm"],
    ["GLM-4-Plus", "glm"],
    ["chatglm3", "glm"],
    // claude
    ["claude-3-5-sonnet", "claude"],
    ["Claude-Opus-4", "claude"],
    ["anthropic/claude-haiku", "claude"],
    ["claude_opus_4_1", "claude"],
  ];

  for (const [id, key] of cases) {
    it(`${id} → ${key}`, () => {
      const icon = icons.modelIconFor(id);
      expect(icon?.key).toBe(key);
      expect(icons.modelIconKeyFor(id)).toBe(key);
    });
  }

  it("大小写与分隔符不影响结论（同一家族同一 key）", () => {
    const variants = ["deepseek-chat", "DeepSeek-Chat", "DEEPSEEK_CHAT", "deepseek chat", "deepseek.chat"];
    const keys = new Set(variants.map((v) => icons.modelIconKeyFor(v)));
    expect(keys).toEqual(new Set(["deepseek"]));
  });

  it("未命中的模型一律返回 null（不占位、不猜）", () => {
    const unknown = [
      "",
      "   ",
      "llama-3.1-70b",
      "qwen-max",
      "mistral-large",
      "moonshot-v1-128k",
      "grok-2",
      "omnilingual-9b", // 以 o 开头但不是 o1..o4 系列
      "o5-preview", // 超出 o1..o4 的按需范围
      "gemini-2.5-pro",
      "step-2-16k",
    ];
    for (const id of unknown) {
      expect(icons.modelIconFor(id), id).toBeNull();
      expect(icons.modelIconKeyFor(id), id).toBeNull();
    }
  });
});

describe("W750 modelIconFor — 图标本身", () => {
  const keys = ["deepseek", "openai", "glm", "claude"];

  it("是内置 SVG，且颜色一律 currentColor（深浅主题交给 CSS 变量）", () => {
    const samples = ["deepseek-v3", "gpt-4o", "glm-4", "claude-3-opus"];
    expect(samples).toHaveLength(keys.length);
    for (const id of samples) {
      const svg = icons.modelIconFor(id)?.svg ?? "";
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 16 16"');
      expect(svg).toContain("currentColor");
      // 零硬编码颜色（含 hex / rgb() / 具名色）——上色只能在 CSS 层做。
      expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(svg).not.toMatch(/rgb\(|rgba\(|hsl\(/);
      expect(svg).not.toContain('fill="white"');
      expect(svg).not.toContain('stroke="black"');
      // 无外部引用（不外链、不引字体文件）。
      expect(svg).not.toMatch(/<image|href=|url\(/);
    }
  });

  it("四个家族的外框几何各不相同（可肉眼区分）", () => {
    const frames = new Set(
      ["deepseek-v3", "gpt-4o", "glm-4", "claude-3-opus"].map((id) => {
        const svg = icons.modelIconFor(id)?.svg ?? "";
        return svg.match(/<(circle|rect|path)[^>]*/)?.[0] ?? "";
      }),
    );
    expect(frames.size).toBe(4);
    expect([...frames].every((f) => f !== "")).toBe(true);
  });

  it("同一家族返回同一份 SVG（稳定、可缓存）", () => {
    expect(icons.modelIconFor("deepseek-chat")?.svg).toBe(icons.modelIconFor("DeepSeek-V3")?.svg);
  });
});
