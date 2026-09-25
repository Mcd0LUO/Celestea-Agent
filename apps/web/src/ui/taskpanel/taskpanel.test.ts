// @vitest-environment jsdom
/**
 * W1533 · 任务面板（todo list）DOM 行为。
 *
 * 加载**真实模块**（apps/web/src/ui/taskpanel/*），不复制逻辑。断言三件事：
 *   ① 局部更新 —— pending → completed 时**只有那一行**的 DOM 变，节点引用相等；
 *   ② 打勾可见 —— completed 行有对勾字形与 is-completed 类；
 *   ③ 空态 / 全完成态文案 + 折叠不重建 DOM（铁律 4）。
 *
 * 像素级几何（非零尺寸、真的可见）由真机 CDP 实测（见 results/W1533-*.png）；
 * jsdom 无排版，这里只钉结构与节点身份。
 */
import { beforeEach, describe, expect, it } from "vitest";

interface TaskItemLike { content: string; status: string }
interface Counts { pending: number; inProgress: number; completed: number }
interface Snap { tasks: TaskItemLike[]; counts: Counts }
interface ModelMod {
  readTasks(source: unknown): TaskItemLike[] | null;
  deltaOf(prev: TaskItemLike[], next: TaskItemLike[]): string;
  changedIndexes(prev: TaskItemLike[], next: TaskItemLike[]): number[];
  panelStateOf(tasks: TaskItemLike[]): string;
  rowKeys(tasks: TaskItemLike[]): string[];
}
interface RowRef {
  root: HTMLElement;
  check: HTMLElement;
  text: HTMLElement;
  statusEl: HTMLElement;
  status: string;
  content: string;
}
interface PanelRef {
  root: HTMLElement;
  head: HTMLElement;
  count: HTMLElement;
  body: HTMLElement;
  list: HTMLElement;
  note: HTMLElement;
  rows: RowRef[];
  collapsed: boolean;
  tasks: TaskItemLike[];
}
interface PanelMod {
  buildPanel(): PanelRef;
  renderPanel(ref: PanelRef, snap: Snap): string;
  setCollapsed(ref: PanelRef, collapsed: boolean): void;
  hidePanel(ref: PanelRef): void;
}
interface StoreMod {
  setTasks(pane: unknown, tasks: TaskItemLike[]): string;
  tasksOf(pane: unknown): Snap | null;
  onTasksChange(cb: (pane: unknown, snap: unknown) => void): () => void;
  resetTasks(): void;
}

// 同目录直接相对导入：跑的是**真实模块**（不复制逻辑）。
const loadModel = async (): Promise<ModelMod> => (await import("./model")) as ModelMod;
const loadPanel = async (): Promise<PanelMod> => (await import("./panel")) as PanelMod;
const loadStore = async (): Promise<StoreMod> => (await import("./store")) as StoreMod;

function row(content: string, status: string): TaskItemLike { return { content, status }; }
function snapOf(tasks: TaskItemLike[]): Snap {
  const counts: Counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const t of tasks) {
    if (t.status === 'pending') counts.pending += 1;
    else if (t.status === 'in_progress') counts.inProgress += 1;
    else counts.completed += 1;
  }
  return { tasks, counts };
}

beforeEach(() => { document.body.replaceChildren(); });

