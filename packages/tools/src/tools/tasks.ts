/**
 * W1533 — `update_tasks`: the model's task list (a todo list the user watches).
 *
 * Why a tool and not a side channel: the list has to survive a page refresh, a
 * session switch and a process restart, and the ONE durable record of a turn is
 * the session log. A tool call puts the list in that log twice (the call's args
 * and the result's `tasks`) with no new endpoint, no new data file and no new
 * service — the panel reads it back from the log on restore and from the live
 * `tool_result` frame while the turn runs.
 *
 * Why REPLACE and not a patch: two updates arriving close together (a
 * sub-agent's step and the leader's) would each apply a delta to a list neither
 * of them owns, and the merged result is nobody's intent. A full list is
 * idempotent, order-explicit and trivially reconcilable in the UI.
 *
 * The tool writes nothing: its result IS the normalized list. Validation is
 * strict and fails closed with the one denial vocabulary
 * (`update_tasks: code=... msg="..."`), so a malformed item can never reach the
 * UI as a half-rendered row.
 */

import type { Tool, ToolSpec } from "@celestea/core";

import { descParam } from "../desc.js";
import { contractFailure } from "../errors.js";
import { fnTool } from "../fn-tool.js";

/** The three states a task can be in (frozen: the UI and the tool share them). */
export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** One task as the model supplies it and as the result echoes it back. */
export interface TaskItem {
  content: string;
  status: TaskStatus;
}

/** The counts the result reports (camelCase on the wire, per the W1533 brief). */
export interface TaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

/**
 * Upper bound on one list. Not a schema keyword — the frozen dispatch validator
 * is a deliberate subset (`schema.ts`) — so it lives here. 100 rows is far above
 * any real plan and still bounds the DOM the panel has to build.
 */
export const MAX_TASKS = 100;

/** Stable prefix of every structured `update_tasks` error. */
export const UPDATE_TASKS_ERROR_PREFIX = "update_tasks";

/** The model-facing behaviour description (mirrored by contracts/tools.json). */
export const UPDATE_TASKS_DESCRIPTION =
  "Publish the CURRENT task list for this session (a todo list the user watches). Send the COMPLETE list every time: "
  + "it REPLACES the previous one, so never send a diff or a single changed row. Each item is {content, status}, "
  + "where status is 'pending' (not started), 'in_progress' (being worked on now) or 'completed' (finished and "
  + "verified) — mark an item completed only when the work is actually done. Use it when a request needs several "
  + "steps: write the list first, keep at most ONE item in_progress, and re-send the whole list as you go. The "
  + "result echoes the normalized list and its counts as {ok, tasks, counts:{pending,inProgress,completed}}; an "
  + "empty tasks array clears the list. An item with a blank content or an unknown status fails with a structured "
  + "`update_tasks: code=... msg=\"...\"` error and changes nothing.";

/** The frozen spec of `update_tasks`. */
export function updateTasksSpec(): ToolSpec {
  return {
    name: "update_tasks",
    description: UPDATE_TASKS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description:
            "The COMPLETE task list, in display order. Replaces the previous list; an empty array clears it.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              content: {
                type: "string",
                description: "One-line description of the task, in the user's language.",
              },
              status: {
                type: "string",
                enum: [...TASK_STATUSES],
                description:
                  "pending = not started, in_progress = being worked on now, completed = finished and verified.",
              },
            },
            required: ["content", "status"],
          },
        },
        desc: descParam(),
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  };
}

/** One raw item: everything is `unknown` until it has been checked. */
interface RawTask {
  content?: unknown;
  status?: unknown;
}

/** True when `value` is one of the three frozen statuses. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** The trimmed content of one item, or a structured failure naming its index. */
function contentOf(raw: RawTask, index: number): string {
  if (typeof raw.content !== "string") {
    throw contractFailure(UPDATE_TASKS_ERROR_PREFIX, "invalid_content", "tasks[" + String(index) + "].content must be a string");
  }
  const text = raw.content.trim();
  if (text === "") {
    throw contractFailure(UPDATE_TASKS_ERROR_PREFIX, "invalid_content", "tasks[" + String(index) + "].content is blank");
  }
  return text;
}

/** The status of one item, or a structured failure naming its index. */
function statusOf(raw: RawTask, index: number): TaskStatus {
  if (!isTaskStatus(raw.status)) {
    throw contractFailure(
      UPDATE_TASKS_ERROR_PREFIX,
      "invalid_status",
      "tasks[" + String(index) + "].status must be one of " + TASK_STATUSES.join(" | ") + " (got " + JSON.stringify(raw.status) + ")",
    );
  }
  return raw.status;
}

/** Validate + normalize the model-supplied list (never returns a partial list). */
export function normalizeTasks(raw: unknown): TaskItem[] {
  if (!Array.isArray(raw)) {
    throw contractFailure(UPDATE_TASKS_ERROR_PREFIX, "invalid_tasks", "pass 'tasks' as an array of {content, status}");
  }
  if (raw.length > MAX_TASKS) {
    throw contractFailure(UPDATE_TASKS_ERROR_PREFIX, "too_many", "at most " + String(MAX_TASKS) + " tasks (got " + String(raw.length) + ")");
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw contractFailure(UPDATE_TASKS_ERROR_PREFIX, "invalid_item", "tasks[" + String(index) + "] must be an object");
    }
    const raw2 = item as RawTask;
    return { content: contentOf(raw2, index), status: statusOf(raw2, index) };
  });
}

/** How many tasks sit in each state (always all three keys, never absent). */
export function countTasks(tasks: readonly TaskItem[]): TaskCounts {
  const counts: TaskCounts = { pending: 0, inProgress: 0, completed: 0 };
  for (const task of tasks) {
    if (task.status === "pending") counts.pending += 1;
    else if (task.status === "in_progress") counts.inProgress += 1;
    else counts.completed += 1;
  }
  return counts;
}

/** The tool output: the normalized list plus its counts. */
export interface UpdateTasksOutput {
  ok: true;
  tasks: TaskItem[];
  counts: TaskCounts;
}

/** Publish one complete list (the only behaviour this tool has). */
export function runUpdateTasks(args: unknown): UpdateTasksOutput {
  const raw = (args as { tasks?: unknown } | null | undefined)?.tasks;
  const tasks = normalizeTasks(raw);
  return { ok: true, tasks, counts: countTasks(tasks) };
}

/** The `update_tasks` tool. */
export function updateTasksTool(): Tool {
  return fnTool(updateTasksSpec(), async (args) => runUpdateTasks(args));
}
