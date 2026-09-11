/**
 * Executable JSON Schema (draft 2020-12 subset) for the frozen contracts.
 *
 * W744 (audit D1): `contracts/session-event.schema.json` was only ever checked
 * as a *document* — the tests counted `oneOf` variants and never executed the
 * schema against an event. The schema and the hand-written codec in
 * `@celestea/core` could therefore drift apart with the whole gate green.
 *
 * This module turns that schema into a validator that runs against REAL event
 * streams (fixture JSONL + a live engine turn), and it refuses to stay silent
 * about what it does not understand: [unsupportedKeywords] lists every keyword
 * the contract uses that this executor would ignore, and the parity test fails
 * on a non-empty list. A contract construct can never degrade into a no-op
 * check without a red test.
 *
 * Implemented keywords: `$ref` (JSON pointer), `oneOf`/`anyOf`/`allOf`/`not`,
 * `type`, `required`, `properties`, `patternProperties`, `additionalProperties`,
 * `items`, `prefixItems`, `const`, `enum`, `pattern`, `minimum`/`maximum`,
 * `minLength`/`maxLength`, `minItems`/`maxItems`, `uniqueItems`,
 * `minProperties`/`maxProperties`.
 */

import { isRecord } from "@celestea/core";

/** One violation: a JSON path into the validated value plus what is wrong. */
export interface SchemaViolation {
  path: string;
  message: string;
}

const CONSTRAINTS = new Set([
  "$ref",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "type",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "prefixItems",
  "const",
  "enum",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

/** Keywords that never constrain a value (annotations / documentation). */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "$comment",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "$schema",
  "$id",
  "$anchor",
  "contentMediaType",
  "contentEncoding",
]);

/** Keys of the contract DOCUMENTS that carry prose, not JSON Schema semantics. */
const DOC_METADATA = new Set([
  "generatedAt",
  "source",
  "encoding",
  "turnId",
  "projections",
  "serialization",
  "serdeShape",
  "legacyDefault",
  "note",
  "notes",
  "codeRef",
]);

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_LISTS = ["oneOf", "anyOf", "allOf", "prefixItems"] as const;
const SCHEMA_VALUES = ["additionalProperties", "items", "not"] as const;
/** Keywords whose VALUES are subschemas (containers, never constraints of their own). */
const CONTAINERS = new Set<string>([...SCHEMA_MAPS, ...SCHEMA_LISTS, ...SCHEMA_VALUES]);

/** Every keyword the contract uses that [validateSchema] would silently skip. */
export function unsupportedKeywords(doc: unknown): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  walkSchema(doc, "#", out);
  return out;
}

function walkSchema(node: unknown, path: string, out: SchemaViolation[]): void {
  if (typeof node === "boolean") return;
  if (!isRecord(node)) {
    out.push({ path, message: `subschema must be an object or boolean, got ${typeName(node)}` });
    return;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINTS.has(key) || ANNOTATIONS.has(key) || DOC_METADATA.has(key) || CONTAINERS.has(key)) continue;
    out.push({
      path: `${path}/${key}`,
      message: `unsupported keyword '${key}': this executor would ignore it, so the contract could silently stop constraining the value (support it in tests/lib/json-schema.ts, or declare it as metadata)`,
    });
  }
  for (const key of SCHEMA_MAPS) {
    const map = node[key];
    if (!isRecord(map)) continue;
    for (const [name, sub] of Object.entries(map)) walkSchema(sub, `${path}/${key}/${name}`, out);
  }
  for (const key of SCHEMA_LISTS) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    list.forEach((sub, i) => walkSchema(sub, `${path}/${key}/${i}`, out));
  }
  for (const key of SCHEMA_VALUES) {
    if (node[key] !== undefined) walkSchema(node[key], `${path}/${key}`, out);
  }
}

/** Validate `value` against `schema`; an empty list means "valid". */
export function validateSchema(schema: unknown, value: unknown): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  validateNode(schema, value, "$", schema, out);
  return out;
}

/** `true` when the value satisfies the schema. */
export function schemaAccepts(schema: unknown, value: unknown): boolean {
  return validateSchema(schema, value).length === 0;
}

/** One-line rendering of violations (`$.id: missing required property 'id' | ...`). */
export function describeViolations(violations: readonly SchemaViolation[]): string {
  return violations.map((v) => `${v.path}: ${v.message}`).join(" | ");
}

function validateNode(node: unknown, value: unknown, path: string, root: unknown, out: SchemaViolation[]): void {
  if (node === true) return;
  if (node === false) {
    out.push({ path, message: "value is not allowed here (the schema is `false`)" });
    return;
  }
  if (!isRecord(node)) return;
  const ref = node["$ref"];
  if (typeof ref === "string") {
    const target = resolvePointer(root, ref);
    if (target === undefined) out.push({ path, message: `unresolvable $ref '${ref}'` });
    else validateNode(target, value, path, root, out);
  }
  validateCombinators(node, value, path, root, out);
  validateScalars(node, value, path, out);
  if (isRecord(value)) validateObject(node, value, path, root, out);
  if (Array.isArray(value)) validateArray(node, value, path, root, out);
}

