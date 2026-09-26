// ============================================================================
// statusline/permission.ts — W858 起：会话权限**档位**的徽标与面板段落。
//
//   W1517（用户本轮明确要求「合并入口」）：档位**不再有自己的按钮** —— 它与精细授权
//   共用一个盾牌入口（index.html #slGrant）与一个面板（ui/grants/panel/body.ts 的
//   §1 会话档位 + §2 精细授权）。本模块只做两件事：
//     ① 徽标：把当前聚焦会话生效的档位名写进盾牌徽标区（#slGrantTier，
//        与授权计数 #slGrantBadge 同处一格 —— 不做两行）；
//     ② 面板段落：见 ./permission/tier.ts（列表 / 切换 / 失败回滚）。
//
//   旧口径「入口分列、互不合并（任务书明确要求）」已被本轮用户指令**取代**
//   （设计 docs/feature-permission-entry-merge.md §6 R1）—— 注释留着就是漂移。
//   两个概念本身仍是两回事：档位管会话基线 preset（GET/PUT /api/sessions/{id}/permission），
//   盾牌管本会话的临时能力放宽（grants）。
//
//   显隐纪律（合并后的唯一口径，设计 §4 I2）：入口的显隐真源**只有**
//   ui/grants.ts 的能力位（capabilities.grants 未就绪 ⇒ 保持 .hidden，不置灰报错）。
//   本模块**从不**改入口的可见性 —— 无活动会话、或该部署没有档位端点时，只是档位段落
//   说明原因/留空，入口照旧可用（否则「档位端点缺失」会连精细授权一起藏掉）。
//
//   数据：档位清单走 ui/permissions/store 的共享缓存；当前档位走
//   GET /api/sessions/{id}/permission（按会话缓存）。
//
//   装配：statusline.ts 只 new 一个 controller 并转发两个事件（attach / onSession），
//   徽标状态留在本模块（statusline.ts 的体积棘轮友好）。
// ============================================================================
import { ApiError, api } from '../api';
import { ensurePresets, labelOf } from '../ui/permissions/store';
import { renderShield } from '../ui/grants/panel/shield';

/** 徽标视图（preset '' = 未解析/未知 ⇒ 徽标留空）。 */
export interface PermissionView {
  preset: string;
  label: string;
}

/** 面板段落宿主：会话 / 当前档位 / 两个写回回调。 */
export interface PermissionHost {
  readonly sessionId: string;
  readonly currentPreset: string;
  /** 写回档位视图（乐观与回滚共用；preset '' = 徽标留空）。 */
  applyPermission(preset: string, label: string): void;
  setNote(text: string, ms: number): void;
}

/** statusline 装配用的控制器（本模块自持徽标状态）。 */
export interface PermissionController extends PermissionHost {
  /** 装上徽标：#slGrant 缺失 = 本页面没有该入口（老骨架/其它测试夹具）。 */
  attach(): void;
  /** 聚焦会话变化：先按本会话缓存画一帧，再拉一次权威值。 */
  onSession(session: string): void;
}

/**
 * 合并入口的档位徽标：只改文本，不重建 DOM（铁律 1/2/5）。
 *
 * W1517：`tierEl` = 盾牌徽标区里的档位格（#slGrantTier）。档位未知（无活动会话 /
 * 老服务没有档位端点）⇒ 留空 —— 不写「未知」之类的占位，也**绝不**碰入口的 .hidden
 * （显隐真源是 ui/grants.ts 的能力位，见文件头 I2）。
 *
 * 入口的 title/aria 不在这里写：唯一入口同时承载三态与档位，两个写者会互相覆盖
 * （合并前是「档位徽标 vs 盾牌」两个元素各写各的）。现在由三态渲染（panel/shield.ts）
 * 读本模块写下的档位文本统一拼一次。
 */
function paintTier(tierEl: HTMLElement | null, view: PermissionView | null): void {
  const known = view !== null && view.preset !== '';
  if (tierEl !== null) tierEl.textContent = known ? view.label || view.preset : '';
}

/** 装配入口：root = #statusline；sessionOf = 当前聚焦会话；note = 状态栏轻提示。 */
export function createPermissionController(
  root: HTMLElement,
  sessionOf: () => string,
  note: (text: string, ms: number) => void,
): PermissionController {
  let button: HTMLElement | null = null;
  let tierEl: HTMLElement | null = null;
  let session = '';
  const cache = new Map<string, PermissionView>();

  const paint = (): void => paintTier(tierEl, cache.get(session) ?? null);

  const ctrl: PermissionController = {
    get sessionId() {
      return session;
    },
    get currentPreset() {
      return cache.get(session)?.preset ?? '';
    },
    applyPermission(preset: string, label: string) {
      if (preset === '') cache.delete(session);
      else cache.set(session, { preset, label });
      paint();
      renderShieldTitle(); // 档位变了 → 合并入口的标题跟着变（同一元素，单一写者）
      repaintPanel(); // 面板开着时 §1 的「当前」标记跟着变（档位没有自己的弹层了）
    },
    setNote: (text, ms) => note(text, ms),
    attach() {
      button = root.querySelector<HTMLElement>('#slGrant');
      tierEl = root.querySelector<HTMLElement>('#slGrantTier');
      if (button === null) return;
      session = sessionOf();
      paint();
    },
    onSession(next: string) {
      session = next;
      paint();
      if (button !== null) void refreshPermission(ctrl);
    },
  };
  return ctrl;
}

