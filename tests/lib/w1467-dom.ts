// ============================================================================
// tests/lib/w1467-dom.ts — W1467 门禁共用的最小 DOM 垫片。
//
// 为什么要共用：W1467 有两个门禁要在 node 里**跑真实前端生产代码**
// （ui/toolcards.ts / ui/restore.ts），而它们都要一份够用的 DOM。各写一份必然
// 分叉（本仓 W752 的教训：同一规则两份实现 = 迟早不一致），所以收口在这里。
//
// 覆盖范围刻意最小：只实现被测代码真正用到的方法。不支持的选择器**抛错**而不是
// 静默返回空 —— 静默失败会让门禁「绿得没有意义」。
// ============================================================================

export class El {
  tagName: string;
  childNodes: El[];
  parentNode: El | null;
  className: string;
  attrs: Map<string, string>;
  style: Record<string, string>;
  dataset: Record<string, string>;
  title: string;
  type: string;
  id: string;
  hidden: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  tabIndex: number;
  private _text: string;
  private _listeners: Map<string, Array<() => void>>;
  private _open: boolean;

  constructor(tag: string) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.className = "";
    this.attrs = new Map();
    this.style = {};
    this.dataset = {};
    this.title = "";
    this.type = "";
    this.id = "";
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
    this.tabIndex = 0;
    this._text = "";
    this._listeners = new Map();
    this._open = false;
  }

  get open(): boolean { return this._open; }
  set open(v: boolean) { this._open = v; this._fire("toggle"); }

  get classList() {
    const self = this;
    const list = (): string[] => String(self.className || "").split(/\s+/).filter((s) => s !== "");
    const set = (l: string[]): void => { self.className = l.join(" "); };
    return {
      add: (...c: string[]): void => { const l = list(); for (const x of c) if (x && !l.includes(x)) l.push(x); set(l); },
      remove: (...c: string[]): void => { set(list().filter((x) => !c.includes(x))); },
      contains: (c: string): boolean => list().includes(c),
      toggle: (c: string, force?: boolean): boolean => {
        const on = force === undefined ? !list().includes(c) : force;
        const l = list();
        set(on ? (l.includes(c) ? l : [...l, c]) : l.filter((x) => x !== c));
        return on;
      },
      toString: (): string => self.className,
    };
  }

  get textContent(): string { return this._text; }
  set textContent(v: string) { this._text = String(v); this.childNodes = []; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(k: string, fn: () => void): void {
    const l = this._listeners.get(k) ?? [];
    l.push(fn);
    this._listeners.set(k, l);
  }
  private _fire(k: string): void { for (const fn of this._listeners.get(k) ?? []) fn(); }

  appendChild(n: El): El {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n: El, ref: El | null): El {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const i = ref === null ? -1 : this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n: El): El {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes: El[]): void { this.childNodes = []; for (const n of nodes) this.appendChild(n); }

  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (n: El): void => {
      for (const c of n.childNodes) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** 只支持 tag / .cls / tag.cls 组合（以及 \'>\' 的末段）。其余抛错。 */
  matches(sel: string): boolean {
    const last = sel.split(">").pop()!.trim();
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(last);
    if (m === null) throw new Error("unsupported selector: " + sel);
    if (m[1] !== undefined && this.tagName !== m[1].toUpperCase()) return false;
    for (const cls of (m[2] ?? "").split(".")) {
      if (cls !== "" && !this.classList.contains(cls)) return false;
    }
    return true;
  }

  get isConnected(): boolean { return true; }
  get firstChild(): El | null { return this.childNodes[0] ?? null; }
  get nextSibling(): El | null {
    const p = this.parentNode;
    if (p === null) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
}

const WIN = globalThis as unknown as Record<string, unknown>;

/** 装全局 document / window / Node（幂等：重复调用无副作用）。 */
export function installDom(): void {
  WIN["document"] = {
    createElement: (tag: string) => new El(tag),
    createDocumentFragment: () => new El("#fragment"),
    createTextNode: (t: string) => { const e = new El("#text"); e.textContent = t; return e; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
  };
  WIN["Node"] = { DOCUMENT_POSITION_FOLLOWING: 4 };
  WIN["window"] = WIN;
  // node 自带的 navigator 是只读 getter（vitest 环境里可写），所以用 defineProperty
  // 覆盖 —— 复制按钮的点击路径要读 navigator.clipboard。
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });
}

/** 用 esbuild 把一组前端模块打成可 import 的 ESM（解析器挂在 apps/web 的依赖树上）。 */
export async function bundleFrontend(entry: string, outfile: string): Promise<void> {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const requireFromWeb = createRequire(join(root, "apps", "web", "package.json"));
  const { build } = requireFromWeb("esbuild") as { build: (o: Record<string, unknown>) => Promise<unknown> };
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: "w1467-entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile,
    logLevel: "warning",
  });
}

