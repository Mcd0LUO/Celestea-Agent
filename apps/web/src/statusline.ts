// ============================================================================
// Statusline — 两行紧凑状态条，位于发送栏正上方（借鉴 DSH SessionStatusBar）：
//   第 1 行  上下文占用环(≥90% 警告色) + 「xxxK/1M」 + 当前模型 + 思考强度
//   第 2 行  tokens/s + 缓存命中率(W263) + step 数
// 数据源：GET /api/status 轮询（兜底）+ SSE status 事件增量字段
//   （SSE status 的 statusline 快照是嵌套对象，fromSse 里拍平后合并）。
// W227：模型/推理档位改为可点击按钮 → 紧凑下拉面板快速切换（POST /api/config），
//   409（轮次进行中）→ 提示并挂起，SSE done 后自动重试一次；400/500 → 内联报错。
// W726：上下文圆环可点击 → 打开只读「完整上下文」浮层（系统提示词/工具清单/
//   消息流）；能力位未就绪 → 只给一句轻提示，不报错、不打开浮层。
//
// W758：按职责拆到 ./statusline/*，本文件只保留 Statusline 编排（轮询 / 快照合并 /
//   渲染编排 / 只读上下文入口 / SSE done 钩子）并原样再导出对外 API（import 路径
//   与拆分前兼容）。拆分是纯搬家：无行为变更（类名、文案、DOM 结构、渲染顺序、
//   请求顺序、弹层生命周期均未改）。
//     ./statusline/picker.ts  模型/档位弹层（W227/W262/W750）+ 409 挂起重试
//     ./statusline/ring.ts    上下文环 / 缓存命中率 / 模型单元格（纯写入函数）
//     ./statusline/icons.ts   模型图标节点 + 数值小工具（纯 helper）
//     ./statusline/fields.ts  状态字段筛选（chat.ts 共用）
// ============================================================================
import { api, userErrorText } from './api';
import { contextSupported, openContextView } from './ui/contextview'; // W726 只读上下文浮层
import { need } from './utils/dom';
import type { OverlayHandle } from './utils/overlays';
import type { ConfigPatch, SessionMode, StatusPayload, StatusSnapshot } from './types';
import { pickStatusFields } from './statusline/fields';
import { DockCells } from './statusline/dock';
import {
  closePopup,
  retryPendingPick,
  togglePopup,
  type ModelPick,
  type PickerHost,
  type SwitchKind,
} from './statusline/picker';
import { optimisticPatchView, revertPointOf } from './statusline/optimistic';
import {
  closeModePopup,
  modePopupHit,
  renderModeBadge,
  toggleModePopup,
  type ModeHost,
} from './statusline/mode';
import {
  createPermissionController,
  registerTierHost,
  type PermissionController,
} from './statusline/permission';
import {
  RING_C,
  renderContextCell,
  renderModelCell,
  type ModelCellState,
} from './statusline/ring';

import { initGoalBadge, refreshGoalBadge } from './statusline/goal'; // A3：目标徽标
import { t } from './i18n'; // i18n P1-a：statusline 域文案走字典

const POLL_MS = 2000;

/** W514：状态字段筛选（statusline 渲染 + chat.ts 的每会话快照共用）。 */
export { pickStatusFields };

export class Statusline implements PickerHost, ModeHost {
  private snapshot: StatusSnapshot = {};
  private timer: number | null = null;
  private el: HTMLElement;
  private ring: HTMLElement;
  private ringProg: SVGCircleElement;
  private ctxEl: HTMLElement;
  private modelEl: HTMLElement;
  private effortEl: HTMLElement;
  private hintEl: HTMLElement;
  /** W788：会话工作方式徽标（只读；点击弹层切换）。 */
  private modeEl: HTMLElement;
  /**
   * W858/W1517：会话权限档位（徽标 + 面板段落，状态自持）。
   * W1517 起档位**不再有自己的按钮** —— 徽标写进盾牌（#slGrantTier），列表/切换住
   * 盾牌面板的 §1；页面没有 #slGrant 时为无入口（老骨架/其它测试夹具）。
   */
  private perm: PermissionController;

