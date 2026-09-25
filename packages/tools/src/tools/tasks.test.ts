// @vitest-environment node
/**
 * W1533 — `update_tasks` unit tests.
 *
 * The tool is pure (no IO, no service), so everything here is a direct call:
 * the REPLACE semantics, the three-status vocabulary, the counts, and the
 * structured failures. Every assertion is paired with a MUTATION NEGATIVE
 * CONTROL (see the W1533 report) — this file pins the behaviour, not the prose.
 */
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../registry.js";
import {
  countTasks,
  isTaskStatus,
  MAX_TASKS,
  normalizeTasks,
  runUpdateTasks,
  TASK_STATUSES,
  updateTasksSpec,
  updateTasksTool,
} from "./tasks.js";

describe("W1533 update_tasks · spec", () => {
  it("declares the frozen name, the three statuses and the desc label", () => {
    const spec = updateTasksSpec();
    expect(spec.name).toBe("update_tasks");
    const params = spec.parameters as { properties: Record<string, any>; required: string[]; additionalProperties: boolean };
    expect(params.required).toEqual(["tasks"]);
    expect(params.additionalProperties).toBe(false);
    expect(Object.keys(params.properties)).toEqual(["tasks", "desc"]);
    expect(params.properties["tasks"].type).toBe("array");
    expect(params.properties["tasks"].items.properties["status"].enum).toEqual(["pending", "in_progress", "completed"]);
    expect(params.properties["tasks"].items.required).toEqual(["content", "status"]);
  });

  it("is a Tool whose spec() is the frozen spec", () => {
    const tool = updateTasksTool();
    expect(tool.spec().name).toBe("update_tasks");
    expect(tool.spec().parameters).toEqual(updateTasksSpec().parameters);
  });
});

describe("W1533 update_tasks · REPLACE semantics + counts", () => {
  it("echoes the list in order and counts all three buckets", () => {
    const out = runUpdateTasks({
      tasks: [
        { content: "读代码", status: "completed" },
        { content: "写工具", status: "in_progress" },
        { content: "跑验证", status: "pending" },
        { content: "写报告", status: "pending" },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.tasks.map((t) => t.content)).toEqual(["读代码", "写工具", "跑验证", "写报告"]);
    expect(out.counts).toEqual({ pending: 2, inProgress: 1, completed: 1 });
  });

  it("a second call REPLACES the first: the result is the new list, never a merge", () => {
    const first = runUpdateTasks({ tasks: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] });
    const second = runUpdateTasks({ tasks: [{ content: "a", status: "completed" }] });
    expect(first.tasks).toHaveLength(2);
    expect(second.tasks).toEqual([{ content: "a", status: "completed" }]);
    expect(second.counts).toEqual({ pending: 0, inProgress: 0, completed: 1 });
  });

  it("an empty array is a valid list (it clears the panel)", () => {
    const out = runUpdateTasks({ tasks: [] });
    expect(out.tasks).toEqual([]);
    expect(out.counts).toEqual({ pending: 0, inProgress: 0, completed: 0 });
  });

  it("trims surrounding whitespace but keeps the text otherwise intact", () => {
    const out = runUpdateTasks({ tasks: [{ content: "  spaced  ", status: "pending" }] });
    expect(out.tasks[0]?.content).toBe("spaced");
  });
});

describe("W1533 update_tasks · structured failures (never a partial list)", () => {
  const cases: Array<{ what: string; args: unknown; code: string }> = [
    { what: "tasks is not an array", args: { tasks: "nope" }, code: "invalid_tasks" },
    { what: "tasks is missing", args: {}, code: "invalid_tasks" },
    { what: "an item is not an object", args: { tasks: ["x"] }, code: "invalid_item" },
    { what: "content is missing", args: { tasks: [{ status: "pending" }] }, code: "invalid_content" },
    { what: "content is blank", args: { tasks: [{ content: "   ", status: "pending" }] }, code: "invalid_content" },
    { what: "status is unknown", args: { tasks: [{ content: "x", status: "done" }] }, code: "invalid_status" },
    { what: "status is missing", args: { tasks: [{ content: "x" }] }, code: "invalid_status" },
  ];
  it.each(cases)("$what -> update_tasks: code=$code", ({ args, code }) => {
    expect(() => runUpdateTasks(args)).toThrowError(new RegExp("update_tasks: code=" + code));
  });

  it("names the offending index so the model can fix exactly that row", () => {
    expect(() => runUpdateTasks({ tasks: [{ content: "ok", status: "pending" }, { content: "x", status: "nope" }] }))
      .toThrowError(/tasks\[1\]\.status/);
  });

  it("rejects a list above MAX_TASKS", () => {
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ content: "t" + String(i), status: "pending" }));
    expect(() => runUpdateTasks({ tasks: many })).toThrowError(/code=too_many/);
  });
});

describe("W1533 update_tasks · through the REAL registry pipeline", () => {
  it("dispatches by name and returns the structured value", async () => {
    const registry = createToolRegistry([updateTasksTool()]);
    const out = await registry.dispatch({ call_id: "c1", name: "update_tasks", args: { tasks: [{ content: "x", status: "completed" }] } });
    expect(out.error).toBeNull();
    expect(out.decision).toEqual({ kind: "allow" });
    expect(out.value).toEqual({ ok: true, tasks: [{ content: "x", status: "completed" }], counts: { pending: 0, inProgress: 0, completed: 1 } });
  });

  it("a schema violation is refused BEFORE execution (toolargs, not update_tasks)", async () => {
    const registry = createToolRegistry([updateTasksTool()]);
    const out = await registry.dispatch({ call_id: "c2", name: "update_tasks", args: { tasks: [{ content: "x", status: "done" }] } });
    expect(out.value).toBeNull();
    expect(out.error).toContain("toolargs: code=schema");
    expect(out.decision?.kind).toBe("deny");
  });

  it("the spec survives the registry round-trip (what GET /api/tools serves)", () => {
    const registry = createToolRegistry([updateTasksTool()]);
    expect(registry.schemas().map((s) => s.name)).toEqual(["update_tasks"]);
  });
});

describe("W1533 update_tasks · helpers", () => {
  it("isTaskStatus accepts exactly the three frozen statuses", () => {
    expect([...TASK_STATUSES]).toEqual(["pending", "in_progress", "completed"]);
    for (const s of TASK_STATUSES) expect(isTaskStatus(s)).toBe(true);
    for (const s of ["done", "PENDING", "", null, 3, undefined]) expect(isTaskStatus(s)).toBe(false);
  });

  it("countTasks sums every bucket and never omits a key", () => {
    expect(countTasks([])).toEqual({ pending: 0, inProgress: 0, completed: 0 });
    expect(countTasks([{ content: "a", status: "completed" }, { content: "b", status: "completed" }]))
      .toEqual({ pending: 0, inProgress: 0, completed: 2 });
  });

  it("normalizeTasks never returns a partial list (the failure is all-or-nothing)", () => {
    expect(() => normalizeTasks([{ content: "ok", status: "pending" }, { content: "x", status: "bad" }]))
      .toThrowError(/update_tasks/);
  });
});
