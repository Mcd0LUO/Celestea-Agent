// W750 · 内置模型图标（按模型 id 前缀自动识别）；W778 换成真实厂商图标。
//
// 纯函数、零外部依赖、零 DOM：既能被浏览器打包，也能被服务端 vitest 跨仓直测
// （先例：src/security/scope-hash.ts ← /src/celestea_studio-ts/tests/*.test.ts）。
//
// W778 变更（此前是「几何外框 + 家族首字母」的现画图标）：
//   · 图标本体 = `@lobehub/icons-static-svg@1.95.0`（MIT）的真实单色图标，
//     由 tools/fetch-model-icons.mjs 一次性抓取、内联进
//     `./model-icons.generated`（**运行期零外链、零网络**）；
//   · 包裹统一在这里做：viewBox="0 0 24 24"、12px、`fill="currentColor"`、
//     aria-hidden —— 上色仍只由 CSS 变量（--mi-<key>）决定；
//   · 家族覆盖扩到 12 个（deepseek / openai / claude / gemini / glm / qwen /
//     meta / mistral / grok / kimi / cohere / ollama）。
//
// 设计约束（未变）：
//   - 图标**只**做家族级识别（不认具体型号），未命中一律返回 null —— 不占位、
//     不留空框，列表行与状态栏都不会因缺图标而错位；
//   - SVG 一律 currentColor + 无内联颜色（产物里也没有写死颜色，见生成器校验），
//     深浅色主题各自可读。
// ============================================================================
import { MODEL_ICON_PATHS, type GeneratedIconKey } from './model-icons.generated';

/** 已识别家族（= 内置图标的键集合，由生成器决定）。 */
export type ModelIconKey = GeneratedIconKey;

export interface ModelIcon {
  /** 家族键：CSS 用 .sl-micon-<key> 上色（--mi-<key>）。 */
  key: ModelIconKey;
  /** 内置 SVG 源码（viewBox 0 0 24 24，颜色一律 currentColor）。 */
  svg: string;
}

const svgCache = new Map<ModelIconKey, string>();

function svgFor(key: ModelIconKey): string {
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
  const svg =
    '<svg class="sl-micon-svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" ' +
    'aria-hidden="true" focusable="false">' +
    MODEL_ICON_PATHS[key] +
    '</svg>';
  svgCache.set(key, svg);
  return svg;
}

/** token 判定表：按顺序取**第一个**命中的家族（越靠前越具体）。 */
const MATCHERS: readonly { key: ModelIconKey; hit: (t: string) => boolean }[] = [
  { key: 'deepseek', hit: (t) => t.startsWith('deepseek') },
  // Ollama 排在 meta 之前：`ollama/llama3` 这种 id 里同时含 llama，先认 Ollama。
  { key: 'ollama', hit: (t) => t.startsWith('ollama') },
  // GLM/智谱：glm-* / chatglm* / glmv* / zhipu。
  { key: 'glm', hit: (t) => t.startsWith('glm') || t.startsWith('chatglm') || t === 'zhipu' },
  { key: 'qwen', hit: (t) => t.startsWith('qwen') || t === 'tongyi' },
  { key: 'kimi', hit: (t) => t.startsWith('kimi') || t === 'moonshot' },
  { key: 'grok', hit: (t) => t.startsWith('grok') || t === 'xai' },
  {
    key: 'claude',
    hit: (t) =>
      t.startsWith('claude') || t === 'anthropic' || t === 'sonnet' || t === 'opus' || t === 'haiku',
  },
  { key: 'gemini', hit: (t) => t.startsWith('gemini') || t === 'google' },
  // gpt / chatgpt / o1·o2·o3·o4 系列（o4-mini、o3-deep-research、o1mini 都算）。
  {
    key: 'openai',
    hit: (t) => t.startsWith('gpt') || t === 'chatgpt' || t === 'openai' || /^o[1-4][a-z0-9]*$/.test(t),
  },
  { key: 'meta', hit: (t) => t.startsWith('llama') || t === 'meta' },
  {
    key: 'mistral',
    hit: (t) => t.startsWith('mistral') || t.startsWith('mixtral') || t.startsWith('codestral'),
  },
  { key: 'cohere', hit: (t) => t.startsWith('cohere') || t.startsWith('command-r') },
];

/**
 * 模型 id → 家族键；未命中返回 null。
 *
 * 大小写不敏感、分隔符不敏感（`- _ . / :` 与空白都当分隔符），并且**任一**片段
 * 命中即可 —— 因此 `deepseek-chat`、`DeepSeek-V3`、`deepseek_v3`、
 * `celestea/deepseek-r1` 同样命中。
 */
export function modelIconKeyFor(modelId: string): ModelIconKey | null {
  const raw = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (raw === '') return null;
  const tokens = raw.split(/[^a-z0-9]+/).filter((t) => t !== '');
  for (const m of MATCHERS) {
    if (tokens.some(m.hit)) return m.key;
  }
  return null;
}

/** 模型 id → 内置图标（`{ key, svg }`）；未命中返回 null（调用方不占位）。 */
export function modelIconFor(modelId: string): ModelIcon | null {
  const key = modelIconKeyFor(modelId);
  return key === null ? null : { key, svg: svgFor(key) };
}
