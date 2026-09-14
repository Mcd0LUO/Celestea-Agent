#!/usr/bin/env node
/**
 * W778 · 内置模型图标生成器（一次性抓取 → 内置资产，运行期零外链）。
 *
 * 数据源（钉死版本，MIT）：
 *   https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.0/icons/<slug>.svg
 *   —— 单色图标，viewBox="0 0 24 24"，path 用当前色（我们统一 currentColor）。
 *
 * 产出：src/utils/model-icons.generated.ts（Record<GeneratedIconKey, string>，
 *   只存 **svg 内部 path 标记**，不含外层 <svg> 包裹 —— 包裹由 utils/model-icon.ts
 *   统一加，保证 viewBox / 尺寸 / currentColor / aria 一致）。
 *
 * 规矩：
 *   · 可重复执行：同一版本 + 同一 slug 列表 → 逐字节相同的产物（抓取日期除外）；
 *   · **缺 slug 必须报错退出（退出码 1），不得静默降级**；
 *   · 产物只允许 <path>；出现写死颜色 / <style> / 外链（href、url()、<image>）即报错，
 *     不让「带颜色的图标」混进浅深两套主题；
 *   · 前端门禁跑在 node 里，本脚本只用 node 内置模块（globalThis.fetch）。
 *
 * 用法（frontend/ 目录下）：node tools/fetch-model-icons.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERSION = '1.95.0';
const BASE = `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@${VERSION}/icons`;
const LICENSE = 'MIT';

/**
 * 家族键 → 上游 slug。键 = 前端 ModelIconKey（与 model-icon.ts 的识别表一一对应）；
 * slug 已在 1.95.0 逐条实测存在（HTTP 200）。
 */
const FAMILIES = [
  ['deepseek', 'deepseek'],
  ['openai', 'openai'],
  ['claude', 'claude'],
  ['gemini', 'gemini'],
  ['glm', 'zhipu'], // GLM/智谱：chatglm / glmv 是同一家族的别名
  ['qwen', 'qwen'],
  ['meta', 'meta'], // Llama / Meta
  ['mistral', 'mistral'],
  ['grok', 'xai'], // Grok：xai / x-ai
  ['kimi', 'kimi'], // Kimi：moonshot / kimi
  ['cohere', 'cohere'],
  ['ollama', 'ollama'],
];

const OUT = path.join(ROOT, 'src/utils/model-icons.generated.ts');

/** 抓一个 slug 的原始 SVG；非 200 直接抛（缺 slug = 明确的错，不是降级）。 */
async function fetchSvg(slug) {
  const url = `${BASE}/${slug}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`缺 slug：HTTP ${res.status} ${url}`);
  const text = await res.text();
  if (!text.includes('<svg')) throw new Error(`响应不是 SVG：${url}`);
  return text;
}

/**
 * 抽「svg 内部 path 标记」：丢掉外层 <svg> 包裹、<title>/<desc>/注释；
 * 只允许 <path …>（含其属性），其余元素一律报错。
 */
function extractPaths(slug, svg) {
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<desc>[\s\S]*?<\/desc>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  if (/<style|style=|href=|url\(|<image|<text|<script/i.test(inner)) {
    throw new Error(`${slug}：图标含 <style>/style=/外链/文本，拒绝内联（怕写死颜色或引外部资源）`);
  }
  if (/(?:fill|stroke|stop-color)="(#[0-9a-fA-F]{3,8}|rgb[^"]*|hsl[^"]*|[a-z]+)"/.test(inner)) {
    throw new Error(`${slug}：图标含写死颜色，拒绝内联（上色只能在 CSS 层）`);
  }
  const tags = [...inner.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1].toLowerCase());
  const bad = [...new Set(tags)].filter((t) => t !== 'path');
  if (bad.length > 0) throw new Error(`${slug}：含非 path 元素 ${bad.join(', ')}`);
  const paths = [...inner.matchAll(/<path\b[^>]*\/?>/g)].map((m) => m[0]);
  if (paths.length === 0) throw new Error(`${slug}：没抽到任何 <path>`);
  return paths.map(normalizePath).join('');
}

/** 归一：属性顺序固定为 d → fill-rule → clip-rule（上游就这两三个），保证产物确定性。 */
function normalizePath(tag) {
  const d = /\bd="([^"]*)"/.exec(tag)?.[1];
  if (!d) throw new Error(`<path> 缺 d 属性：${tag}`);
  const fillRule = /\bfill-rule="([^"]*)"/.exec(tag)?.[1];
  const clipRule = /\bclip-rule="([^"]*)"/.exec(tag)?.[1];
  let out = `<path d="${d}"`;
  if (fillRule) out += ` fill-rule="${fillRule}"`;
  if (clipRule) out += ` clip-rule="${clipRule}"`;
  return out + ' />';
}

/** 抓取全部家族 → 生成 TS 源（键按 FAMILIES 顺序，逐字节确定）。 */
async function main() {
  const entries = [];
  for (const [key, slug] of FAMILIES) {
    const svg = await fetchSvg(slug);
    entries.push([key, slug, extractPaths(slug, svg)]);
  }
  const capturedAt = new Date().toISOString().slice(0, 10);
  const keys = entries.map(([k]) => `'${k}'`).join(' | ');
  const body = entries
    .map(([key, slug, paths]) => {
      const lines = paths.match(/.{1,110}/g) ?? [];
      return (
        `  // ${key} ← ${slug}.svg\n` + `  ${key}: \`${lines.join('\\\n')}\`,\n`
      );
    })
    .join('');
  const out =
    `// ============================================================================\n` +
    `// utils/model-icons.generated.ts — **自动生成，请勿手改**\n` +
    `//\n` +
    `//   W778 由 tools/fetch-model-icons.mjs 生成：node tools/fetch-model-icons.mjs\n` +
    `//   来源：${BASE}/<slug>.svg\n` +
    `//   版本：@lobehub/icons-static-svg@${VERSION}（许可 ${LICENSE}）\n` +
    `//   抓取日期：${capturedAt}\n` +
    `//\n` +
    `//   只存「svg 内部 path 标记」（已剥外层 <svg>/<title>）；包裹、尺寸、currentColor\n` +
    `//   与 aria 由 utils/model-icon.ts 统一加 —— 图标本体零硬编码颜色、零外链。\n` +
    `// ============================================================================\n\n` +
    `/** 已内置的家族键（= 前端 ModelIconKey 的取值集合）。 */\n` +
    `export type GeneratedIconKey = ${keys};\n\n` +
    `/** 家族键 → svg 内部 path 标记（viewBox 0 0 24 24，颜色继承 currentColor）。 */\n` +
    `export const MODEL_ICON_PATHS: Record<GeneratedIconKey, string> = {\n` +
    body +
    `};\n`;
  writeFileSync(OUT, out, 'utf8');
  console.log(
    `✓ 生成 ${path.relative(ROOT, OUT)}：${entries.length} 个家族（@lobehub/icons-static-svg@${VERSION}，${LICENSE}）`,
  );
  for (const [key, slug, paths] of entries) console.log(`    ${key.padEnd(9)} ← ${slug}.svg  ${paths.length} 字节`);
}

main().catch((err) => {
  console.error('✗ 生成失败：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
