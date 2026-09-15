/**
 * W784 · 前端提问卡片的**纯函数**守护 —— 跨仓直测（先例：tests/model-icon.test.ts）。
 *
 * 前端仓没有测试栈，而本仓 `pnpm check` 已经跑 vitest，所以把这块不变量放在这里：
 * 倒计时口径、选项草稿（label 身份 / 单选多选）、作答请求体形状、以及**恢复终态**
 * 判定（「有问无答 = 不可再答」）。
 *
 * 为什么这些必须被机械断言：它们错了**不会报错**，只会静默给出错误 UI ——
 * 例如把「有问无答」判成已结算，用户就会永远看不到那条不可再答的提问；
 * 例如倒计时方向算反，卡片会在还有 5 分钟时就锁死。
 *
 * 只加载 ui/question/format.ts（纯函数，无 DOM、无 fetch）—— 卡片本体属于 DOM 层，
 * 本机无浏览器，不在本文件的射程内（见 W784 报告的「未验证」一节）。
 */
import { describe, expect, it } from "vitest";

type QuestionOption = { label: string; description?: string };
type QuestionItem = {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: QuestionOption[];
  multi_select?: boolean;
  intent?: { kind: string; approve?: string };
};
type QuestionAnswerItem = { id: string; selected: string[]; custom?: string };
type Pick = { selected: string[]; custom: string };
type HistoryMsg = {
  role: string;
  kind?: string;
  content?: unknown;
  question_id?: string;
  question_expires_at?: number;
  question_timed_out?: boolean;
};

interface FormatModule {
  countdownText(remainingMs: number | null): string;
  deadlineOf(src: { remaining_ms?: number; expires_at?: number }, now: number): number | null;
  isExpired(remainingMs: number | null): boolean;
  remainingMsOf(src: { remaining_ms?: number; expires_at?: number }, now: number): number | null;
  normalizeQuestion(raw: unknown): QuestionItem | null;
  normalizeQuestions(raw: unknown): QuestionItem[];
  normalizeAnswerItems(raw: unknown): QuestionAnswerItem[];
  questionInfoOf(raw: unknown): {
    id: string;
    questions?: QuestionItem[];
    expires_at?: number;
    timeout_ms?: number;
    remaining_ms?: number;
  } | null;
  pickOf(picks: Record<string, Pick>, id: string): Pick;
  togglePick(pick: Pick, label: string, multiSelect: boolean): Pick;
  withCustom(pick: Pick, custom: string): Pick;
  unansweredIds(questions: readonly QuestionItem[], picks: Record<string, Pick>): string[];
  answerItemsOf(
    questions: readonly QuestionItem[],
    picks: Record<string, Pick>,
  ): QuestionAnswerItem[];
  summarizeAnswer(items: readonly QuestionAnswerItem[]): string;
  isSettledFailure(status: number): boolean;
  historyQuestionsOf(messages: readonly HistoryMsg[]): Array<{
    id: string;
    questions: QuestionItem[];
    settled: boolean;
    timedOut: boolean;
    answerText: string;
    expiresAt?: number;
  }>;
}

const MODULE_URL = new URL("../apps/web/src/ui/question/format.ts", import.meta.url).href;
const F = (await import(/* @vite-ignore */ MODULE_URL)) as FormatModule;

const OPTIONS: QuestionOption[] = [
  { label: "方案 A（推荐）", description: "更快" },
  { label: "方案 B", description: "更稳" },
];

function q1(extra: Partial<QuestionItem> = {}): QuestionItem {
  return { id: "mode", question: "选哪个方案？", header: "确认", options: OPTIONS, ...extra };
}

/** 一条提问行的线格式（与 packages/session 的 Studio 投影一致）。 */
function askedRow(id: string, questions: unknown[]): HistoryMsg {
  return { role: "question", kind: "question", question_id: id, content: questions };
}
function answerRow(id: string, answers: unknown[], timedOut?: boolean): HistoryMsg {
  const row: HistoryMsg = { role: "question", kind: "answer", question_id: id, content: answers };
  if (timedOut !== undefined) row.question_timed_out = timedOut;
  return row;
}

