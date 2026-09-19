// i18n/locales/en/index.ts — English dictionary.
// 类型安全：Record<Key, string> ⇒ 漏译在**编译期**报错（key 集合必须与 zh 完全一致）。
import type { Key } from '../zh';
import { common } from './common';
import { api } from './api';
import { statusline } from './statusline';
import { settings } from './settings';
import { chat } from './chat';
import { shell } from './shell';

export const en: Record<Key, string> = { ...common, ...api, ...statusline, ...settings, ...chat, ...shell };
