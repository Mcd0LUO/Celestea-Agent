// i18n/locales/zh/api.ts — api.ts 域：请求失败时给用户看的固定短语。
export const api = {
  'api.error.connect': '无法连接服务，请稍后重试',
  'api.error.badRequest': '请求内容有误，请检查后重试',
  'api.error.forbidden': '没有权限执行该操作',
  'api.error.unsupported': '当前版本不支持该操作',
  'api.error.conflict': '当前状态暂时无法完成该操作，请稍后重试',
  'api.error.tooMany': '操作过于频繁，请稍后重试',
  'api.error.server': '服务暂时不可用，请稍后重试',
  'api.error.generic': '服务暂时无法完成请求，请稍后重试',
} as const;
