// ============================================================================
// plugins/index.ts — 客户端插件模块的对外入口（W859 · W9108）。
//   用法：
//     startClientPlugins();            // 装配（ui/hint 的 initHints 调用一次）
//     clientPlugins();                 // 登记表（设置页「插件」一格渲染）
//     setClientPlugin(id, on);         // 真注册/真注销（幂等；失败回滚并有回执）
//     setClientPluginConfig(id,k,v);   // W9108：写一个配置项（同一套 fail-closed）
//     whenClientPluginsReady();        // W895-C1：服务端启用表 + 配置已取回并对齐
//   提供者所在模块（ui/rail.ts）经 ./register 的 registerHintPlugin 交回实例，
//   注销器由 ./register 保存 —— 这就是「关掉后真的不再参与解析」的实现方式。
// ============================================================================
export {
  clientPlugins,
  clientPluginIds,
  clientPluginById,
  clientPluginConfig,
  CLIENT_PLUGIN_CATEGORIES,
  categoryLabelKey,
  type ClientPluginCategory,
  type ClientPluginDescriptor,
} from './descriptor';
export {
  isClientPluginOn,
  clientPluginConfigValues,
  setClientPlugin,
  setClientPluginConfig,
  setClientPlugins,
  startClientPlugins,
  whenClientPluginsReady,
  type ToggleResult,
} from './apply';
export {
  CONFIG_OFF,
  CONFIG_ON,
  configDefaults,
  defaultOf,
  effectiveConfig,
  hasConfigItems,
  normalizeItem,
  parseConfigValues,
  readBool,
  readNumber,
  readText,
  type PluginConfigItem,
  type PluginConfigMap,
  type PluginConfigOption,
  type PluginConfigSpec,
  type PluginConfigValue,
  type PluginConfigValues,
} from './config';
export {
  CLIENT_PLUGINS_CHANGED,
  PLUGINS_STORAGE_KEY,
  parseDisabled,
  parseConfigMap,
  savedConfigOf,
  // W895-C1: 诊断/测试用（服务端启用表的加载状态）。
  displayPluginsLoaded,
  displayPluginsServerAvailable,
  disabledPlugins,
} from './store';
