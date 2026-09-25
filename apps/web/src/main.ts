// ============================================================================
// Celestea Studio — bootstrap / wiring (TS + Vite)。
// 主题 → 侧栏(收起/拖宽) → statusline → 面板(工具/会话) → 配置弹层 →
// 聊天主循环 → SSE。所有具体职责均在 api/sse/state/statusline/theme/ui 模块内，
// 本文件只做初始化与模块装配。
// ============================================================================
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/statusline.css';
import './styles/contextview.css'; // W726 只读「完整上下文」浮层

import './styles/settings.css';
import './styles/views.css'; // W514 多会话视图容器 / 聚焦会话条 / 插话
import './styles/sessions.css';
import './styles/grants.css'; // W701 提权通道（本会话权限盾牌 / 面板 / 二次确认）
import './styles/permissions.css'; // W858 权限预设（设置页 pane + statusline 档位徽标/菜单）
import './styles/plugins.css'; // W859 设置页「插件」（客户端插件热开关 + 宿主清单只读）
import './styles/rail.css'; // 灵动选择条 v3（W238 重做）
import './styles/hint.css'; // W790 悬浮提示宿主（内置提示插件）
import './styles/question.css'; // W784 模型提问卡片（选项 / 自由输入 / 倒计时）
import './styles/attachments.css'; // W805 图片附件（待发条 / 气泡网格 / 放大）
import './styles/quote.css'; // F1 选段提及（引用卡 / 选区浮标 / 待发引用 chip）
import './styles/preview.css'; // F2 文件侧边预览（覆盖式浮层 / 代码 / 降级）
import './styles/commands.css'; // A3 斜杠命令补全框 / 终端输出 / 目标条
import './styles/workbench.css'; // G4 多面板工作区（入口菜单 / 可停靠面板 / 文件管理器）
import './styles/workerstrip.css'; // W866 会话页左上角 worker 快捷条
import './styles/tooltree.css'; // W1467 run_code 子调用缩进树
import './styles/responsive.css'; // W765 响应式层（断点：mobile ≤640 / tablet ≤1024）
// W1524 前端优化四波：各自独立的 CSS 文件，**共享 CSS 文件谁都不改**（见各文件头注释）。
import './styles/streaming.css'; // W-A 流式渲染
import './styles/caret.css'; // W-B 光标
import './styles/codeblock.css'; // W-C 代码块

import { api } from './api';
import { connectSse, initChat } from './chat';
import { setStatus } from './ui/statusbar';
import { initViewCtx } from './ui/viewctx'; // W514 每会话视图容器
import { initSessionBar } from './ui/sessionbar'; // W514 聚焦会话条
import { initSettingsPage } from './ui/config';
import { initSessionsPanel } from './ui/sessions';
import { initWorkerStrip } from './ui/worker-strip'; // W866 会话页左上角 worker 快捷条
import { initGrants } from './ui/grants'; // W701 提权通道（能力位未就绪时入口隐藏）
import { restoreActiveHistory } from './ui/restore';
import { flushVisible } from './ui/messages'; // W1485：后台切回时一次性对齐正文
import { initRail } from './ui/rail';
import { initEnhancers } from './ui/enhance'; // W895 渲染后增强缝（P0）
import { initHints } from './ui/hint'; // W790 悬浮提示注册缝（item 4）
import { installCommands, renderGoalBar } from './ui/commands'; // A3：斜杠命令 + 持久目标
import { initWorkbench } from './ui/workbench'; // G4：多面板工作区
import { t } from './i18n';
import { installQuoteSelection } from './ui/quote/select'; // F1：选段提及（选区浮标）
import { versionLabel, describeLabel, BUILD_TIME, APP_DIRTY } from './version'; // W887 构建期版本标签
import { initSidebar } from './ui/sidebar';
import { initChatCol } from './ui/chatcol'; // W867：正文列宽（两侧留白）可拖动调节
import { statusline } from './statusline';
import { S } from './state';
import { initTheme, setupThemeSwitcher } from './theme';
import { need } from './utils/dom';

