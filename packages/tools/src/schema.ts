/**
 * Minimal JSON-Schema subset validator for the dispatch pipeline.
 *
 * Pipeline stage 1 (before guards and execution): the agent-supplied `args`
 * must satisfy the tool's own `spec().parameters`. The subset covers exactly
 * what the frozen tool contracts use — `type`, `properties`, `required`,
 * `additionalProperties`, `enum`, `minimum`, `items` — and is deliberately
 * hand-written: `core` and `tools` ship zero runtime dependencies, and a full
 * validator would be a new dependency for six schemas.
 *
 * A failure is a *result fact*, not an exception: the registry turns it into
 * `toolargs: code=schema msg="…"` in `ToolOutput.error` and never runs the tool.
 */

export interface ArgsValidationFailure {
  /** Human/agent-readable reason (single line). */
  message: string;
}

/** Validate `args` against `schema`; `null` means "valid". */
export function validateArgs(schema: unknown, args: unknown): ArgsValidationFailure | null {
  if (!isPlainObject(schema)) return null;
  return validateValue(schema, args, "");
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string): ArgsValidationFailure | null {
  const type = schema["type"];
  if (typeof type === "string" && !matchesType(type, value)) {
    return { message: `${label(path)} must be ${type} (got ${typeName(value)})` };
  }
  const enumFail = checkEnum(schema, value, path);
  if (enumFail !== null) return enumFail;
  const minimumFail = checkMinimum(schema, value, path);
  if (minimumFail !== null) return minimumFail;
  if (isPlainObject(value)) return validateObject(schema, value, path);
  if (Array.isArray(value)) return validateItems(schema, value, path);
  return null;
}

function checkEnum(schema: Record<string, unknown>, value: unknown, path: string): ArgsValidationFailure | null {
  const allowed = schema["enum"];
  if (!Array.isArray(allowed)) return null;
  if (allowed.some((candidate) => deepEqual(candidate, value))) return null;
  return { message: `${label(path)} must be one of [${allowed.map(show).join(", ")}]` };
}

function checkMinimum(schema: Record<string, unknown>, value: unknown, path: string): ArgsValidationFailure | null {
  const minimum = schema["minimum"];
  if (typeof minimum !== "number" || typeof value !== "number") return null;
  if (value >= minimum) return null;
  return { message: `${label(path)} must be >= ${minimum} (got ${value})` };
}

function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
): ArgsValidationFailure | null {
  const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in value)) {
      return { message: `missing required property '${key}'${at(path)}` };
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const fail = validateProperty(schema, properties, key, item, path);
    if (fail !== null) return fail;
  }
  return null;
}

function validateProperty(
  schema: Record<string, unknown>,
  properties: Record<string, unknown>,
  key: string,
  item: unknown,
  path: string,
): ArgsValidationFailure | null {
  const propertySchema = properties[key];
  const child = path === "" ? key : `${path}.${key}`;
  if (propertySchema !== undefined) {
    return validateValue(isPlainObject(propertySchema) ? propertySchema : {}, item, child);
  }
  const extra = schema["additionalProperties"];
  if (extra === false) return { message: `unexpected property '${key}' (additionalProperties: false)${at(path)}` };
  // `additionalProperties: {schema}` constrains every unnamed property (the
  // http_request `headers` map relies on it).
  if (isPlainObject(extra)) return validateValue(extra, item, child);
  return null;
}

function validateItems(
  schema: Record<string, unknown>,
  value: unknown[],
  path: string,
): ArgsValidationFailure | null {
  const items = schema["items"];
  if (!isPlainObject(items)) return null;
  for (const [index, item] of value.entries()) {
    const fail = validateValue(items, item, path === "" ? `[${index}]` : `${path}[${index}]`);
    if (fail !== null) return fail;
  }
  return null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function label(path: string): string {
  return path === "" ? "args" : `property '${path}'`;
}

function at(path: string): string {
  return path === "" ? "" : ` in '${path}'`;
}
