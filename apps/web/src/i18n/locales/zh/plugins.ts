// i18n/locales/zh/plugins.ts — W9108：插件页「可调配置」与两个内置增强遍的新增文案。
// 单开一个域文件（而不是追加进 settings.ts / chat.ts）是为了避开并发写冲突：
// settings.ts 归提供商任务、chat.ts 归聊天任务，插件文案归这里。
export const plugins = {
  // 内置增强遍（W9108 起可在插件页开关）。
  'plugins.desc.hljs.label': '代码高亮',
  'plugins.desc.hljs.hint': '按语言给代码块着色；关闭后代码块保持原样。',
  'plugins.desc.math.label': '数学公式',
  'plugins.desc.math.hint': '把 $…$ 与 $$…$$ 渲染成公式；关闭后保持原始写法。',
  // 行内配置面板（形状同「模型提供商」的行内面板）。
  'settings.plugins.expand': '展开「{label}」的配置',
  'settings.plugins.noConfig': '这个插件没有可调项',
  'plugins.config.saved': '已保存「{label}」的配置',
  'plugins.config.saveFailed': '「{label}」的配置保存失败，已恢复原来的值。',
  // 代码块增强的可调项。
  'plugins.config.codeExtras.foldLines.label': '超长折叠行数',
  'plugins.config.codeExtras.foldLines.hint': '代码块超过这个行数时默认折叠；随时可以展开。',
} as const;
