// ============================================================================
// ui/preview/modes.ts — HTML 预览的「预览 / 源码」切换控件（W1534）
// ----------------------------------------------------------------------------
// 两条硬约束，都是被真实缺陷逼出来的：
//
//   ① **常驻可见**，不是 hover 才显形。
//      本仓 W1526 修过同一类问题：代码块的复制/徽标按钮原是 opacity:0 的浮层，
//      悬停才显形 —— 用户既找不到控件，控件又会**压在正文上挡字**。
//      结论是「看得见才点得到」（响应式层 §4 同一口径：触屏没有 hover）。
//      ⇒ 这里按钮常显，靠 aria-pressed 表达选中态，不靠 opacity 显隐。
//
//   ② **不覆盖正文**。
//      控件住在 .preview-head（面板头部的正常流一行），而正文在 .preview-body。
//      两者是**上下相邻的两个块** ⇒ 轴对齐矩形在几何上不可能相交，与内容长度/
//      滚动位置无关。这比「调 z-index / 加留白」那种经验性做法可断言得多
//      （W1526 的判定法：轴对齐矩形不相交）。
//
// 无障碍：一组互斥按钮 = role=group + aria-pressed，键盘 Tab 可达、Enter/Space 触发。
// ============================================================================
import { el } from '../../utils/dom';
import { t } from '../../i18n';

/** 查看方式：渲染预览 / 高亮源码。 */
export type PreviewView = 'preview' | 'source';

export interface ModeSwitch {
  /** 控件根节点（住 .preview-head）。 */
  node: HTMLElement;
  /** 同步选中态（不触发回调）。 */
  setView(v: PreviewView): void;
  /** 显隐（只有 html 类且内容可渲染时才显示）。 */
  setVisible(on: boolean): void;
}

const VIEWS: readonly PreviewView[] = ['preview', 'source'];

const LABEL_KEY = {
  preview: 'chat.preview.modePreview',
  source: 'chat.preview.modeSource',
} as const;

/**
 * 造一个「预览 / 源码」切换控件。
 *
 * @param onPick 用户点击时回调（**只在真的换了**视图时触发一次；重复点当前项不回调）。
 */
export function createModeSwitch(onPick: (v: PreviewView) => void): ModeSwitch {
  const node = el('div', 'preview-modes');
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', t('chat.preview.modeAria'));
  node.classList.add('hidden'); // 默认隐藏：只有 html 且内容可渲染时才显示
  const buttons = new Map<PreviewView, HTMLButtonElement>();
  for (const v of VIEWS) {
    const b = el('button', 'preview-mode', t(LABEL_KEY[v])) as HTMLButtonElement;
    b.type = 'button';
    b.dataset['view'] = v;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return; // 已是当前项：不重复回调
      onPick(v);
    });
    buttons.set(v, b);
    node.appendChild(b);
  }
  const setView = (v: PreviewView): void => {
    for (const [key, b] of buttons) b.setAttribute('aria-pressed', key === v ? 'true' : 'false');
  };
  setView('preview');
  return {
    node,
    setView,
    setVisible: (on: boolean) => { node.classList.toggle('hidden', !on); },
  };
}