describe("W784 倒计时口径", () => {
  it("null（该提问没带时限）不显示倒计时，而不是显示 0", () => {
    expect(F.countdownText(null)).toBe("");
  });

  it("到点/超时为「已到时限」，绝不出现负数", () => {
    expect(F.countdownText(0)).toBe("已到时限");
    expect(F.countdownText(-5000)).toBe("已到时限");
  });

  it("分级文案：秒 / 分:秒 / 时+分", () => {
    expect(F.countdownText(59_000)).toBe("剩 59 秒");
    expect(F.countdownText(60_000)).toBe("剩 1:00");
    expect(F.countdownText(296_993)).toBe("剩 4:56");
    expect(F.countdownText(3_661_000)).toBe("剩 1 小时 1 分");
  });

  it("剩余量优先取服务端读时值（前端不拿自己的钟做判断）", () => {
    const now = 1_000_000;
    // expires_at 看起来早已过期，但服务端说还剩 5 秒 → 以服务端为准
    expect(F.remainingMsOf({ expires_at: now - 60_000, remaining_ms: 5_000 }, now)).toBe(5_000);
    expect(F.remainingMsOf({ expires_at: now + 5_000 }, now)).toBe(5_000);
    expect(F.remainingMsOf({}, now)).toBeNull();
  });

  it("本地倒计时终点 = 现在 + 服务端剩余量（钟差不会整体平移倒计时）", () => {
    const now = 1_000_000;
    expect(F.deadlineOf({ remaining_ms: 60_000 }, now)).toBe(now + 60_000);
    expect(F.deadlineOf({ expires_at: now + 60_000 }, now)).toBe(now + 60_000);
    expect(F.deadlineOf({}, now)).toBeNull();
  });

  it("isExpired：无时限永远不算到点", () => {
    expect(F.isExpired(null)).toBe(false);
    expect(F.isExpired(1)).toBe(false);
    expect(F.isExpired(0)).toBe(true);
  });
});

describe("W784 线格式归一化", () => {
  it("id/question 缺失或非字符串 → 丢弃（不猜、不补占位）", () => {
    expect(F.normalizeQuestion(null)).toBeNull();
    expect(F.normalizeQuestion({ question: "有题干没 id" })).toBeNull();
    expect(F.normalizeQuestion({ id: "a" })).toBeNull();
    expect(F.normalizeQuestion({ id: "", question: "空 id" })).toBeNull();
  });

  it("保留可选字段；坏选项被丢掉而不是让整题消失", () => {
    const q = F.normalizeQuestion({
      id: "q1",
      question: "选一个",
      detail: "细节",
      multi_select: true,
      intent: { kind: "plan-review", approve: "批准" },
      options: [{ label: "批准" }, { label: 42 }, null, { noLabel: true }],
    });
    expect(q?.detail).toBe("细节");
    expect(q?.multi_select).toBe(true);
    expect(q?.intent?.approve).toBe("批准");
    expect(q?.options).toEqual([{ label: "批准" }]);
  });

  it("intent 缺 kind 视为没有 intent（不发明类型）", () => {
    const q = F.normalizeQuestion({ id: "a", question: "b", intent: { approve: "批准" } });
    expect(q?.intent).toBeUndefined();
  });

  it("SSE 载荷：无 id / 无问题集 → 不成卡", () => {
    expect(F.questionInfoOf({ questions: [q1()] })).toBeNull();
    expect(F.questionInfoOf({ id: "q-1", questions: [] })).toBeNull();
    expect(F.questionInfoOf({ id: "q-1", questions: [{ question: "缺 id" }] })).toBeNull();
  });

  it("SSE 载荷：问题集 + 时序字段原样带出", () => {
    const info = F.questionInfoOf({
      id: "q-1",
      session: "ws/s1",
      questions: [q1()],
      expires_at: 111,
      timeout_ms: 222,
    });
    expect(info?.id).toBe("q-1");
    expect(info?.questions?.length).toBe(1);
    expect(info?.expires_at).toBe(111);
    expect(info?.timeout_ms).toBe(222);
  });
});

