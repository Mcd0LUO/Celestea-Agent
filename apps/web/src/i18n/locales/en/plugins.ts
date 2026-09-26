// i18n/locales/en/plugins.ts — W9108 English strings for the plugin config panel.
import type { Key } from '../zh';

// `satisfies Partial<...>` 而不是 `Record<Key,string>`：**本域文件只放本域的键**，
// 漏译由 locales/en/index.ts 的 `Record<Key, string>` 在编译期统一兜住
// （与既有 common.ts / api.ts 等所有域文件同一写法）。
export const plugins = {
  // Built-in enhancers (toggleable from the plugins page since W9108).
  'plugins.desc.hljs.label': 'Code highlighting',
  'plugins.desc.hljs.hint': 'Colour code blocks by language; when off, code blocks stay as they are.',
  'plugins.desc.math.label': 'Math formulas',
  'plugins.desc.math.hint': 'Render $…$ and $$…$$ as formulas; when off, the raw text stays as it is.',
  // The inline config panel (same shape as the model provider rows).
  'settings.plugins.expand': 'Show settings for "{label}"',
  'settings.plugins.noConfig': 'This plugin has no adjustable settings',
  'plugins.config.saved': 'Saved the settings for "{label}"',
  'plugins.config.saveFailed': 'Could not save the settings for "{label}"; the previous values were restored.',
  // Adjustable settings of the code block extras.
  'plugins.config.codeExtras.foldLines.label': 'Fold above lines',
  'plugins.config.codeExtras.foldLines.hint': 'Code blocks longer than this start folded; you can always expand them.',
} satisfies Partial<Record<Key, string>>;
