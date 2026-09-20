// @vitest-environment jsdom
/**
 * W895-C2 — CSV / TSV → 表格。
 *
 * 解析器纯函数覆盖：引号包裹字段、引号内换行、双引号转义、CRLF、字段数不齐、
 * 空文件、行尾换行；判定保守（无语言只认 TSV）；排序三态与数字/字符串列；DOM 行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CsvMod {
  detectDelimiter(text: string, lang: string): string | null;
  parseDelimited(text: string, delimiter: string): string[][];
  buildTable(rows: readonly string[][]): { header: string[]; body: string[][] } | null;
  isNumericColumn(rows: readonly string[][], col: number): boolean;
  sortRows(rows: readonly string[][], col: number, dir: "asc" | "desc" | "none", numeric: boolean): string[][];
  csvTableEnhancer(): { id: string; enhance(c: Element): void };
  CSV_TABLE_ID: string;
}

async function mod(): Promise<CsvMod> {
  return (await import(/* @vite-ignore */ "./csv-table")) as CsvMod;
}

function preWithCode(cls: string, text: string): { pre: HTMLElement; code: HTMLElement } {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = cls;
  code.textContent = text;
  pre.appendChild(code);
  document.body.appendChild(pre);
  return { pre, code };
}

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("W895-C2 parseDelimited（纯函数）", () => {
  it("普通行 / 列", async () => {
    const { parseDelimited } = await mod();
    expect(parseDelimited("a,b\n1,2", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("引号包裹字段：字段内的分隔符按字面", async () => {
    const { parseDelimited } = await mod();
    expect(parseDelimited('"a,b",c', ",")).toEqual([["a,b", "c"]]);
  });

  it("引号内换行：不切行", async () => {
    const { parseDelimited } = await mod();
    expect(parseDelimited('"a\nb",c', ",")).toEqual([["a\nb", "c"]]);
  });

  it("双引号转义", async () => {
    const { parseDelimited } = await mod();
    expect(parseDelimited('"a""b",c', ",")).toEqual([['a"b', "c"]]);
  });

  it("CRLF / 行尾换行 / 空文件 / 字段数不齐", async () => {
    const { parseDelimited } = await mod();
    expect(parseDelimited("a,b\r\n1,2", ",")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseDelimited("a,b\n", ",")).toEqual([["a", "b"]]);
    expect(parseDelimited("", ",")).toEqual([]);
    expect(parseDelimited("a,b\n1", ",")).toEqual([["a", "b"], ["1"]]);
  });
});

describe("W895-C2 判定与排序（纯函数）", () => {
  it("detectDelimiter：显式语言优先；无语言只认 TSV", async () => {
    const { detectDelimiter } = await mod();
    expect(detectDelimiter("a,b", "csv")).toBe(",");
    expect(detectDelimiter("a\tb", "tsv")).toBe("\t");
    expect(detectDelimiter("a\tb\n1\t2", "")).toBe("\t");
    expect(detectDelimiter("a,b\n1,2", "")).toBeNull();
    expect(detectDelimiter("a\tb\nc", "")).toBeNull();
  });

  it("buildTable：空文件或表头不足 2 列 → null", async () => {
    const { buildTable } = await mod();
    expect(buildTable([])).toBeNull();
    expect(buildTable([["only"]])).toBeNull();
    expect(buildTable([["a", "b"], ["1", "2"]])).toEqual({ header: ["a", "b"], body: [["1", "2"]] });
  });

  it("isNumericColumn / sortRows 三态", async () => {
    const { isNumericColumn, sortRows } = await mod();
    const rows = [["10"], ["2"], ["x"]];
    expect(isNumericColumn([["10"], ["2"]], 0)).toBe(true);
    expect(isNumericColumn(rows, 0)).toBe(false);
    expect(isNumericColumn([[""], [""]], 0)).toBe(false);
    expect(sortRows([["10"], ["2"]], 0, "asc", true)).toEqual([["2"], ["10"]]);
    expect(sortRows([["10"], ["2"]], 0, "desc", true)).toEqual([["10"], ["2"]]);
    expect(sortRows([["b"], ["a"]], 0, "asc", false)).toEqual([["a"], ["b"]]);
    expect(sortRows([["b"], ["a"]], 0, "none", false)).toEqual([["b"], ["a"]]);
  });
});

describe("W895-C2 csvTableEnhancer（DOM）", () => {
  it("CSV：出表、首行作表头、点表头三态排序、原文保留", async () => {
    const { csvTableEnhancer } = await mod();
    const { pre } = preWithCode("language-csv", "name,n\nb,2\na,10");
    const container = document.createElement("div");
    container.appendChild(pre);
    csvTableEnhancer().enhance(container);
    expect(pre.dataset["structured"]).toBe("1");
    const table = container.querySelector(".csv-table");
    expect(table).not.toBeNull();
    expect(Array.from(table!.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["name", "n"]);
    const cells = (): string[] => Array.from(table!.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent ?? "");
    expect(cells()).toEqual(["b", "a"]);
    const th = table!.querySelector<HTMLTableCellElement>(".csv-th")!;
    th.click();
    expect(cells()).toEqual(["a", "b"]);
    th.click();
    expect(cells()).toEqual(["b", "a"]);
    th.click();
    expect(cells()).toEqual(["b", "a"]);
    expect(container.querySelector(".csv-raw pre")).toBe(pre);
  });

  it("解析不成立 / 无语言的逗号散文：原样保留", async () => {
    const { csvTableEnhancer } = await mod();
    const prose = preWithCode("", "hello, world");
    const broken = preWithCode("language-csv", "just one field");
    const container = document.createElement("div");
    container.append(prose.pre, broken.pre);
    csvTableEnhancer().enhance(container);
    expect(container.querySelector(".csv-table")).toBeNull();
    expect(prose.pre.dataset["structured"]).toBeUndefined();
    expect(broken.pre.dataset["structured"]).toBeUndefined();
  });

  it("幂等：重复增强不重复插表", async () => {
    const { csvTableEnhancer } = await mod();
    const { pre } = preWithCode("language-csv", "a,b\n1,2");
    const container = document.createElement("div");
    container.appendChild(pre);
    const enh = csvTableEnhancer();
    enh.enhance(container);
    enh.enhance(container);
    expect(container.querySelectorAll(".csv-table")).toHaveLength(1);
    expect(container.querySelectorAll(".csv-block")).toHaveLength(1);
  });
});
