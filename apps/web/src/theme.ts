// ============================================================================
// Theme / color-card switching: <html data-theme> single attribute.
// 第 26 轮（W256）：仅保留单主题 mono（黑白 ins 风）；夜航（night）主题已删除。
// ============================================================================

export interface ThemeDef {
  id: string;
  label: string;
  hint: string;
}

export const THEMES: readonly ThemeDef[] = [
  { id: 'mono', label: '黑白', hint: '黑白 ins 风 · 纯灰阶浅色，零彩色点缀' },
];

const STORAGE_KEY = 'celestea-studio.theme';

export function currentTheme(): string {
  return document.documentElement.dataset.theme || 'mono';
}

export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Apply the persisted (or default) theme; returns the applied id.
 *  旧版 localStorage 里存过已删除主题 id 时（THEMES.some 不命中）自动回落到 mono。 */
export function initTheme(defaultId = 'mono'): string {
  let id = defaultId;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) id = saved;
  } catch {
    /* ignore */
  }
  applyTheme(id);
  return id;
}

/** Wire the topbar switcher：单主题下点击 = no-op（不循环、不闪动），
 *  按钮保留显示当前主题「黑白」。 */
export function setupThemeSwitcher(button: HTMLElement): void {
  const render = (): void => {
    const cur = currentTheme();
    const t = THEMES.find((x) => x.id === cur) ?? THEMES[0]!;
    button.textContent = t.label;
    button.title = '主题 · ' + t.hint + (THEMES.length > 1 ? '（点击切换）' : '（当前唯一主题）');
  };
  render();
  if (THEMES.length < 2) {
    // 仅剩单主题：不注册点击行为，避免无意义的重绘/闪动
    button.setAttribute('aria-disabled', 'true');
    return;
  }
  button.addEventListener('click', () => {
    const idx = THEMES.findIndex((t) => t.id === currentTheme());
    const next = THEMES[(idx + 1) % THEMES.length]!;
    applyTheme(next.id);
    render();
  });
}