/**
 * 结构 class 白名单：决定「这棵树长什么样」的类。
 *
 * 刻意**排除**状态类（running / ok / err / has / streaming …）：live 与 replay 在
 * 这些位上本来就不同 —— 实时的卡还没结果（running），恢复的卡已经是终态
 * （ok / noResult）。本门禁比的是**树的形状**，把状态一起比会把「结构正确」淹没在
 * 「状态必然不同」的噪声里。状态本身由各自的门禁覆盖。
 */
const STRUCTURAL_CLASSES = new Set([
  "mcol", "msg", "tool", "bubble", "toolcard", "toolcard-subs",
  "toolcard-body", "toolcard-head", "toolcard-row1", "content",
  "msg-caption", "toolcard-args-preview", "toolcard-result-preview",
  "tool-args", "tool-out", "step-tag", "toolcard-name", "toolcard-state",
  "toolcard-copy", "toolcard-fold", "ts-dot", "ts-label", "who", "live-sep",
  "attach-grid", "toolcard-preview",
]);

/**
 * **工具树骨架**：只走决定「谁缩进在谁之下」的节点
 * （`.mcol` / `.msg.tool` / `.toolcard` / `.toolcard-subs`），
 * 忽略结果正文、状态类、以及恢复路径特有的分隔线。
 *
 * 为什么门禁比的是它而不是整棵树：live 抓的是「结果还没回来」的时刻，replay 的
 * 行里结果已经在了 —— 内容必然不同，而本仓要求一致的是**结构**（子调用缩进在
 * 哪个父项之下）。比整棵树会把「结构对」淹没在「内容本来就不同」里。
 * 内容各自另有门禁（如 w1467-subcall-tree 的结果态断言）。
 */
export function treeSkeleton(n: El): string {
  const isCard = n.classList.contains("mcol") || n.classList.contains("toolcard") || n.classList.contains("toolcard-subs");
  const kids = n.childNodes.filter((c) => c.tagName !== "#TEXT");
  const inner = kids.map(treeSkeleton).filter((s) => s !== "").join(",");
  if (!isCard) return inner; // 非骨架节点：透明穿透，只把下面的骨架提上来
  const name = n.classList.contains("mcol") ? "mcol" : n.classList.contains("toolcard") ? "card" : "subs";
  return name + (inner === "" ? "" : "[" + inner + "]");
}

/** 整棵子树的「标签 + 结构 class」形状（忽略文案、属性与状态类）。 */
export function shapeOf(n: El): string {
  const cls = String(n.className || "").trim().split(/\s+/)
    .filter((s) => STRUCTURAL_CLASSES.has(s)).sort().join(".");
  const head = cls === "" ? n.tagName.toLowerCase() : n.tagName.toLowerCase() + "." + cls;
  const kids = n.childNodes.filter((c) => c.tagName !== "#TEXT");
  return kids.length === 0 ? head : head + "[" + kids.map(shapeOf).join(",") + "]";
}

/** 子项相对父项的缩进层数（0 = 顶层平铺）。 */
export function depthOf(node: El): number {
  let d = 0;
  for (let p = node.parentNode; p !== null; p = p.parentNode) {
    if (p.classList.contains("toolcard-subs")) d += 1;
  }
  return d;
}

export function depthOfCards(root: El): number[] { return root.querySelectorAll(".toolcard").map(depthOf); }