describe("W784 作答草稿与请求体", () => {
  it("单选替换、多选增删（label 是身份，顺序无关）", () => {
    let pick: Pick = { selected: [], custom: "" };
    pick = F.togglePick(pick, "方案 A（推荐）", false);
    expect(pick.selected).toEqual(["方案 A（推荐）"]);
    pick = F.togglePick(pick, "方案 B", false);
    expect(pick.selected).toEqual(["方案 B"]);

    let multi: Pick = { selected: [], custom: "" };
    multi = F.togglePick(multi, "甲", true);
    multi = F.togglePick(multi, "乙", true);
    expect(multi.selected).toEqual(["甲", "乙"]);
    multi = F.togglePick(multi, "甲", true);
    expect(multi.selected).toEqual(["乙"]);
  });

  it("togglePick / withCustom 不改原草稿（纯函数）", () => {
    const pick: Pick = { selected: ["甲"], custom: "旧" };
    F.togglePick(pick, "乙", true);
    F.withCustom(pick, "新");
    expect(pick).toEqual({ selected: ["甲"], custom: "旧" });
  });

  it("未答完的判定是「每题都要有选项或非空自由文本」", () => {
    const questions = [q1(), { id: "other", question: "还有呢？" }];
    expect(F.unansweredIds(questions, {})).toEqual(["mode", "other"]);
    expect(F.unansweredIds(questions, { mode: { selected: ["方案 B"], custom: "" } })).toEqual([
      "other",
    ]);
    expect(
      F.unansweredIds(questions, {
        mode: { selected: [], custom: "  " }, // 只有空白不算作答
        other: { selected: [], custom: "随便" },
      }),
    ).toEqual(["mode"]);
  });

  it("请求体：selected 是 label 数组；custom 空串不带；未作答的题不出现在 answers 里", () => {
    const questions = [q1(), { id: "other", question: "还有呢？" }];
    const items = F.answerItemsOf(questions, {
      mode: { selected: ["方案 B"], custom: "  先按 B 做  " },
      other: { selected: [], custom: "" },
    });
    expect(items).toEqual([{ id: "mode", selected: ["方案 B"], custom: "先按 B 做" }]);
    // label 而不是索引：索引形态（"1"）绝不能出现在请求体里
    expect(JSON.stringify(items)).not.toContain('"selected":["1"]');
  });

  it("作答摘要：选项与自由文本都回显", () => {
    expect(
      F.summarizeAnswer([
        { id: "mode", selected: ["方案 B"] },
        { id: "note", selected: [], custom: "补充一句" },
      ]),
    ).toBe("方案 B；「补充一句」");
    expect(F.summarizeAnswer([])).toBe("");
  });

  it("作答失败：404/409 是终态（再点也不会成功），其余可重试", () => {
    expect(F.isSettledFailure(404)).toBe(true);
    expect(F.isSettledFailure(409)).toBe(true);
    expect(F.isSettledFailure(0)).toBe(false);
    expect(F.isSettledFailure(422)).toBe(false);
    expect(F.isSettledFailure(500)).toBe(false);
  });
});