function validateCombinators(node: Record<string, unknown>, value: unknown, path: string, root: unknown, out: SchemaViolation[]): void {
  const oneOf = node["oneOf"];
  if (Array.isArray(oneOf)) validateOneOf(oneOf, value, path, root, out);
  const anyOf = node["anyOf"];
  if (Array.isArray(anyOf) && !anyOf.some((sub) => branchErrors(sub, value, path, root).length === 0)) {
    out.push({ path, message: `matches none of the ${anyOf.length} anyOf branches` });
  }
  const allOf = node["allOf"];
  if (Array.isArray(allOf)) for (const sub of allOf) validateNode(sub, value, path, root, out);
  if (node["not"] !== undefined && branchErrors(node["not"], value, path, root).length === 0) {
    out.push({ path, message: "value matches the `not` schema (it must not)" });
  }
}

/**
 * Exactly-one-of, with a discriminator preference: when the value carries a
 * `type` and a branch pins `properties.type.const` to it, THAT branch's errors
 * are reported — the failure then names the real field instead of enumerating
 * every variant of the union.
 */
function validateOneOf(branches: readonly unknown[], value: unknown, path: string, root: unknown, out: SchemaViolation[]): void {
  const perBranch = branches.map((b) => branchErrors(b, value, path, root));
  const passing = perBranch.filter((e) => e.length === 0).length;
  if (passing === 1) return;
  if (passing > 1) {
    out.push({ path, message: `value satisfies ${passing} of ${branches.length} oneOf branches (the contract requires exactly one)` });
    return;
  }
  const best = bestBranch(branches, perBranch, value, root);
  const label = isRecord(value) && typeof value["type"] === "string" ? `'${value["type"]}'` : JSON.stringify(value);
  out.push({ path, message: `matches no branch of oneOf (value ${label})` });
  out.push(...(perBranch[best] ?? []));
}

/**
 * Which failing branch to report. Preference order: the branch whose
 * `properties.type.const` IS the value's discriminant (the schema composes its
 * variants through `$ref`, so refs are resolved first), then the branch whose
 * shape fits the value (object vs const), then the fewest violations — so the
 * message points at the field the author broke instead of at variant #0.
 */
function bestBranch(branches: readonly unknown[], perBranch: readonly SchemaViolation[][], value: unknown, root: unknown): number {
  const tag = isRecord(value) ? value["type"] : undefined;
  if (typeof tag === "string") {
    const hit = branches.findIndex((b) => pinnedType(resolveBranch(b, root)) === tag);
    if (hit >= 0) return hit;
  }
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < branches.length; i++) {
    const score = shapeScore(resolveBranch(branches[i], root), value);
    const errors = perBranch[i]?.length ?? 0;
    const bestErrors = perBranch[best]?.length ?? 0;
    if (score > bestScore || (score === bestScore && errors < bestErrors)) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** A `{"$ref": …}` branch stands for its target (the schemas compose that way). */
function resolveBranch(branch: unknown, root: unknown): unknown {
  if (!isRecord(branch)) return branch;
  const ref = branch["$ref"];
  if (typeof ref !== "string") return branch;
  return resolvePointer(root, ref) ?? branch;
}

/** How well a branch's declared shape fits the value being validated. */
function shapeScore(branch: unknown, value: unknown): number {
  if (!isRecord(branch)) return 0;
  const declared = branch["type"];
  let score = 0;
  if (typeof declared === "string" && declared === typeName(value)) score += 2;
  if (isRecord(value) && (isRecord(branch["properties"]) || Array.isArray(branch["required"]))) score += 1;
  if (typeof value === "string" && (branch["const"] !== undefined || Array.isArray(branch["enum"]))) score += 1;
  return score;
}

/** `properties.type.const` of a branch, when it pins the discriminant. */
function pinnedType(branch: unknown): string | undefined {
  if (!isRecord(branch)) return undefined;
  const props = branch["properties"];
  if (!isRecord(props)) return undefined;
  const t = props["type"];
  if (!isRecord(t)) return undefined;
  return typeof t["const"] === "string" ? t["const"] : undefined;
}

function branchErrors(node: unknown, value: unknown, path: string, root: unknown): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  validateNode(node, value, path, root, out);
  return out;
}

function validateScalars(node: Record<string, unknown>, value: unknown, path: string, out: SchemaViolation[]): void {
  const expected = node["type"];
  if (expected !== undefined && !typeMatches(expected, value)) {
    out.push({ path, message: `expected ${describeType(expected)}, got ${typeName(value)} (${sample(value)})` });
  }
  if (node["const"] !== undefined && JSON.stringify(node["const"]) !== JSON.stringify(value)) {
    out.push({ path, message: `must be ${JSON.stringify(node["const"])}, got ${JSON.stringify(value)}` });
  }
  const allowed = node["enum"];
  if (Array.isArray(allowed) && !allowed.some((a) => JSON.stringify(a) === JSON.stringify(value))) {
    out.push({ path, message: `must be one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}` });
  }
  if (typeof value === "string") validateString(node, value, path, out);
  if (typeof value === "number") validateNumber(node, value, path, out);
}