  // ---- 快速切换（W227 / W750）：弹层状态由 ./statusline/picker.ts 读写（PickerHost） ----
  /** W514: 当前聚焦会话 id（'' = 未解析/旧单会话）；轮询与快照按会话缓存。 */
  private session = '';
  private cache = new Map<string, StatusSnapshot>();
  popup: HTMLElement | null = null;
  popupKind: SwitchKind | null = null;
  /** 任务 3：弹层在全局层级栈中的句柄（Esc 只关栈顶一层）。 */
  popupOverlay: OverlayHandle | null = null;
  pendingPatch: ConfigPatch | null = null;
  /** W750：409 挂起的模型/提供商切换（SSE done 后按同一路径重试一次）。 */
  pendingPick: ModelPick | null = null;
  /** W750：状态栏已渲染的模型名/图标键（避免每次轮询重建同一行）。 */
  private modelCell: ModelCellState = { label: '', iconKey: null };
  /**
   * W1462：贴底信息行（胶囊**之外**）的三个数值格 + 它们的 stale 降对比。
   * 三项（tok/s / 缓存 / 步数）已移出 #statusline，宿主与写入规则收口在 ./statusline/dock.ts。
   */
  private readonly dock = new DockCells();
  private staleMsg = '';
  private note = '';
  private noteTimer: number | null = null;

