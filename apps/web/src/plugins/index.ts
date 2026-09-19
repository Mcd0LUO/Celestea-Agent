// ============================================================================
// plugins/index.ts — 客户端插件模块的对外入口（W859）。
//   用法：
//     startClientPlugins();            // 装配（ui/hint 的 initHints 调用一次）
//     clientPlugins();                 // 登记表（设置页「插件」一格渲染）
//     setClientPlugin(id, on);         // 真注册/真注销（幂等；失败回滚并有回执）
//   提供者所在模块（ui/rail.ts）经 ./register 的 registerHintPlugin 交回实例，
//   注销器由 ./register 保存 —— 这就是「关掉后真的不再参与解析」的实现方式。
// ============================================================================
export {
  clientPlugins,
  clientPluginIds,
  clientPluginById,
  type ClientPluginDescriptor,
} from './descriptor';
export { isClientPluginOn, setClientPlugin, startClientPlugins, type ToggleResult } from './apply';
export { CLIENT_PLUGINS_CHANGED, PLUGINS_STORAGE_KEY, parseDisabled } from './store';
