/**
 * `ask_user_question` — the model-facing half of the user-question seam (W783).
 *
 * The schema is copied from the official DSH implementation
 * (`dsh-tool-ask-user/lib/index.js`) so both hosts put the SAME request shape in
 * front of the model; `packages/tools` may only depend on `@celestea/core`
 * (L1), so the service arrives by CONSTRUCTION — exactly like
 * `runShellTool({sandbox, processes})` — and never from a Context.
 *
 * The description carries two things the schema cannot:
 *   - the `(Recommended)` convention, localised to 「（推荐）」 (§8);
 *   - the TIMEOUT semantics (§6.3). This repo gives the wait a maximum, and the
 *     system deliberately does NOT decide for the model when it expires: the
 *     result is an empty answer set, and the model is told to carry on with its
 *     own judgement instead of asking again.
 */

import type { AskUserQuestionItem, Tool, ToolSpec, UserQuestionService } from "@celestea/core";

import { descParam } from "../desc.js";
import { fnTool } from "../fn-tool.js";

/** What the tool needs: the seam, injected (never resolved from a Context). */
export interface AskUserToolOptions {
  /** The host's user-question service (`null` = the feature is not mounted). */
  questions: UserQuestionService | null;
}

/** The tool description (localised DSH wording + the §6.3 timeout semantics). */
export const ASK_USER_DESCRIPTION =
  "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. "
  + "Send one or more questions, each with a stable id that will be echoed in the answer. The call PAUSES until the "
  + "user answers, then returns `{answers:[{id,selected,custom}],timed_out:false}` as an ordinary tool result and you "
  + "continue. If you recommend one option, put it first and append \"（推荐）\" to that label. The user may always "
  + "type a free-text answer instead of choosing. Waiting is bounded (default 300000 ms, overridable with `timeout_ms`): "
  + "on expiry the call returns `{answers:[],timed_out:true}` and NO choice is made for you — do not ask the same "
  + "question again; state the assumption you are proceeding on (or stop and report) and continue with your own judgement.";

/** One question as the model supplies it (snake_case on the wire). */
interface QuestionArg {
  id?: unknown;
  question?: unknown;
  header?: unknown;
  detail?: unknown;
  options?: unknown;
  multi_select?: unknown;
  intent?: unknown;
}

/** The `questions` parameter schema (DSH, field for field). */
function questionsParam(): Record<string, unknown> {
  return {
    type: "array",
    description: "Questions to ask the user before continuing.",
    items: {
      type: "object",
      additionalProperties: true,
      properties: {
        id: { type: "string", description: "Stable id for this question; echoed in the answer." },
        question: { type: "string", description: "The specific question to ask the user." },
        header: { type: "string", description: "Optional short heading for the question, such as \"Confirm\" or \"Choose Mode\"." },
        detail: {
          type: "string",
          description:
            "Optional supporting detail shown with the question. Kept out of the option labels, so it never takes part in label matching.",
        },
        options: {
          type: "array",
          description: "Optional choices to show the user. If you recommend one, put it first and append \"（推荐）\" to that label.",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              label: { type: "string", description: "Short user-facing option label." },
              description: { type: "string", description: "One sentence explaining the tradeoff or impact." },
            },
            required: ["label"],
          },
        },
        multi_select: { type: "boolean", description: "Whether the user may select more than one option. Defaults to false." },
        intent: {
          type: "object",
          additionalProperties: false,
          description:
            "Optional presentation intent. It changes how a capable UI renders the question, never the answer encoding; a UI that does not know the tag shows the generic option list.",
          properties: {
            kind: { type: "string", enum: ["plan-review"], description: "A plan submitted for review." },
            approve: { type: "string", description: "The option label that approves the plan; every other option declines it." },
          },
          required: ["kind", "approve"],
        },
      },
      required: ["id", "question"],
    },
  };
}

/** The frozen spec of `ask_user_question`. */
export function askUserSpec(): ToolSpec {
  return {
    name: "ask_user_question",
    description: ASK_USER_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        questions: questionsParam(),
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description:
            "Optional maximum wait in milliseconds for the whole batch. Default 300000; capped at 3600000. On expiry the call returns an empty answer set with timed_out:true.",
        },
        desc: descParam(),
      },
      required: ["questions"],
      additionalProperties: false,
    },
  };
}

/**
 * The tool output. `timed_out` is always present: the model can tell "the user
 * chose nothing" from "the user was not there" without parsing prose (§6.3).
 */
interface AskUserOutput {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
  timed_out: boolean;
}

/** Copy one model-supplied question into the seam's shape (optional keys kept absent). */
function toQuestion(raw: QuestionArg): AskUserQuestionItem {
  const item: AskUserQuestionItem = { id: String(raw.id), question: String(raw.question) };
  if (raw.header !== undefined) item.header = String(raw.header);
  if (raw.detail !== undefined) item.detail = String(raw.detail);
  if (Array.isArray(raw.options)) item.options = raw.options as AskUserQuestionItem["options"];
  if (raw.multi_select !== undefined) item.multiSelect = raw.multi_select === true;
  if (raw.intent !== undefined) item.intent = raw.intent as AskUserQuestionItem["intent"];
  return item;
}

/** The model-supplied questions, in order. */
function questionsOf(args: unknown): AskUserQuestionItem[] {
  const list = (args as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => toQuestion(raw as QuestionArg));
}

/** `timeout_ms` when it is a positive integer, else undefined (the default). */
function timeoutOf(args: unknown): number | undefined {
  const value = (args as { timeout_ms?: unknown }).timeout_ms;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The `ask_user_question` tool. A host that did not mount the service gets a
 * structured failure instead of a silent no-op: the model must be able to tell
 * "nobody can answer here" from "the user answered nothing".
 */
export function askUserTool(options: AskUserToolOptions): Tool {
  const service = options.questions;
  return fnTool(askUserSpec(), async (args): Promise<AskUserOutput> => {
    if (service === null) {
      throw new Error("ask_user_question: code=no_provider msg=\"no user-questions service is mounted in this host\"");
    }
    const requested = timeoutOf(args);
    const outcome = await service.ask({
      questions: questionsOf(args),
      ...(requested === undefined ? {} : { timeoutMs: requested }),
    });
    return { answers: outcome.answers.map(copyAnswer), timed_out: outcome.timed_out };
  });
}

/** One answer item, with `custom` omitted rather than written as null. */
function copyAnswer(answer: { id: string; selected: string[]; custom?: string }): AskUserOutput["answers"][number] {
  const out: AskUserOutput["answers"][number] = { id: answer.id, selected: [...answer.selected] };
  if (answer.custom !== undefined) out.custom = answer.custom;
  return out;
}