/**
 * 档位文本变了 → 请三态渲染重写一次入口标题（title/aria 的**唯一写者**是 shield.ts）。
 *
 * 方向说明：permission.ts → grants/panel/shield.ts 是一条纯写函数依赖（shied.ts 只读
 * state + i18n，不反向 import 本模块），没有环；反过来让 shield.ts 订阅档位事件会
 * 引入回调注册，收益不如这条直白。
 */
function renderShieldTitle(): void {
  try {
    renderShield();
  } catch {
    /* 未装配 grants（只加载 statusline 的夹具）：没有三态可渲染，忽略 */
  }
}

/**
 * 合并面板（ui/grants/panel/body.ts）读档位宿主的唯一入口。
 *
 * 为什么走模块级注册而不是让面板 import statusline.ts：面板与 statusline 是两个
 * 装配方向（statusline → grants 不存在依赖，grants/panel → statusline/permission
 * 只有这一条缝），注册缝保证方向单向、也保证「面板里的档位段」与「状态栏徽标」
 * 永远是**同一个** controller 实例（同一个会话、同一份档位缓存，不会失同步）。
 * 未装配（其它测试夹具只加载 grants）时为 null ⇒ 面板只画 §2，不画空壳。
 */
let tierHost: PermissionHost | null = null;

export function registerTierHost(h: PermissionHost | null): void {
  tierHost = h;
}

export function registeredTierHost(): PermissionHost | null {
  return tierHost;
}

/**
 * 档位视图变化（含换会话后的权威值落定）→ 面板 §1 需要重画时的回调。
 * 由面板主体在打开时注册、关闭时清空（同一套单向注册缝，理由同上）。
 */
let repaintPanel: () => void = () => {};

export function registerTierRepaint(fn: () => void): void {
  repaintPanel = fn;
}

/**
 * 请求代号（W9204 · P1-4）。**只比会话 id 是不够的**：同一个会话上两次请求乱序返回时
 * （20s 轮询的 refresh(true) 与 statusline.setSession 的重入、用户快速切回同一会话），
 * 后到的**旧**快照会把新的覆盖掉 —— asked === h.sessionId 对两者都成立，守卫拦不住。
 * 代号一旦自增，所有在途请求都作废，只有最后一次发出的请求才有资格写回。
 *
 * 先例：grants.ts 的 askedAt（快照发起时刻 + settleOptimistic 比先后）、
 * mode.ts 的对象同一性守卫、preview/panel 的 seq。
 */
let permSeq = 0;

/**
 * 拉取当前会话的档位（onSession 调用）。竞态守卫：结果回来时**不是最后一次请求**就丢弃
 * （会话已切换、或同一会话上已有更新的请求在飞 —— 见 permSeq 的注释）。
 * 404/405 = 该部署没有这个能力 → 徽标留空；网络不可达（status 0）保留上次视图。
 */
export async function refreshPermission(h: PermissionHost): Promise<void> {
  const asked = h.sessionId;
  const seq = ++permSeq;
  if (asked === '') {
    h.applyPermission('', '');
    return;
  }
  try {
    const [r] = await Promise.all([api.sessionPermission(asked), ensureTierLabels()]);
    if (seq !== permSeq || asked !== h.sessionId) return;
    if (r.ok === false || typeof r.preset !== 'string' || r.preset === '') {
      h.applyPermission('', '');
      return;
    }
    h.applyPermission(r.preset, labelOf(r.preset));
  } catch (err) {
    if (seq !== permSeq || asked !== h.sessionId) return;
    if (err instanceof ApiError && err.status !== 0) h.applyPermission('', '');
  }
}

/**
 * 档位清单（共享缓存）拉一次，好让徽标能显示**显示名**而不是 id。
 *
 * 为什么单独一个函数而不是直接 await store.ensurePresets()：清单是**装饰性**的
 * （拿不到时徽标回落显示 id），不该把「档位读取」这条路径拖住或拖挂；失败一律吞掉，
 * 由面板段落自己决定空态文案。竞态（期间切换会话）由调用方 refreshPermission 守卫。
 */
async function ensureTierLabels(): Promise<void> {
  try {
    await ensurePresets();
  } catch {
    /* 取不到清单：徽标回落显示 id（不编造、不隐藏） */
  }
}
