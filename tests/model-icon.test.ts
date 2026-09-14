/**
 * W750 · 前端内置模型图标（`model-icon.ts`）纯函数守护 —— 跨仓直测。
 * W778 · 图标本体换成真实厂商图标（@lobehub/icons-static-svg@1.95.0，MIT，
 *        由 frontend/tools/fetch-model-icons.mjs 内联生成），家族扩到 12 个。
 *
 * 先例：tests/scope-hash-vectors.test.ts 用 URL 形式的动态 import 直接加载前端
 * 纯函数（跨出本仓包边界，绕开本仓 no-restricted-imports 与 NodeNext 扩展名规则）。
 * 前端仓没有测试栈，而本仓 `pnpm check` 已经跑 vitest —— 所以把这条不变量放在这里：
 * 前缀识别（含别名与优先级）、大小写/分隔符容错、未知返回 null（不占位）、
 * 以及「图标自带零硬编码颜色、零外链」。
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

const MODULE_URL = new URL("../apps/web/src/utils/model-icon.ts", import.meta.url).href;
const icons = (await import(/* @vite-ignore */ MODULE_URL)) as ModelIconModule;

/** W778：内置图标覆盖的全部家族（与生成器的 slug 表一一对应）。 */
const FAMILIES = [
  "deepseek",
  "openai",
  "claude",
  "gemini",
  "glm",
  "qwen",
  "meta",
  "mistral",
  "grok",
  "kimi",
  "cohere",
  "ollama",
] as const;

/** 每个家族一个代表 id（用于「同族同图标 / 异族不同图标」断言）。 */
const SAMPLE: Record<(typeof FAMILIES)[number], string> = {
  deepseek: "deepseek-v3",
  openai: "gpt-4o",
  claude: "claude-3-opus",
  gemini: "gemini-2.5-pro",
  glm: "glm-4",
  qwen: "qwen-max",
  meta: "llama-3.1-70b",
  mistral: "mistral-large",
  grok: "grok-2",
  kimi: "moonshot-v1-128k",
  cohere: "cohere-command-r",
  ollama: "ollama/llama3",
};

describe("W750/W778 modelIconFor — 家族识别", () => {
  const cases: Array<[string, string]> = [
    // deepseek：小写、驼峰、下划线、带 provider 前缀
    ["deepseek-chat", "deepseek"],
    ["DeepSeek-V3", "deepseek"],
    ["deepseek_v3", "deepseek"],
    ["deepseek-r1", "deepseek"],
    ["celestea/deepseek-v4-flash-0731", "deepseek"],
    ["deepseek-v4-pro-0813", "deepseek"],
    // openai：gpt / chatgpt / o 系列 / openai 前缀
    ["gpt-4o", "openai"],
    ["GPT-4", "openai"],
    ["openai/gpt-5", "openai"],
    ["chatgpt-4o-latest", "openai"],
    ["o1", "openai"],
    ["O1-Preview", "openai"],
    ["o3-mini", "openai"],
    ["o3-deep-research", "openai"],
    ["o4-mini", "openai"],
    // claude
    ["claude-3-5-sonnet", "claude"],
    ["Claude-Opus-4", "claude"],
    ["anthropic/claude-haiku", "claude"],
    ["claude_opus_4_1", "claude"],
    // W778 新增家族
    ["gemini-2.5-pro", "gemini"],
    ["google/gemini-2.0-flash", "gemini"],
    ["glm-5.3-flash", "glm"],
    ["GLM-4-Plus", "glm"],
    ["chatglm3", "glm"],
    ["glmv-4", "glm"],
    ["zhipu/glm-4", "glm"],
    ["qwen-max", "qwen"],
    ["Qwen2.5-72B-Instruct", "qwen"],
    ["tongyi-qwen-plus", "qwen"],
    ["llama-3.1-70b", "meta"],
    ["meta-llama/Llama-3.3-70B", "meta"],
    ["mistral-large", "mistral"],
    ["mixtral-8x22b", "mistral"],
    ["grok-2", "grok"],
    ["x-ai/grok-3", "grok"],
    ["moonshot-v1-128k", "kimi"],
    ["kimi-k2", "kimi"],
    ["cohere-command-r-plus", "cohere"],
    ["ollama/qwen2.5:7b", "ollama"],
    ["ollama/llama3", "ollama"], // Ollama 早于 meta 判定：不能被 id 里的 llama 抢走
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
      "omnilingual-9b", // 以 o 开头但不是 o1..o4 系列
      "o5-preview", // 超出 o1..o4 的按需范围
      "step-2-16k",
      "phi-4",
      "yi-large",
      "internlm2-20b",
      "metadata-probe", // 含 meta 但不是家族 token（精确匹配，不做前缀猜）
    ];
    for (const id of unknown) {
      expect(icons.modelIconFor(id), id).toBeNull();
      expect(icons.modelIconKeyFor(id), id).toBeNull();
    }
  });
});

describe("W750/W778 modelIconFor — 图标本身", () => {
  it("是内置 SVG，24 网格，颜色一律 currentColor（深浅主题交给 CSS 变量）", () => {
    for (const id of Object.values(SAMPLE)) {
      const svg = icons.modelIconFor(id)?.svg ?? "";
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain("currentColor");
      expect(svg).toContain("</svg>");
      // 零硬编码颜色（含 hex / rgb() / hsl()）——上色只能在 CSS 层做。
      expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(svg).not.toMatch(/rgb\(|rgba\(|hsl\(/);
      expect(svg).not.toContain('fill="white"');
      expect(svg).not.toContain('stroke="black"');
      // 无外部引用（不外链、不引字体文件、不内联样式表）。
      expect(svg).not.toMatch(/<image|href=|url\(|<style/);
    }
  });

  it("W778：12 个家族的图标都非空且互不相同（可肉眼区分）", () => {
    const seen = new Map<string, string>(); // path 载荷 → 家族
    for (const key of FAMILIES) {
      const svg = icons.modelIconFor(SAMPLE[key])?.svg ?? "";
      const body = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
      expect(body.length, key).toBeGreaterThan(0);
      expect(body, key).toContain("<path");
      expect(seen.has(body), `家族 ${key} 的图标与 ${seen.get(body)} 重复`).toBe(false);
      seen.set(body, key);
    }
    expect(seen.size).toBe(FAMILIES.length);
  });

  it("同一家族返回同一份 SVG（稳定、可缓存）", () => {
    expect(icons.modelIconFor("deepseek-chat")?.svg).toBe(icons.modelIconFor("DeepSeek-V3")?.svg);
    expect(icons.modelIconFor("gemini-2.5-pro")?.svg).toBe(icons.modelIconFor("google/gemini-1.5")?.svg);
    expect(icons.modelIconFor("moonshot-v1-8k")?.svg).toBe(icons.modelIconFor("kimi-k2")?.svg);
  });
});