function validateString(node: Record<string, unknown>, value: string, path: string, out: SchemaViolation[]): void {
  const pattern = node["pattern"];
  if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
    out.push({ path, message: `'${value}' does not match the frozen pattern ${pattern}` });
  }
  const min = node["minLength"];
  if (typeof min === "number" && [...value].length < min) out.push({ path, message: `shorter than minLength ${min}` });
  const max = node["maxLength"];
  if (typeof max === "number" && [...value].length > max) out.push({ path, message: `longer than maxLength ${max}` });
}

function validateNumber(node: Record<string, unknown>, value: number, path: string, out: SchemaViolation[]): void {
  const bounds: Array<[string, (b: number) => boolean]> = [
    ["minimum", (b) => value >= b],
    ["maximum", (b) => value <= b],
    ["exclusiveMinimum", (b) => value > b],
    ["exclusiveMaximum", (b) => value < b],
  ];
  for (const [keyword, ok] of bounds) {
    const bound = node[keyword];
    if (typeof bound === "number" && !ok(bound)) out.push({ path, message: `${value} violates ${keyword} ${bound}` });
  }
}

function validateObject(node: Record<string, unknown>, value: Record<string, unknown>, path: string, root: unknown, out: SchemaViolation[]): void {
  const required = node["required"];
  if (Array.isArray(required)) {
    for (const name of required) {
      if (!(name in value)) out.push({ path: `${path}.${String(name)}`, message: `missing required property '${String(name)}' (the contract requires it)` });
    }
  }
  const props = node["properties"];
  if (isRecord(props)) {
    for (const [name, sub] of Object.entries(props)) {
      if (name in value) validateNode(sub, value[name], `${path}.${name}`, root, out);
    }
  }
  validateExtras(node, value, path, root, out);
  const min = node["minProperties"];
  if (typeof min === "number" && Object.keys(value).length < min) out.push({ path, message: `fewer than minProperties ${min}` });
  const max = node["maxProperties"];
  if (typeof max === "number" && Object.keys(value).length > max) out.push({ path, message: `more than maxProperties ${max}` });
}

function validateExtras(node: Record<string, unknown>, value: Record<string, unknown>, path: string, root: unknown, out: SchemaViolation[]): void {
  const declared = isRecord(node["properties"]) ? new Set(Object.keys(node["properties"])) : new Set<string>();
  const patterns = node["patternProperties"];
  const extra = node["additionalProperties"];
  for (const key of Object.keys(value)) {
    if (declared.has(key)) continue;
    const matching = isRecord(patterns) ? Object.entries(patterns).filter(([p]) => new RegExp(p).test(key)) : [];
    if (matching.length > 0) {
      for (const [, sub] of matching) validateNode(sub, value[key], `${path}.${key}`, root, out);
      continue;
    }
    if (extra === false) out.push({ path: `${path}.${key}`, message: `unknown property '${key}' (additionalProperties: false)` });
    else if (isRecord(extra) || extra === true) validateNode(extra, value[key], `${path}.${key}`, root, out);
  }
}

function validateArray(node: Record<string, unknown>, value: unknown[], path: string, root: unknown, out: SchemaViolation[]): void {
  const items = node["items"];
  if (items !== undefined) value.forEach((item, i) => validateNode(items, item, `${path}[${i}]`, root, out));
  const prefix = node["prefixItems"];
  if (Array.isArray(prefix)) {
    prefix.forEach((sub, i) => {
      if (i < value.length) validateNode(sub, value[i], `${path}[${i}]`, root, out);
    });
  }
  const min = node["minItems"];
  if (typeof min === "number" && value.length < min) out.push({ path, message: `fewer than minItems ${min}` });
  const max = node["maxItems"];
  if (typeof max === "number" && value.length > max) out.push({ path, message: `more than maxItems ${max}` });
  if (node["uniqueItems"] === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
    out.push({ path, message: "items are not unique (uniqueItems: true)" });
  }
}

/** Resolve a local JSON pointer (`#/$defs/SessionEvent/oneOf/0`). */
export function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  const raw = ref.slice(1);
  if (raw === "") return root;
  if (!raw.startsWith("/")) return undefined;
  let node: unknown = root;
  for (const segment of raw.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isRecord(node)) node = node[key];
    else return undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

function typeMatches(expected: unknown, value: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((e) => typeMatches(e, value));
  if (typeof expected !== "string") return true;
  switch (expected) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describeType(expected: unknown): string {
  return Array.isArray(expected) ? expected.map(String).join("|") : String(expected);
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function sample(v: unknown): string {
  const text = JSON.stringify(v);
  if (text === undefined) return "undefined";
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
