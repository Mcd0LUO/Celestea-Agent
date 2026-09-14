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
import type { ConfigPatch, StatusPayload, StatusSnapshot } from './types';
import { pickStatusFields } from './statusline/fields';
import { fixed1 } from './statusline/icons';
import {
  closePopup,
  retryPendingPick,
  togglePopup,
  type ModelPick,
  type PickerHost,
  type SwitchKind,
} from './statusline/picker';
import {
  RING_C,
  renderCacheCell,
  renderContextCell,
  renderModelCell,
  type ModelCellState,
} from './statusline/ring';

const POLL_MS = 2000;

/** W514：状态字段筛选（statusline 渲染 + chat.ts 的每会话快照共用）。 */
export { pickStatusFields };

export class Statusline implements PickerHost {
  private snapshot: StatusSnapshot = {};
  private timer: number | null = null;
  private el: HTMLElement;
  private ring: HTMLElement;
  private ringProg: SVGCircleElement;
  private ctxEl: HTMLElement;
  private modelEl: HTMLElement;
  private effortEl: HTMLElement;
  private tpsEl: HTMLElement;
  /** W263: cache-hit-ratio cell (last stream + cumulative in the title). */
  private cacheEl: HTMLElement;
  private stepsEl: HTMLElement;
  private hintEl: HTMLElement;

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
    this.tpsEl = need<HTMLElement>('#slTps', this.el);
    this.cacheEl = need<HTMLElement>('#slCache', this.el);
    this.stepsEl = need<HTMLElement>('#slSteps', this.el);
    this.hintEl = need<HTMLElement>('#slHint', this.el);
    this.ringProg.style.strokeDasharray = String(RING_C);
    this.el.title = '上下文占用 · 模型 · 思考强度 · 吞吐 · 缓存命中';

    // W726：点上下文圆环 → 只读完整上下文浮层
    this.ring.setAttribute('role', 'button');
    this.ring.setAttribute('tabindex', '0');
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
    // Esc 关闭统一由 utils/overlays 层级栈处理（任务 3：唯一 document Esc 监听）
    document.addEventListener('click', (e) => {
      if (!this.popup) return;
      const t = e.target as Node;
      if (this.popup.contains(t)) return;
      if (this.modelEl.contains(t) || this.effortEl.contains(t)) return;
      closePopup(this);
    });
  }

  /** PickerHost：弹层挂载点（#statusline 元素）。 */
  get root(): HTMLElement {
    return this.el;
  }

  /** PickerHost：当前快照里的模型（全局配置，跨会话保留显示）。 */
  get snapshotModel(): string {
    return this.snapshot.model ?? '';
  }

  /** Begin polling /api/status. */
  start(): void {
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
    const cached = this.cache.get(next);
    this.snapshot = {
      model: this.snapshot.model,
      reasoning_effort: this.snapshot.reasoning_effort,
      ...(cached ?? {}),
    };
    this.render();
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
    this.setNote('本轮已结束，正在应用切换…', 0);
    void api
      .saveConfig(patch)
      .then((d) => {
        this.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
        this.setNote('已切换', 5000);
        window.dispatchEvent(new Event('studio:config-saved'));
      })
      .catch((err: unknown) => {
        this.setNote('切换失败：' + (err instanceof Error ? err.message : String(err)), 6000);
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
      this.setNote('当前版本不支持查看上下文', 4000);
      return;
    }
    if (this.session === '') {
      this.setNote('当前会话尚未就绪，请稍后再试', 4000);
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
      this.snapshot = { ...this.snapshot, ...s };
      this.cache.set(this.session, this.snapshot);
      this.render();
    } catch (err) {
      // /api/status 未上线或后端不可达：保持占位符，不打断聊天
      this.el.classList.add('sl-stale');
      this.staleMsg = '状态信息暂不可用';
      this.renderHint();
      this.el.title = userErrorText(err, '状态信息暂不可用');
    }
  }

  private render(): void {
    const s = this.snapshot;
    renderContextCell(this.ctxEl, this.ring, s.context_usage);

    renderModelCell(this.modelEl, s.model || '', this.modelCell);
    this.modelEl.title = '当前模型：' + (s.model || '—') + '（点击快速切换）';

    // 思考强度：'max' 直接显示；空/null 表示标准档
    const effort = s.reasoning_effort;
    this.effortEl.textContent = effort ? String(effort) : '—';
    this.effortEl.title = '思考强度：' + (effort ? String(effort) : '标准') + '（点击快速切换）';

    const tps = s.tokens_per_sec;
    this.tpsEl.textContent = tps !== undefined && tps !== null ? fixed1(tps) + ' tok/s' : '— tok/s';

    // W263 缓存命中率：只改文本（铁律 1/2/5——不重建 DOM，不重渲染背景）
    renderCacheCell(this.cacheEl, s.usage);

    const steps = s.steps;
    this.stepsEl.textContent = typeof steps === 'number' && steps >= 1 ? '第 ' + steps + ' 步' : '— 步';

    // W514：后端 busy 字段（多会话状态显示）——只切 class，不改布局
    this.el.classList.toggle('sl-live', s.busy === true);
  }
}

/**
 * W514：模块级单例——statusline 是「当前聚焦会话」的 chrome，chat.ts 需要在
 * 会话切换时调用 setSession()，因此由模块持有唯一实例（main.ts 只负责 start）。
 */
export const statusline = new Statusline();
