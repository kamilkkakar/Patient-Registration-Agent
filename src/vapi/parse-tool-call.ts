// Defensive reader for one inbound Vapi tool call.
//
// Mandated by docs/handoff/phase-1-vapi-contract.md § 2.1. THREE shapes are in
// current live Vapi docs and only one of them is in the OpenAPI schema:
//
//   [SPEC]/[SDK]  { id, type, function: { name, arguments: "<json string>" } }
//   docs/tools/custom-tools        { id, name, arguments: { ... } }
//   docs/server-url/events         { id, name, parameters: { ... } }
//
// Two consequences the contract calls out by name (G1, G2):
//   - `function.arguments` is a JSON *string*, not an object.
//   - there is NO top-level `toolCall.name`; routing on `tc.name` reads
//     `undefined` on every real call.
//
// This module never throws. A throw here would surface as an HTTP 500, and
// § G5 requires HTTP 200 from the tool endpoint for every outcome. Instead it
// returns a discriminated result, and — critically — still carries `id` and
// `name` on the failure branch whenever they could be read. A result whose
// `toolCallId` is missing or invented produces Vapi's "Tool call ID mismatch"
// (G6) and the model hangs mid-call.
//
// Delete the extra branches once a live call tells us which shape is real; the
// route logs the raw body at `debug` for exactly that reason.

/** Args are always an object by the time they leave this module. */
export type ToolCallArgs = Record<string, unknown>;

export type ParsedToolCall =
  | { ok: true; id: string; name: string; args: ToolCallArgs }
  | {
      ok: false;
      id: string | null;
      name: string | null;
      reason: 'unrecognized-shape' | 'malformed-arguments';
    };

/** Narrow `unknown` to something indexable without reaching for `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pull the tool-call list out of a `tool-calls` server message.
 *
 * `toolCallList` is the documented field. `toolWithToolCallList[].toolCall` is
 * the same data re-attached to the original tool definition and is the fallback
 * for a payload that somehow carries only that.
 */
export function extractToolCallList(message: unknown): unknown[] {
  const msg = asRecord(message);
  if (msg === null) return [];

  if (Array.isArray(msg['toolCallList'])) return msg['toolCallList'];

  // Not in the schema, but cheap insurance against a naming drift.
  if (Array.isArray(msg['toolCalls'])) return msg['toolCalls'];

  if (Array.isArray(msg['toolWithToolCallList'])) {
    return msg['toolWithToolCallList']
      .map((entry) => asRecord(entry)?.['toolCall'])
      .filter((entry) => entry !== undefined);
  }

  return [];
}

export function parseToolCall(input: unknown): ParsedToolCall {
  const tc = asRecord(input);
  if (tc === null) {
    return { ok: false, id: null, name: null, reason: 'unrecognized-shape' };
  }

  // `toolWithToolCallList` nests the real call one level down; tolerate being
  // handed either the outer or the inner object.
  const nested = asRecord(tc['toolCall']);
  const fn = asRecord(tc['function']) ?? asRecord(nested?.['function']);

  // Staged extraction: id and name FIRST, arguments second. If the arguments
  // fail to parse we still need both to build a well-addressed error result.
  const id = readString(tc['id']) ?? readString(nested?.['id']);
  const name =
    readString(fn?.['name']) ?? readString(tc['name']) ?? readString(nested?.['name']);

  if (id === null || name === null) {
    return { ok: false, id, name, reason: 'unrecognized-shape' };
  }

  const rawArgs =
    fn?.['arguments'] ?? // [SPEC]/[SDK]: JSON string
    fn?.['parameters'] ?? // docs/server-url/events, nested form
    tc['arguments'] ?? // docs/tools/custom-tools: object, hoisted
    tc['parameters'] ?? // docs/server-url/events: object, hoisted
    nested?.['arguments'] ??
    nested?.['parameters'];

  // A tool with no parameters legitimately sends nothing.
  if (rawArgs === undefined || rawArgs === null) {
    return { ok: true, id, name, args: {} };
  }

  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (trimmed.length === 0) return { ok: true, id, name, args: {} };

    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = asRecord(parsed);
      if (record === null) {
        return { ok: false, id, name, reason: 'malformed-arguments' };
      }
      return { ok: true, id, name, args: record };
    } catch {
      return { ok: false, id, name, reason: 'malformed-arguments' };
    }
  }

  const record = asRecord(rawArgs);
  if (record === null) {
    return { ok: false, id, name, reason: 'malformed-arguments' };
  }

  return { ok: true, id, name, args: record };
}