describe("W784 历史恢复终态（设计 §7.2 规则 4）", () => {
  it("有问有答 → 已结算并回显作答摘要", () => {
    const rows = F.historyQuestionsOf([
      askedRow("q-1", [q1()]),
      answerRow("q-1", [{ id: "mode", selected: ["方案 B"], custom: "先按 B 做" }]),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.settled).toBe(true);
    expect(rows[0]?.timedOut).toBe(false);
    expect(rows[0]?.answerText).toBe("方案 B、「先按 B 做」");
  });

  it("有问无答 → **未结算**（会话中断：该提问不可再答，必须渲染成终态）", () => {
    const rows = F.historyQuestionsOf([askedRow("q-1", [q1()])]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.settled).toBe(false);
    expect(rows[0]?.timedOut).toBe(false);
    expect(rows[0]?.answerText).toBe("");
  });

  it("超时结算 → settled 且 timedOut（系统没替模型选任何选项）", () => {
    const rows = F.historyQuestionsOf([
      askedRow("q-1", [q1()]),
      answerRow("q-1", [], true),
    ]);
    expect(rows[0]?.settled).toBe(true);
    expect(rows[0]?.timedOut).toBe(true);
    expect(rows[0]?.answerText).toBe("");
  });

  it("两轮提问按行序配对，互不串答", () => {
    const rows = F.historyQuestionsOf([
      askedRow("q-1", [q1()]),
      answerRow("q-1", [{ id: "mode", selected: ["方案 A（推荐）"] }]),
      askedRow("q-2", [q1({ id: "mode", question: "再来一次？" })]),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["q-1", "q-2"]);
    expect(rows[0]?.settled).toBe(true);
    expect(rows[1]?.settled).toBe(false);
  });

  it("提问行保留时限（卡片可显示倒计时）；孤立回答行被忽略", () => {
    const rows = F.historyQuestionsOf([
      { role: "question", kind: "question", question_id: "q-9", content: [q1()], question_expires_at: 12345 },
      answerRow("q-unknown", [{ id: "mode", selected: ["方案 B"] }]),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("q-9");
    expect(rows[0]?.expiresAt).toBe(12345);
  });

  it("问题集为空/损坏的提问行不成卡（旧行或损坏行不产生空卡片）", () => {
    expect(F.historyQuestionsOf([askedRow("q-1", [])])).toEqual([]);
    expect(F.historyQuestionsOf([askedRow("q-1", [{ question: "缺 id" }])])).toEqual([]);
    expect(F.historyQuestionsOf([{ role: "user", content: "普通消息" }])).toEqual([]);
  });

  it("答案项归一化：selected 必须是字符串数组，custom 空串不带", () => {
    expect(
      F.normalizeAnswerItems([
        { id: "a", selected: ["甲", 7], custom: "" },
        { id: "b" },
        null,
      ]),
    ).toEqual([{ id: "a", selected: ["甲"] }]);
  });
});

/**
 * W784 · 真实帧回放 —— 下面三段 JSON 是**逐字抄自** W783 的实机验证原文
 * （`results/W783-提问功能后端.md` §3：临时数据根 + 本机 mock 上游的真实 studio
 * 进程，真引擎 / 真工具注册表 / 真 session 日志 / 真 HTTP）。
 *
 * 为什么要抄真帧而不是自己编：编出来的样例只能证明「我的解析器同意我自己」，
 * 而这里钉的是**线上真实字节**——SSE 载荷、未决列表条目、作答请求体三者的形状。
 * 后端契约若在本仓发生漂移，这一组会先红。
 */
describe("W784 真实帧回放（W783 实机原文）", () => {
  /** live：SSE `question` 帧的 payload（W783 §3 ④ 原文）。 */
  const SSE_FRAME = {
    session: "ws/s1",
    id: "q-1",
    expires_at: 1789447890956,
    timeout_ms: 300000,
    questions: [
      {
        id: "mode",
        question: "选哪个方案？",
        header: "确认",
        detail: "两个方案都能用，A 更快。",
        options: [
          { label: "方案 A（推荐）", description: "更快" },
          { label: "方案 B", description: "更稳" },
        ],
      },
    ],
  };

  /** 恢复：`GET /api/questions` 的条目（W783 §3 ② 原文，含读时判定的剩余量）。 */
  const LIST_ITEM = {
    id: "q-1",
    session: "ws/s1",
    questions: SSE_FRAME.questions,
    expires_at: 1789447890956,
    timeout_ms: 300000,
    remaining_ms: 296993,
    expired: false,
  };

  it("SSE 帧 → 卡片信息：题干/说明/选项(含描述) 全部就位", () => {
    const info = F.questionInfoOf(SSE_FRAME);
    expect(info?.id).toBe("q-1");
    expect(info?.expires_at).toBe(1789447890956);
    expect(info?.timeout_ms).toBe(300000);
    const q = info?.questions?.[0];
    expect(q?.header).toBe("确认");
    expect(q?.detail).toBe("两个方案都能用，A 更快。");
    expect(q?.options).toEqual([
      { label: "方案 A（推荐）", description: "更快" },
      { label: "方案 B", description: "更稳" },
    ]);
    // 推荐项只靠文案约定「（推荐）」，前端不得据位置推断任何语义（§3.2 约定 1/2）
    expect(q?.options?.[0]?.label).toContain("（推荐）");
    expect(q?.intent).toBeUndefined();
  });

  it("未决列表条目 → 用服务端读时剩余量定倒计时（本地钟不参与判定）", () => {
    const info = F.questionInfoOf(LIST_ITEM);
    const now = 1_700_000_000_000; // 与 expires_at 相差甚远：故意用一个「离谱」的本地钟
    expect(F.remainingMsOf(LIST_ITEM, now)).toBe(296993);
    expect(F.deadlineOf(LIST_ITEM, now)).toBe(now + 296993);
    expect(F.countdownText(296993)).toBe("剩 4:56");
    expect(F.isExpired(F.remainingMsOf(LIST_ITEM, now))).toBe(false);
    // 而若只看 expires_at - now（本地钟不可信的路径），会得到完全不同的结论 —— 这正是
    // 恢复路径必须优先用 remaining_ms 的原因。
    expect(F.remainingMsOf({ expires_at: LIST_ITEM.expires_at }, now)).not.toBe(296993);
  });

  it("作答请求体：label 数组 + 自由文本，与 W783 实机提交逐字一致", () => {
    const items = F.answerItemsOf(F.normalizeQuestions(SSE_FRAME.questions), {
      mode: { selected: ["方案 B"], custom: "补充一句：先按 B 做" },
    });
    // W783 §3 ③ 实机提交的 body：{"answers":[{"id":"mode","selected":["方案 B"],"custom":"补充一句：先按 B 做"}]}
    expect(JSON.stringify({ answers: items })).toBe(
      JSON.stringify({
        answers: [{ id: "mode", selected: ["方案 B"], custom: "补充一句：先按 B 做" }],
      }),
    );
  });

  it("会话日志两行（W783 §3 ⑤ 原文）→ 有问有答判为已结算", () => {
    const rows = F.historyQuestionsOf([
      {
        role: "question",
        kind: "question",
        question_id: "q-1",
        content: SSE_FRAME.questions,
        question_expires_at: 1789447890956,
      },
      {
        role: "question",
        kind: "answer",
        question_id: "q-1",
        content: [{ custom: "补充一句：先按 B 做", id: "mode", selected: ["方案 B"] }],
        question_timed_out: false,
      },
    ]);
    expect(rows[0]?.settled).toBe(true);
    expect(rows[0]?.answerText).toBe("方案 B、「补充一句：先按 B 做」");
  });

  it("超时链（W783 §4 原文）→ 有问无答 + 空答案集判为已结算且 timedOut", () => {
    const rows = F.historyQuestionsOf([
      { role: "question", kind: "question", question_id: "q-1", content: SSE_FRAME.questions },
      { role: "question", kind: "answer", question_id: "q-1", content: [], question_timed_out: true },
    ]);
    expect(rows[0]?.settled).toBe(true);
    expect(rows[0]?.timedOut).toBe(true);
  });
});
