// ============================================================================
// ui/fsbrowser.ts — 目录选择弹窗（W701 从 ui/sessions.ts 抽出，供多处复用）：
//   「新建工作区」与「提权 · 选择目录」共用同一套浏览体验，避免用户手打路径出错。
//   行为与抽出前逐字一致：面包屑（'/' 起）+ 子目录列表 + 可编辑路径 + 跳转，
//   懒加载（GET /api/fs/browse）；该端点在旧服务上不可用时降级为「手输路径 + 跳转」。
//   挂到 body 的弹窗打开时压入 Esc 层级栈（utils/overlays），一次 Esc 只关栈顶一层。
//   离屏构建 + 单次替换（FRONTEND-RULES 铁律 1）；打开/关闭不触碰背景视图（铁律 5）。
// ============================================================================
import { api, userErrorText } from '../api';
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';

/** 确认选目录时交给调用方的交互句柄。 */
export interface FsBrowserUi {
  /** 状态行（调用方用于显示失败原因）。 */
  status: HTMLElement;
  /** 切换「确认中…」两态（防止重复提交）。 */
  setBusy: (busy: boolean) => void;
  /** 关闭弹窗。 */
  close: () => void;
}

export interface FsBrowserOpts {
  title: string;
  note?: string;
  confirmLabel: string;
  /** 提交中按钮文案。 */
  busyLabel: string;
  /** 浏览不可用时的降级提示（缺省给通用一句）。 */
  fallbackNote?: string;
  /** 确认选中目录；调用方自行决定成功/失败后的行为。 */
  onPick: (path: string, ui: FsBrowserUi) => void | Promise<void>;
  /**
   * 弹窗关闭后回调一次（取消 / Esc / 调用方 close()）；`picked` =
   * 调用方在 onPick 中记下的路径（未选中 = null）。用于把「选目录」封装成 Promise。
   */
  onClose?: (picked: string | null) => void;
}

function folderIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z');
  svg.appendChild(p);
  return svg;
}

/** 打开目录选择弹窗（顶部不含输入框，确认动作由调用方定义）。 */
export function openFsBrowser(opts: FsBrowserOpts): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card ws-fs');
  card.appendChild(el('div', 'modal-card-title', opts.title));
  if (opts.note) card.appendChild(el('div', 'side-note', opts.note));

  let curPath = '';

  const crumbs = el('div', 'ws-fs-crumbs');
  const tree = el('div', 'ws-fs-tree');
  const addrRow = el('div', 'ws-fs-addr');
  const addrInput = el('input', 'cfg-input') as HTMLInputElement;
  addrInput.placeholder = '目录路径（可编辑后跳转）';
  addrInput.value = '';
  const goBtn = el('button', 'btn btn-soft btn-mini', '跳转') as HTMLButtonElement;
  goBtn.type = 'button';
  addrRow.appendChild(addrInput);
  addrRow.appendChild(goBtn);

  const status = el('div', 'ws-fs-status');
  card.appendChild(crumbs);
  card.appendChild(tree);
  card.appendChild(addrRow);
  card.appendChild(status);

  function renderCrumbs(path: string): void {
    // 面包屑始终以可点击的 '/' 开头（路径为空时也渲染，点击 loadDirs('/')）。
    // 离屏构建 + 单次替换（铁律 1：不先清空可见容器）。
    const off = document.createElement('div');
    const parts = path.split('/').filter(Boolean);
    const rootBtn = el('button', 'ws-fs-crumb' + (parts.length ? '' : ' cur'), '/') as HTMLButtonElement;
    rootBtn.type = 'button';
    rootBtn.title = '根目录 /';
    rootBtn.addEventListener('click', () => void loadDirs('/'));
    off.appendChild(rootBtn);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      acc += '/' + seg;
      const b = el('button', 'ws-fs-crumb' + (i === parts.length - 1 ? ' cur' : ''), seg) as HTMLButtonElement;
      b.type = 'button';
      const target = acc;
      b.addEventListener('click', () => void loadDirs(target));
      off.appendChild(b);
    }
    crumbs.replaceChildren(...off.childNodes);
  }

  async function loadDirs(path: string): Promise<void> {
    // 目录跳转双缓冲：旧目录列表保留到新列表就绪，一次替换。
    status.className = 'ws-fs-status';
    status.textContent = '加载中…';
    let r;
    try {
      r = await api.fsBrowse(path);
    } catch {
      status.className = 'ws-fs-status err';
      status.textContent = '文件浏览暂不可用 · 请直接在下方输入路径';
      const off = document.createElement('div');
      off.appendChild(
        el('div', 'side-note', opts.fallbackNote ?? '可编辑底部路径后点「跳转」再确认'),
      );
      tree.replaceChildren(...off.childNodes);
      addrInput.value = path;
      curPath = path;
      return;
    }
    if (r.error) {
      status.className = 'ws-fs-status err';
      status.textContent = '浏览失败：' + userErrorText(r.error, '请手动输入目录路径');
    } else {
      status.textContent = '已选择目录：' + (r.path || '/');
      status.className = 'ws-fs-status ok';
    }
    curPath = r.path ?? path;
    addrInput.value = r.path ?? path;
    renderCrumbs(r.path ?? path);
    const off = document.createElement('div');
    const dirs = r.dirs ?? [];
    if (!dirs.length) off.appendChild(el('div', 'side-note', '（该目录下没有子目录）'));
    for (const d of dirs) {
      const row = el('div', 'ws-fs-dir');
      const icon = el('span', 'ws-fs-dir-icon');
      icon.appendChild(folderIcon());
      row.appendChild(icon);
      row.appendChild(el('span', 'ws-fs-dir-name', d));
      row.addEventListener('click', () => {
        const next = (curPath ? curPath.replace(/\/+$/, '') : '') + '/' + d;
        void loadDirs(next);
      });
      off.appendChild(row);
    }
    tree.replaceChildren(...off.childNodes);
  }

  goBtn.addEventListener('click', () => {
    const p = addrInput.value.trim();
    if (p) void loadDirs(p);
  });
  addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn.click();
  });

  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const confirm = el('button', 'btn btn-accent', opts.confirmLabel) as HTMLButtonElement;
  confirm.type = 'button';

  let overlay: OverlayHandle | null = null;
  let closed = false;
  let picked: string | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
    opts.onClose?.(picked);
  };
  overlay = pushOverlay(close);
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', () => {
    const path = curPath || addrInput.value.trim();
    if (!path) {
      status.className = 'ws-fs-status err';
      status.textContent = '请先选择/输入目录路径';
      addrInput.focus();
      return;
    }
    picked = path;
    void opts.onPick(path, {
      status,
      close,
      setBusy: (busy: boolean) => {
        confirm.disabled = busy;
        confirm.textContent = busy ? opts.busyLabel : opts.confirmLabel;
      },
    });
  });
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  void loadDirs('');
}

/** 选目录 → Promise<绝对路径 | null>（取消 / Esc = null）。 */
export function pickDirectory(title: string, note?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openFsBrowser({
      title,
      note,
      confirmLabel: '选择此目录',
      busyLabel: '处理中…',
      onPick: (path, ui) => {
        picked = path;
        ui.close();
      },
      onClose: () => finish(picked),
    });
  });
}