describe("W1533 · model（纯数据层）", () => {
  it("readTasks 接受规范形状，拒绝任何不完整形状（绝不画半截列表）", async () => {
    const m = await loadModel();
    expect(m.readTasks({ tasks: [row('a', 'pending')] })).toEqual([row('a', 'pending')]);
    expect(m.readTasks({ tasks: [] })).toEqual([]);
    expect(m.readTasks({})).toBeNull();
    expect(m.readTasks({ tasks: 'x' })).toBeNull();
    expect(m.readTasks({ tasks: [{ content: 'a' }] })).toBeNull();
    expect(m.readTasks({ tasks: [{ content: 'a', status: 'done' }] })).toBeNull();
    expect(m.readTasks({ tasks: [null] })).toBeNull();
  });

  it("deltaOf 三态：逐行相同 same / 只有状态变 inplace / 行集合变 rebuild", async () => {
    const m = await loadModel();
    const a = [row('1', 'pending'), row('2', 'pending')];
    expect(m.deltaOf(a, [row('1', 'pending'), row('2', 'pending')])).toBe('same');
    expect(m.deltaOf(a, [row('1', 'completed'), row('2', 'pending')])).toBe('inplace');
    expect(m.deltaOf(a, [row('1', 'completed')])).toBe('rebuild');
    expect(m.deltaOf(a, [row('2', 'pending'), row('1', 'pending')])).toBe('rebuild');
  });

  it("changedIndexes 只报真正变化的下标", async () => {
    const m = await loadModel();
    const a = [row('1', 'pending'), row('2', 'pending'), row('3', 'pending')];
    expect(m.changedIndexes(a, [row('1', 'pending'), row('2', 'completed'), row('3', 'pending')])).toEqual([1]);
    expect(m.changedIndexes(a, a)).toEqual([]);
  });

  it("空态 / 全完成态 / 清单态", async () => {
    const m = await loadModel();
    expect(m.panelStateOf([])).toBe('empty');
    expect(m.panelStateOf([row('a', 'completed'), row('b', 'completed')])).toBe('allDone');
    expect(m.panelStateOf([row('a', 'completed'), row('b', 'pending')])).toBe('list');
    expect(m.panelStateOf([row('a', 'in_progress')])).toBe('list');
  });

  it("rowKeys 用内容做身份，重复内容按出现次序消歧（键唯一）", async () => {
    const m = await loadModel();
    const k = m.rowKeys([row('a', 'pending'), row('b', 'pending'), row('a', 'pending')]);
    expect(new Set(k).size).toBe(3);
    expect(k[0] === k[2]).toBe(false);
    expect(m.rowKeys([row('a', 'pending'), row('b', 'pending')])).toEqual(m.rowKeys([row('a', 'x'), row('b', 'y')]));
  });
});