/** 健康信息 → statusline（模型兜底）。#sideFoot 只归操作提示 note()，不再写模型名。 */
function refreshHealthChip(): void {
  void api
    .health()
    .then((h) => {
      // /api/status 未上线前，用 health 的模型填补 statusline（模型只在 #slModel 一处）
      if (h.model) statusline.merge({ model: h.model });
      if (!S.streaming) setStatus(t('shell.status.online'), 'ok');
    })
    .catch(() => {
      if (!S.streaming) setStatus(t('chat.status.disconnected'), 'err');
    });
}

function init(): void {
  // 1) 主题（第 26 轮：仅 mono 黑白；localStorage 持久化；单主题下顶栏按钮为 no-op）
  initTheme('mono');
  setupThemeSwitcher(need<HTMLButtonElement>('#btnTheme'));

  // 2) 侧栏：收起/展开 + 拖宽（状态持久）
  initSidebar();

  // 2.1) W867：正文列宽拖拽手柄（--chat-col-user 持久化；≤1024px 由 responsive 层隐藏）
  initChatCol();

  // 3) W514：多会话视图容器（LOCAL 容器先立起来 → 永不空白）+ 聚焦会话条
  initViewCtx();
  initSessionBar();

  // 3.1) W895：渲染后增强缝（内置 hljs + math；必须先于客户端插件装配）
  initEnhancers();

  // 3.1b) W790：悬浮提示注册缝（内置 150ms 卡片；调用点只写 setHint）
  initHints();

  // 4) statusline（/api/status?session= 轮询 + SSE 增量，发送栏正上方）
  statusline.start();

  // 3.2) W866：会话页左上角的 worker 快捷条（当前会话派了哪些 worker，点击聚焦）
  initWorkerStrip();

  // 4) 左侧面板：工作区/会话树（W227；工具清单已迁至「通用设置」页）
  initSessionsPanel();

  // 5) 「通用设置」页（取代原 #modal 弹层；热调 + 工具列表；保存成功后刷新健康信息）
  initSettingsPage();

  // 5.1) W701：本会话权限盾牌（能力位未就绪 → 入口保持隐藏，不报错不崩溃）
  initGrants();

  // 6) 版本标识（W887：构建期从 git tag 派生，见 version.ts）
  const verEl = document.getElementById('brandVersion');
  if (verEl) {
    verEl.textContent = versionLabel();
    verEl.title = t('chat.version.title', { time: BUILD_TIME, version: describeLabel(), dirty: APP_DIRTY ? t('chat.version.dirty') : '' });
  }

  // 7) 消息 rail（左侧灵动长条）+ 聊天主循环 + 启动恢复（按活跃会话） + SSE
  initRail();
  initChat();
  installQuoteSelection(); // F1：选段提及（viewctx 已就绪）
  installCommands(); // A3：斜杠命令补全 + ! 快捷方式（inputbar 已装配）
  initWorkbench(); // G4：右上角入口 + 多面板工作区
  renderGoalBar(); // A3：目标条（当前会话可能有目标）
  refreshHealthChip();
  void restoreActiveHistory();
  connectSse();

  // 配置保存成功 → 顶栏/statusline 反映新模型
  window.addEventListener('studio:config-saved', () => refreshHealthChip());

  // W1485：从后台切回时把后台累积的正文一次性对齐（后台期间不排渲染，见
  // ui/messages/assistant.ts 的 scheduleTextView / flushVisible）。
  // 只订阅可见性，不做任何网络请求 —— 与 grants.ts 的授权刷新互不干涉。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushVisible();
  });

  need<HTMLTextAreaElement>('#input').focus();
}

// type=module 脚本为 deferred 执行 → DOM 已就绪
init();
