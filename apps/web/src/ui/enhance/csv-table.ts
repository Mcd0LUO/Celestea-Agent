// ============================================================================
// ui/enhance/csv-table.ts — CSV / TSV → 表格（W895-C2 · 可选组件）
// ----------------------------------------------------------------------------
// 触发（保守）：语言是 csv/tsv；或**没有语言**时只有「前两行都是制表符分隔且列数
//   相同」才认（逗号在散文里太常见，不猜）。解析失败/空文件/列数不足 2 ⇒ 原样保留。
// 渲染：<table>（首行作表头）；点表头升/降/无三态排序（数字列按数值，其它按字符串）；
//   行数多时表头 sticky（纯 CSS）。原文可获取性同 JSON 树：原 `pre` 移进
//   `<details class="csv-raw">原文</details>`，默认收起。
// 解析器是纯函数 [parseDelimited]：引号包裹字段、引号内换行、双引号转义、CRLF、
//   字段数不齐、空文件都有单测。
// ============================================================================
import { t } from "../../i18n";
import { languageOf } from "./code-extras";
import type { Enhancer } from "./registry";

/** 登记表 / 设置页 / 测试共用的身份。 */
export const CSV_TABLE_ID = "display.csvTable";

export interface CsvTable {
  header: string[];
  body: string[][];
}
export type SortDir = "asc" | "desc" | "none";

/** 一个「表格视图」遍（工厂：幂等，可反复调用）。 */
export function csvTableEnhancer(): Enhancer {
  return { id: CSV_TABLE_ID, enhance: applyCsvTable };
}

/** 保守判定分隔符：显式语言优先；无语言只认 TSV（制表符无歧义）。 */
export function detectDelimiter(text: string, lang: string): string | null {
  if (lang.includes("tsv")) return "\t";
  if (lang.includes("csv")) return ",";
  const lines = text.split(/\r?\n/);
  const first = lines[0] ?? "";
  const second = lines[1] ?? "";
  if (!first.includes("\t") || !second.includes("\t")) return null;
  const a = first.split("\t").length;
  return a >= 2 && a === second.split("\t").length ? "\t" : null;
}

/**
 * 纯函数：解析分隔文本（RFC4180 子集）。
 *   · 引号包裹的字段内的分隔符与换行按字面处理；`""` 表示一个引号；
 *   · CRLF / 孤立 CR 归一为 LF；行尾单个换行不额外产生空行；
 *   · 空文件 ⇒ []；字段数不齐原样返回（渲染时按表头列数对齐）。
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const src = text.replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > 1 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === "") rows.pop();
  return rows;
}

/** 行 → 表；空文件或表头不足 2 列返回 null。 */
export function buildTable(rows: readonly string[][]): CsvTable | null {
  if (rows.length === 0) return null;
  const header = rows[0]!;
  if (header.length < 2) return null;
  return { header: [...header], body: rows.slice(1).map((r) => [...r]) };
}

/** 该列是否整列可当数值（非空单元格都是有限数，且至少一个非空）。 */
export function isNumericColumn(rows: readonly string[][], col: number): boolean {
  let seen = false;
  for (const row of rows) {
    const v = (row[col] ?? "").trim();
    if (v === "") continue;
    if (!Number.isFinite(Number(v))) return false;
    seen = true;
  }
  return seen;
}

/** 按列排序（不改原数组）；numeric 用数值比较，否则按本地化字符串。 */
export function sortRows(rows: readonly string[][], col: number, dir: SortDir, numeric: boolean): string[][] {
  const copy = rows.map((r) => [...r]);
  if (dir === "none") return copy;
  copy.sort((a, b) => {
    const av = a[col] ?? "";
    const bv = b[col] ?? "";
    const cmp = numeric ? Number(av) - Number(bv) : av.localeCompare(bv);
    return dir === "asc" ? cmp : -cmp;
  });
  return copy;
}

function applyCsvTable(container: Element): void {
  for (const pre of Array.from(container.querySelectorAll<HTMLElement>("pre"))) {
    if (pre.dataset["structured"] === "1") continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const text = code.textContent ?? "";
    const delimiter = detectDelimiter(text, languageOf(code));
    if (delimiter === null) continue;
    const table = buildTable(parseDelimited(text, delimiter));
    if (table === null) continue;
    attachTable(pre, table);
  }
}

function attachTable(pre: HTMLElement, table: CsvTable): void {
  const raw: HTMLElement = pre.closest(".code-wrap") ?? pre;
  const holder = document.createElement("div");
  holder.className = "csv-block";
  holder.appendChild(buildTableBox(table));
  const details = document.createElement("details");
  details.className = "csv-raw";
  const summary = document.createElement("summary");
  summary.textContent = t("chat.structured.raw");
  details.appendChild(summary);
  (raw.parentNode ?? pre.parentNode)?.insertBefore(holder, raw);
  details.appendChild(raw);
  holder.appendChild(details);
  pre.dataset["structured"] = "1";
  holder.dataset["csvTable"] = "1";
}

/** 建表格 + 排序交互（无 innerHTML）。 */
export function buildTableBox(table: CsvTable): HTMLElement {
  const box = document.createElement("div");
  box.className = "csv-box";
  const el = document.createElement("table");
  el.className = "csv-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const tbody = document.createElement("tbody");
  const state: { col: number; dir: SortDir } = { col: -1, dir: "none" };
  const numeric = table.header.map((_, i) => isNumericColumn(table.body, i));
  const paint = (rows: readonly string[][]): void => {
    tbody.replaceChildren(...rows.map((r) => bodyRow(r, table.header.length)));
  };
  table.header.forEach((name, i) => {
    const th = document.createElement("th");
    th.className = "csv-th";
    th.textContent = name;
    th.tabIndex = 0;
    th.setAttribute("role", "button");
    const cycle = (): void => {
      state.dir = state.col !== i ? "asc" : state.dir === "asc" ? "desc" : state.dir === "desc" ? "none" : "asc";
      state.col = i;
      th.dataset["sort"] = state.dir;
      paint(state.dir === "none" ? table.body : sortRows(table.body, i, state.dir, numeric[i] === true));
    };
    th.addEventListener("click", cycle);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        cycle();
      }
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  el.appendChild(thead);
  el.appendChild(tbody);
  paint(table.body);
  box.appendChild(el);
  return box;
}

function bodyRow(row: readonly string[], width: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (let i = 0; i < width; i += 1) {
    const td = document.createElement("td");
    td.textContent = row[i] ?? "";
    tr.appendChild(td);
  }
  return tr;
}