  constructor() {
    this.el = need<HTMLElement>('#statusline');
    this.ring = need<HTMLElement>('.sl-ring', this.el);
    this.ringProg = need<SVGCircleElement>('.sl-ring-prog', this.el);
    this.ctxEl = need<HTMLElement>('#slCtx', this.el);
    this.modelEl = need<HTMLElement>('#slModel', this.el);
    this.effortEl = need<HTMLElement>('#slEffort', this.el);
    // W1462：这三项已移出胶囊（住贴底信息行 #statusbar）⇒ 作用域**必须**从 this.el
    // 放开到 document；仍用 need()（id 是运行时真源，缺失要当场炸而不是静默）。
    this.hintEl = need<HTMLElement>('#slHint', this.el);
    this.modeEl = need<HTMLElement>('#slMode', this.el);
    // W858/W1517：档位徽标（可选：其它骨架/老页面没有 #slGrant 时安静地不装入口）。
    // 同一个 controller 注册给盾牌面板当 §1 的宿主 —— 面板与徽标共用一份档位状态。
    this.perm = createPermissionController(this.el, () => this.session, (t, ms) => this.setNote(t, ms));
    registerTierHost(this.perm);
    this.ringProg.style.strokeDasharray = String(RING_C);
    this.el.title = t('statusline.tooltip');

    // W726：点上下文圆环 → 只读完整上下文浮层
    this.ring.setAttribute('role', 'button');
    this.ring.setAttribute('tabindex', '0');
    this.ring.setAttribute('aria-haspopup', 'dialog');
    this.ring.addEventListener('click', () => void this.openContext());
    this.ring.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void this.openContext();
      }
    });
    // W227：模型/档位点击快速切换
    this.modelEl.addEventListener('click', () => togglePopup(this, 'model'));
    this.effortEl.addEventListener('click', () => togglePopup(this, 'effort'));
    // W788：工作方式徽标（只读）→ 弹层切换
    this.modeEl.addEventListener('click', () => toggleModePopup(this));
    this.perm.attach(); // W858/W1517：档位徽标 → 合并面板的 §1（入口是盾牌）
    // Esc 关闭统一由 utils/overlays 层级栈处理（任务 3：唯一 document Esc 监听）
    document.addEventListener('click', (e) => {
      // W795：一律用**事件路径**判定「点在不在里面」——乐观渲染会当帧重绘弹层内容，
      // 被点的那一项随即被摘下来，contains() 会把这一次点击误判成「点了外面」而收起弹层。
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const hit = (...targets: (HTMLElement | null)[]): boolean =>
        targets.some((t) => t !== null && (path.some((n) => n === t) || t.contains(e.target as Node)));
      if (this.popup && !hit(this.popup, this.modelEl, this.effortEl)) closePopup(this);
      // W788：工作方式弹层同款——点自己/徽标不开倒，点别处关掉
      if (!modePopupHit(e) && !this.modeEl.contains(e.target as Node)) closeModePopup();
      // W1517：档位没有自己的弹层了 —— 它的面板就是盾牌面板，收起逻辑归
      // ui/grants.ts 的「点面板外/盾牌外 → closePanel」（唯一一份，不重复实现）。
    });
  }

  /** PickerHost：弹层挂载点（#statusline 元素）。 */
  get root(): HTMLElement {
    return this.el;
  }

  /** ModeHost：当前聚焦会话 id（'' = 未解析）。 */
  get sessionId(): string {
    return this.session;
  }

  /** ModeHost：快照里的工作方式（'' = 未知/老服务不返回）。 */
  get currentMode(): string {
    return typeof this.snapshot.mode === 'string' ? this.snapshot.mode : '';
  }

  /** ModeHost：切换成功 → 写回本会话快照并重渲染徽标（不重建 DOM）。 */
  applyMode(mode: SessionMode): void {
    this.snapshot = { ...this.snapshot, mode };
    this.cache.set(this.session, this.snapshot);
    this.render();
  }

  /** PickerHost：当前快照里的模型（该会话的状态线真源，按会话缓存保留显示）。 */
  get snapshotModel(): string {
    return this.snapshot.model ?? '';
  }

  /**
   * PickerHost（W870）：当前快照里的模型是否来自**该会话自己的** `session.json.model`
   * 覆盖（`GET /api/status` 的 `model_covered`）。选择器用它如实标一行
   * 「本会话已固定模型」。字段缺失（老服务 / 首次轮询未回）⇒ false，不虚标。
   */
  get sessionModelFixed(): boolean {
    return this.snapshot.model_covered === true;
  }

  /** PickerHost（W795）：当前快照里的推理档位；乐观渲染与失败回滚都要用它。 */
  get snapshotEffort(): string | null {
    return this.snapshot.reasoning_effort ?? null;
  }

  /** Begin polling /api/status. */
  start(): void {
    initGoalBadge(); // A3：目标徽标（#slGoal 存在时装配）
    this.poll();
    this.timer = window.setInterval(() => this.poll(), POLL_MS);
  }

  /**
   * W514：切换聚焦会话（chat.ts 在容器激活时调用）。
   * 立即显示该会话上次已知快照（缓存），并即时拉一次 /api/status?session=；
   * 模型/思考档位是全局配置，跨会话保留显示——切换不会闪成空白。
   */
  setSession(id: string): void {
    const next = id ?? '';
    if (this.session === next) return;
    this.session = next;
    refreshGoalBadge(); // A3：目标徽标按聚焦会话切换
    const cached = this.cache.get(next);
    this.snapshot = {
      model: this.snapshot.model,
      reasoning_effort: this.snapshot.reasoning_effort,
      ...(cached ?? {}),
    };
    this.render();
    this.perm.onSession(this.session); // W858/W1517：换会话 → 换一份档位徽标（面板随 grants 刷新）
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Merge incremental fields from an SSE status payload.
   * W263: the backend nests the snapshot ({"phase":..,"statusline":{..}}), so
   * the nested snapshot is flattened first; flat fields (older/newer shapes)
   * still win when present.
   */
  fromSse(p: StatusPayload): void {
    const flat = pickStatusFields({ ...(p.statusline ?? {}), ...p });
    if (Object.keys(flat).length > 0) {
      this.snapshot = { ...this.snapshot, ...flat };
      this.cache.set(this.session, this.snapshot);
      this.render();
    }
  }

  /** Merge any partial snapshot (e.g. health model / POST /api/config 响应). */
  merge(partial: StatusSnapshot): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.render();
  }

  /** SSE done 事件钩子：存在 409 挂起的快速切换补丁时自动重试一次。 */
  onSseDone(): void {
    // W750：模型/提供商切换先走（它可能还要先切 provider）；已接手就直接返回。
    if (retryPendingPick(this)) return;
    if (!this.pendingPatch) return;
    const patch = this.pendingPatch;
    this.pendingPatch = null;
    // W795 乐观：本轮已结束 ⇒ 同一帧内先把补丁画进状态栏（终态），请求在后台跑；
    // 失败再把模型/档位退回原值并说明原因（不再有「正在应用切换…」这类占位文案）。
    const prev = revertPointOf({ model: this.snapshotModel, effort: this.snapshotEffort });
    this.merge(optimisticPatchView(patch));
    void api
      .saveConfig(patch)
      .then((d) => {
        this.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
        this.setNote(t('statusline.switched'), 5000);
        window.dispatchEvent(new Event('studio:config-saved'));
      })
      .catch((err: unknown) => {
        this.merge(prev);
        const reason = err instanceof Error ? err.message : String(err);
        this.setNote(t('statusline.withRestoredSettings', { text: t('statusline.switchFailed', { reason }) }), 6000);
      });
  }

  // ---- 只读完整上下文（W726） -------------------------------------------------

  /**
   * 点上下文圆环：能力位就绪（capabilities.context === true）→ 打开只读浮层；
   * 未就绪 / 探测失败 → 只给一句用户语言的轻提示（不报错、不打开浮层）。
   * 会话 id 未解析（旧单会话容器）→ 同样只提示，不发无主请求。
   */
  private async openContext(): Promise<void> {
    if (!(await contextSupported())) {
      this.setNote(t('statusline.contextUnsupported'), 4000);
      return;
    }
    if (this.session === '') {
      this.setNote(t('statusline.sessionNotReady'), 4000);
      return;
    }
    openContextView(this.session);
  }

  /** 状态栏轻提示（PickerHost 回调；0 = 常驻到下次覆盖）。 */
  setNote(text: string, ms: number): void {
    this.note = text;
    if (this.noteTimer !== null) {
      window.clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    if (ms > 0) {
      this.noteTimer = window.setTimeout(() => {
        this.note = '';
        this.noteTimer = null;
        this.renderHint();
      }, ms);
    }
    this.renderHint();
  }

  private renderHint(): void {
    if (this.note) {
      this.hintEl.textContent = this.note;
      return;
    }
    this.hintEl.textContent = this.staleMsg;
  }

  private async poll(): Promise<void> {
    const asked = this.session;
    try {
      const s = await api.status(asked === '' ? undefined : asked);
      if (asked !== this.session) return; // 竞态：期间已切换会话，丢弃本次结果
      this.staleMsg = '';
      this.el.classList.remove('sl-stale');
      this.dock.setStale(false); // W1462：贴底信息行上的降对比同步复位
      this.snapshot = { ...this.snapshot, ...s };
      this.cache.set(this.session, this.snapshot);
      this.render();
    } catch (err) {
      // /api/status 未上线或后端不可达：保持占位符，不打断聊天
      this.el.classList.add('sl-stale');
      // W1462：tok/s / 缓存 / 步数已移出 #statusline（住贴底信息行 #statusbar）——
      // 降对比必须同时打到它们的**实际宿主**上，否则这三项在 stale 态看起来「是活的」。
      this.dock.setStale(true);
      this.staleMsg = t('statusline.statusUnavailable');
      this.renderHint();
      this.el.title = userErrorText(err, t('statusline.statusUnavailable'));
    }
  }

  private render(): void {
    const s = this.snapshot;
    renderContextCell(this.ctxEl, this.ring, s.context_usage);

    renderModelCell(this.modelEl, s.model || '', this.modelCell);
    this.modelEl.title = t('statusline.currentModelTitle', { model: s.model || '—' });
    this.modelEl.setAttribute('aria-label', t('statusline.currentModelAria', { model: s.model || '—' }));

    // 思考强度：'max' 直接显示；空/null 表示标准档
    const effort = s.reasoning_effort;
    this.effortEl.textContent = effort ? String(effort) : '—';
    this.effortEl.title = t('statusline.effortTitle', { effort: effort ? String(effort) : t('statusline.standard') });
    this.effortEl.setAttribute('aria-label', t('statusline.effortAria', { effort: effort ? String(effort) : t('statusline.standard') }));

    // W1462：吞吐 / 缓存命中 / 步数三项住在**胶囊之外**的贴底信息行 —— 写入与 stale
    // 降对比整段收口在 ./statusline/dock.ts（本类不再自己拿这三个节点）。
    this.dock.render(s, this.session);

    // W788：工作方式徽标（未知 → 隐藏入口，不显示错误——设计 §6.5）
    renderModeBadge(this.modeEl, s.mode);

    // W514：后端 busy 字段（多会话状态显示）——只切 class，不改布局
    this.el.classList.toggle('sl-live', s.busy === true);
  }
}

/**
 * W514：模块级单例——statusline 是「当前聚焦会话」的 chrome，chat.ts 需要在
 * 会话切换时调用 setSession()，因此由模块持有唯一实例（main.ts 只负责 start）。
 */
export const statusline = new Statusline();