describe("W1533 · panel 局部更新（节点引用相等性）", () => {
  it("pending → completed 只改那一行：其它行的节点引用逐个相等", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    document.body.appendChild(ref.root);
    P.renderPanel(ref, snapOf([row('甲', 'pending'), row('乙', 'pending'), row('丙', 'pending')]));
    expect(ref.rows).toHaveLength(3);
    const before = ref.rows.map((r) => ({ root: r.root, check: r.check, text: r.text, statusEl: r.statusEl }));
    const delta = P.renderPanel(ref, snapOf([row('甲', 'pending'), row('乙', 'completed'), row('丙', 'pending')]));
    expect(delta).toBe('inplace');
    expect(ref.rows).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(ref.rows[i]!.root, 'row ' + String(i) + ' root').toBe(before[i]!.root);
      expect(ref.rows[i]!.check).toBe(before[i]!.check);
      expect(ref.rows[i]!.text).toBe(before[i]!.text);
      expect(ref.rows[i]!.statusEl).toBe(before[i]!.statusEl);
    }
    expect(before[0]!.check.textContent).toBe('');
    expect(before[1]!.check.textContent).toBe('\u2713');
    expect(before[2]!.check.textContent).toBe('');
    expect(before[1]!.root.classList.contains('is-completed')).toBe(true);
    expect(before[1]!.root.classList.contains('is-pending')).toBe(false);
    expect(before[0]!.root.classList.contains('is-pending')).toBe(true);
  });

  it("逐行相同 ⇒ 一个节点都不碰（delta=same，渲染器直接返回）", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    P.renderPanel(ref, snapOf([row('甲', 'completed')]));
    const node = ref.rows[0]!.root;
    expect(P.renderPanel(ref, snapOf([row('甲', 'completed')]))).toBe('same');
    expect(ref.rows[0]!.root).toBe(node);
  });

  it("行集合变化 ⇒ 离屏构建 + 单次替换（rebuild，铁律 1）", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    P.renderPanel(ref, snapOf([row('甲', 'pending')]));
    const old = ref.rows[0]!.root;
    expect(P.renderPanel(ref, snapOf([row('甲', 'pending'), row('乙', 'pending')]))).toBe('rebuild');
    expect(ref.list.children).toHaveLength(2);
    expect(ref.rows[0]!.root).not.toBe(old);
    expect(ref.list.contains(old)).toBe(false);
  });

  it("打勾可见：completed 有对勾字形，in_progress 有箭头，pending 为空", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    P.renderPanel(ref, snapOf([row('a', 'pending'), row('b', 'in_progress'), row('c', 'completed')]));
    expect(ref.rows[0]!.check.textContent).toBe('');
    expect(ref.rows[1]!.check.textContent).toBe('\u25b8');
    expect(ref.rows[2]!.check.textContent).toBe('\u2713');
    expect(ref.rows[2]!.root.className).toContain('is-completed');
  });

  it("空态与全完成态各有明确文案（不是同一句）", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    P.renderPanel(ref, snapOf([]));
    const empty = ref.note.textContent;
    expect(ref.root.dataset['state']).toBe('empty');
    expect(empty).not.toBe('');
    P.renderPanel(ref, snapOf([row('a', 'completed')]));
    const done = ref.note.textContent;
    expect(ref.root.dataset['state']).toBe('allDone');
    expect(done).not.toBe('');
    expect(done).not.toBe(empty);
  });

  it("折叠只切 class/属性，DOM 节点逐个保留（铁律 4）", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    P.renderPanel(ref, snapOf([row('a', 'pending'), row('b', 'completed')]));
    const nodes = ref.rows.map((r) => r.root);
    P.setCollapsed(ref, true);
    expect(ref.root.classList.contains('collapsed')).toBe(true);
    expect(ref.head.getAttribute('aria-expanded')).toBe('false');
    expect(ref.rows.map((r) => r.root)).toEqual(nodes);
    P.setCollapsed(ref, false);
    expect(ref.root.classList.contains('collapsed')).toBe(false);
    expect(ref.rows.map((r) => r.root)).toEqual(nodes);
    expect(ref.list.children).toHaveLength(2);
  });

  it("头部计数写成 data-*（真机断言用），并显示 done/total", async () => {
    const P = await loadPanel();
    const ref = P.buildPanel();
    P.renderPanel(ref, snapOf([row('a', 'completed'), row('b', 'pending'), row('c', 'pending')]));
    expect(ref.count.dataset['total']).toBe('3');
    expect(ref.count.dataset['completed']).toBe('1');
    expect(ref.count.textContent).toContain('1');
    expect(ref.count.textContent).toContain('3');
  });
});

describe("W1533 · store 每会话隔离与幂等", () => {
  it("按容器对象隔离：两个容器的清单互不影响", async () => {
    const S = await loadStore();
    S.resetTasks();
    const a = { id: 'x' };
    const b = { id: 'y' };
    S.setTasks(a, [row('a1', 'pending')]);
    S.setTasks(b, [row('b1', 'completed')]);
    expect(S.tasksOf(a)?.tasks).toEqual([row('a1', 'pending')]);
    expect(S.tasksOf(b)?.tasks).toEqual([row('b1', 'completed')]);
    S.resetTasks();
  });

  it("逐行相同的写入是 no-op：不通知订阅者（重放帧零重画）", async () => {
    const S = await loadStore();
    S.resetTasks();
    const pane = { id: 'z' };
    let calls = 0;
    const off = S.onTasksChange(() => { calls += 1; });
    S.setTasks(pane, [row('a', 'pending')]);
    expect(calls).toBe(1);
    expect(S.setTasks(pane, [row('a', 'pending')])).toBe('same');
    expect(calls).toBe(1);
    expect(S.setTasks(pane, [row('a', 'completed')])).toBe('inplace');
    expect(calls).toBe(2);
    off();
    S.resetTasks();
  });
});

