// The defensive reader. Three shapes are published in live Vapi docs and only
// one is in the OpenAPI schema (phase-1 contract § 2.1 / G1 / G2), so all three
// have to survive — and none of them may throw.

import { describe, expect, it } from 'vitest';
import { extractToolCallList, parseToolCall } from '../../src/vapi/parse-tool-call.js';

const ARGS = { phone_number: 'nine oh two, five five five, oh one four seven' };

describe('parseToolCall — the three published shapes', () => {
  it('[SPEC]/[SDK]: function.name + function.arguments as a JSON STRING', () => {
    const parsed = parseToolCall({
      id: 'call_9y2VkX1rQpLmA7bN',
      type: 'function',
      function: { name: 'lookup_patient_by_phone', arguments: JSON.stringify(ARGS) },
    });

    expect(parsed).toEqual({
      ok: true,
      id: 'call_9y2VkX1rQpLmA7bN',
      name: 'lookup_patient_by_phone',
      args: ARGS,
    });
  });

  it('docs/tools/custom-tools: top-level name + arguments as an OBJECT', () => {
    const parsed = parseToolCall({
      id: 'toolu_01DTPAzUm5Gk3zxrpJ969oMF',
      name: 'lookup_patient_by_phone',
      arguments: ARGS,
    });

    expect(parsed).toEqual({
      ok: true,
      id: 'toolu_01DTPAzUm5Gk3zxrpJ969oMF',
      name: 'lookup_patient_by_phone',
      args: ARGS,
    });
  });

  it('docs/server-url/events: top-level name + PARAMETERS as an object', () => {
    const parsed = parseToolCall({
      id: 'abc123',
      name: 'lookup_patient_by_phone',
      parameters: ARGS,
    });

    expect(parsed).toEqual({ ok: true, id: 'abc123', name: 'lookup_patient_by_phone', args: ARGS });
  });

  it('reads a call nested under toolCall (the toolWithToolCallList form)', () => {
    const parsed = parseToolCall({
      toolCall: {
        id: 'abc123',
        type: 'function',
        function: { name: 'create_patient', parameters: { first_name: 'Sarah' } },
      },
    });

    expect(parsed).toEqual({
      ok: true,
      id: 'abc123',
      name: 'create_patient',
      args: { first_name: 'Sarah' },
    });
  });
});

describe('parseToolCall — failure branches never throw', () => {
  it('malformed JSON in `arguments` still carries id and name back', () => {
    const parsed = parseToolCall({
      id: 'call_bad',
      type: 'function',
      function: { name: 'create_patient', arguments: '{"first_name": "Sarah"' },
    });

    // Losing the id here would produce Vapi's "Tool call ID mismatch" (G6) and
    // the model would hang mid-call.
    expect(parsed).toEqual({
      ok: false,
      id: 'call_bad',
      name: 'create_patient',
      reason: 'malformed-arguments',
    });
  });

  it('JSON that parses to a non-object is malformed too', () => {
    const parsed = parseToolCall({
      id: 'call_bad',
      function: { name: 'create_patient', arguments: '"just a string"' },
    });

    expect(parsed.ok).toBe(false);
  });

  it('a missing name is an unrecognized shape, not a crash', () => {
    expect(parseToolCall({ id: 'x' })).toEqual({
      ok: false,
      id: 'x',
      name: null,
      reason: 'unrecognized-shape',
    });
  });

  it.each([null, undefined, 'string', 42, []])('tolerates %p', (input) => {
    expect(parseToolCall(input).ok).toBe(false);
  });

  it('absent arguments mean an empty object, not a failure', () => {
    const parsed = parseToolCall({ id: 'x', function: { name: 'create_patient' } });
    expect(parsed).toEqual({ ok: true, id: 'x', name: 'create_patient', args: {} });
  });
});

describe('extractToolCallList', () => {
  it('reads toolCallList', () => {
    expect(extractToolCallList({ toolCallList: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
  });

  it('falls back to toolWithToolCallList[].toolCall', () => {
    expect(
      extractToolCallList({ toolWithToolCallList: [{ name: 'x', toolCall: { id: 'a' } }] }),
    ).toEqual([{ id: 'a' }]);
  });

  it('returns an empty array rather than undefined for junk', () => {
    expect(extractToolCallList(undefined)).toEqual([]);
    expect(extractToolCallList({})).toEqual([]);
  });
});
