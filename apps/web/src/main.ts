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
import './styles/rail.css'; // 灵动选择条 v3（W238 重做）
import './styles/responsive.css'; // W765 响应式层（断点：mobile ≤640 / tablet ≤1024）

import { api } from './api';
import { connectSse, initChat } from './chat';
import { setStatus } from './ui/statusbar';
import { initViewCtx } from './ui/viewctx'; // W514 每会话视图容器
import { initSessionBar } from './ui/sessionbar'; // W514 聚焦会话条
import { initSettingsPage } from './ui/config';
import { initSessionsPanel } from './ui/sessions';
import { initGrants } from './ui/grants'; // W701 提权通道（能力位未就绪时入口隐藏）
import { restoreActiveHistory } from './ui/restore';
import { initRail } from './ui/rail';
import { APP_VERSION, BUILD_TIME } from './version'; // 灵动选择条 v3（W238 重做）
import { initSidebar } from './ui/sidebar';
import { statusline } from './statusline';
import { S } from './state';
import { initTheme, setupThemeSwitcher } from './theme';
import { need } from './utils/dom';

/** 健康信息 → 侧栏脚注 + statusline（模型兜底）。 */
function refreshHealthChip(): void {
  void api
    .health()
    .then((h) => {
      need<HTMLElement>('#sideFoot').textContent = h.model || '';
      // /api/status 未上线前，用 health 的模型填补 statusline
      if (h.model) statusline.merge({ model: h.model });
      if (!S.streaming) setStatus('就绪 · 在线', 'ok');
    })
    .catch(() => {
      if (!S.streaming) setStatus('无法连接服务', 'err');
    });
}

function init(): void {
  // 1) 主题（第 26 轮：仅 mono 黑白；localStorage 持久化；单主题下顶栏按钮为 no-op）
  initTheme('mono');
  setupThemeSwitcher(need<HTMLButtonElement>('#btnTheme'));

  // 2) 侧栏：收起/展开 + 拖宽（状态持久）
  initSidebar();

  // 3) W514：多会话视图容器（LOCAL 容器先立起来 → 永不空白）+ 聚焦会话条
  initViewCtx();
  initSessionBar();

  // 4) statusline（/api/status?session= 轮询 + SSE 增量，发送栏正上方）
  statusline.start();

  // 4) 左侧面板：工作区/会话树（W227；工具清单已迁至「通用设置」页）
  initSessionsPanel();

  // 5) 「通用设置」页（取代原 #modal 弹层；热调 + 工具列表；保存成功后刷新健康信息）
  initSettingsPage();

  // 5.1) W701：本会话权限盾牌（能力位未就绪 → 入口保持隐藏，不报错不崩溃）
  initGrants();

  // 6) 版本标识（原「v2 · TS」位置，第 22 轮改为构建版本）
  const verEl = document.getElementById('brandVersion');
  if (verEl) {
    verEl.textContent = 'Studio v' + APP_VERSION;
    verEl.title = 'Celestea Studio · 构建于 ' + BUILD_TIME;
  }

  // 7) 消息 rail（左侧灵动长条）+ 聊天主循环 + 启动恢复（按活跃会话） + SSE
  initRail();
  initChat();
  refreshHealthChip();
  void restoreActiveHistory();
  connectSse();

  // 配置保存成功 → 顶栏/statusline 反映新模型
  window.addEventListener('studio:config-saved', () => refreshHealthChip());

  need<HTMLTextAreaElement>('#input').focus();
}

// type=module 脚本为 deferred 执行 → DOM 已就绪
init();
