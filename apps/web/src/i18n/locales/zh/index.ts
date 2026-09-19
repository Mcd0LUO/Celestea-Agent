// i18n/locales/zh/index.ts — 中文是**基准语言**：它的 key 集合定义全局 Key 联合类型。
import { common } from './common';
import { api } from './api';
import { statusline } from './statusline';

export const zh = { ...common, ...api, ...statusline } as const;
export type Key = keyof typeof zh;
