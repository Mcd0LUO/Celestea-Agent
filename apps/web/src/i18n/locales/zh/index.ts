// i18n/locales/zh/index.ts — 中文是**基准语言**：它的 key 集合定义全局 Key 联合类型。
import { common } from './common';
import { api } from './api';
import { statusline } from './statusline';
import { settings } from './settings';
import { chat } from './chat';
import { shell } from './shell';
import { grants } from './grants';
import { usage } from './usage'; // W9103：设置页「使用统计」

export const zh = { ...common, ...api, ...statusline, ...settings, ...chat, ...shell, ...grants, ...usage } as const;
export type Key = keyof typeof zh;
