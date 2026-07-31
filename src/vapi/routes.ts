// The two Vapi webhook routes.
//
// The split is deliberate and is the whole reason the two contradictory error
// conventions in this codebase never collide
// (docs/handoff/phase-1-vapi-contract.md § 5.2):
//
//   tool.server.url      -> POST /vapi/tool    `tool-calls` only. HTTP 200 ALWAYS,
//                                              body `{ results: [...] }`.
//   assistant.server.url -> POST /vapi/events  end-of-call-report, status-update,
//                                              hang, … Bare 200, no body.
//
// The challenge's 400/404/422 status map belongs to `/patients` and applies here
// to NOTHING. § G5: "Always return HTTP 200, even for errors. Any other status
// code is ignored completely" — and an ignored response presents to the caller
// as silence.
//
// The one exception is authentication: an unauthenticated request is not a tool
// outcome at all, so it gets 401. Returning 200 to an unknown caller would both
// leak and defeat the check.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { upsertCallTranscript } from '../services/call-transcript.js';
import { extractToolCallList, parseToolCall } from './parse-tool-call.js';
import { dispatchTool, type ToolContext, type ToolOutcome } from './tools.js';
import { verifyWebhookSecret } from './verify.js';

// ---------------------------------------------------------------------------
// Wire types (only the parts we read; everything else on the message is ignored)
// ---------------------------------------------------------------------------

/** `[SPEC]` ToolCallResult — `name` and `toolCallId` are both REQUIRED (§ G3). */
interface ToolCallResult extends ToolOutcome {
  name: string;
  toolCallId: string;
}

interface ToolCallsResponse {
  results: ToolCallResult[];
}

/**
 * The envelope for a 401. `ERROR_CODES` in `src/lib/envelope.ts` has no
 * UNAUTHORIZED member and that module belongs to the REST contract, so the
 * shape is built here rather than widening a type the /patients routes depend on.
 */
const UNAUTHORIZED_BODY = {
  data: null,
  error: { code: 'UNAUTHORIZED', message: 'Invalid or missing webhook secret.', details: null },
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `new Date("banana")` is an Invalid Date, which Prisma rejects at write time. */
function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `vapi_call_id` is VarChar(128) on both `patients` and `call_transcripts`. */
const VAPI_CALL_ID_MAX = 128;

/**
 * An over-length id is read as ABSENT rather than truncated: Prisma would reject
 * the write outright, and a truncated id would key a row that no later delivery
 * could ever resolve back to. Missing means "store no linkage", never "fail" —
 * the same contract as a message that carries no `call` at all.
 */
function toCallId(value: unknown): string | undefined {
  const text = toText(value);
  return text !== undefined && text.length <= VAPI_CALL_ID_MAX ? text : undefined;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the request may proceed. Replies with 401 itself otherwise,
 * so callers just `if (!authorize(...)) return;`.
 */
function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
  const outcome = verifyWebhookSecret(request.headers as Record<string, unknown>);

  if (!outcome.ok) {
    // A 401 presents to Vapi as caller silence, so make it diagnosable in one
    // log line: which route, and absent-header vs wrong-value.
    request.log.warn(
      { event: 'vapi_webhook_unauthorized', route: request.url, reason: outcome.reason },
      'Rejected a Vapi webhook request',
    );
    reply.code(401).send(UNAUTHORIZED_BODY);
    return false;
  }

  if (outcome.reason === 'unconfigured') {
    // Loud, on every request, on purpose. Local dev must not be blocked, but a
    // production deployment must not be silently unauthenticated either.
    request.log.warn(
      { event: 'vapi_webhook_unauthenticated', route: request.url },
      'VAPI_WEBHOOK_SECRET is not set — accepting this webhook WITHOUT authentication',
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// tool-calls
// ---------------------------------------------------------------------------

/**
 * Handle a whole `tool-calls` message.
 *
 * Results are returned in the same order the calls arrived (§ 2.2 hard rules),
 * and `toolCallId` is echoed back VERBATIM — a generated or mismatched id is
 * Vapi's "Tool call ID mismatch" and the model hangs mid-call (§ G6).
 */
async function handleToolCalls(request: FastifyRequest, message: unknown): Promise<ToolCallsResponse> {
  const toolCalls = extractToolCallList(message);
  const results: ToolCallResult[] = [];

  // Read once per message, not per tool call: `message.call` belongs to the
  // message, and every call in it is the same call. `create_patient` stamps it
  // on the patient row so the end-of-call transcript can find its patient.
  // OPTIONAL — two of the three published `tool-calls` shapes omit it entirely,
  // and a tool call without it must still register the patient.
  const context: ToolContext = { vapiCallId: toCallId(asRecord(asRecord(message)?.['call'])?.['id']) };

  for (const raw of toolCalls) {
    const parsed = parseToolCall(raw);

    if (!parsed.ok) {
      request.log.error(
        { event: 'vapi_tool_call_unparsed', reason: parsed.reason, tool_call: raw },
        'Could not read an inbound tool call',
      );

      // Nothing to address the result to — Vapi cannot match it and the model
      // would hang on a phantom id. Skip it; the log is the record.
      if (parsed.id === null || parsed.name === null) continue;

      results.push({
        name: parsed.name,
        toolCallId: parsed.id,
        error: 'The tool arguments were not valid JSON and could not be read. Say the details again.',
        message: {
          type: 'request-failed',
          content: "I'm sorry — that didn't come through on my end. Let me try that once more.",
        },
      });
      continue;
    }

    request.log.debug(
      { event: 'vapi_tool_call', tool: parsed.name, tool_call_id: parsed.id, args: parsed.args },
      'Dispatching a Vapi tool call',
    );

    // Belt and braces: `dispatchTool` is written not to throw, but a throw here
    // would reach the global error handler and become a 500, which Vapi ignores.
    let outcome: ToolOutcome;
    try {
      outcome = await dispatchTool(parsed.name, parsed.args, context);
    } catch (error) {
      request.log.error({ event: 'vapi_tool_dispatch_threw', err: error }, 'Tool handler threw');
      outcome = {
        error: 'The request failed unexpectedly on the server.',
        message: {
          type: 'request-failed',
          content: "I'm sorry — our system isn't responding right now. Let me try once more.",
        },
      };
    }

    request.log.info(
      {
        event: 'vapi_tool_result',
        tool: parsed.name,
        tool_call_id: parsed.id,
        outcome: outcome.error === undefined ? 'success' : 'error',
      },
      'Vapi tool call completed',
    );

    results.push({ name: parsed.name, toolCallId: parsed.id, ...outcome });
  }

  return { results };
}

// ---------------------------------------------------------------------------
// end-of-call-report
// ---------------------------------------------------------------------------

/**
 * Above either of these, a call that registered nobody is a suspected failure
 * rather than an abandoned dial. Roughly: long enough for the agent to have
 * asked for a name and got an answer.
 */
const UNPRODUCTIVE_TRANSCRIPT_CHARS = 400;
const UNPRODUCTIVE_DURATION_SECONDS = 60;

/**
 * Whether an end-of-call report with no linked patient should emit
 * `vapi_call_completed_without_patient`. Short abandoned dials stay quiet;
 * long talk-time or a long transcript without a registration is the signal.
 */
export function shouldWarnCallWithoutPatient(opts: {
  patientId: string | null;
  transcriptLength: number;
  durationSeconds: number | null;
}): boolean {
  if (opts.patientId !== null) return false;
  const duration = opts.durationSeconds ?? 0;
  return (
    opts.transcriptLength >= UNPRODUCTIVE_TRANSCRIPT_CHARS ||
    duration >= UNPRODUCTIVE_DURATION_SECONDS
  );
}

/**
 * Persist the transcript. Every field is NESTED — `message.transcript`,
 * `message.summary` and `message.recordingUrl` are all `undefined` (§ G10):
 *
 *   transcript   message.artifact.transcript
 *   summary      message.analysis.summary
 *   recordingUrl message.artifact.recordingUrl
 *   call id      message.call.id
 */
async function handleEndOfCallReport(request: FastifyRequest, message: unknown): Promise<void> {
  const msg = asRecord(message);
  const artifact = asRecord(msg?.['artifact']);
  const analysis = asRecord(msg?.['analysis']);
  const call = asRecord(msg?.['call']);

  const vapiCallId = toCallId(call?.['id']);

  // `message.call` is OPTIONAL in the type (§ 3.4). Without an id there is no
  // unique key, so there is nothing to upsert on — log and drop.
  if (vapiCallId === undefined) {
    request.log.warn(
      { event: 'vapi_end_of_call_no_call_id', log_url: toText(artifact?.['logUrl']) },
      'end-of-call-report arrived without a usable message.call.id; transcript not persisted',
    );
    return;
  }

  const recordingUrl = toText(artifact?.['recordingUrl']);
  const transcript = toText(artifact?.['transcript']);
  const endedReason = toText(msg?.['endedReason']);
  const startedAt = toDate(msg?.['startedAt']);
  const endedAt = toDate(msg?.['endedAt']);

  // `patientId` is not passed in: the service resolves it from the patient row
  // that `create_patient` stamped with this same call id. Unresolved is normal
  // — the caller can hang up before any patient exists — and stays NULL.
  const saved = await upsertCallTranscript({
    vapiCallId,
    transcript: transcript ?? null,
    summary: toText(analysis?.['summary']) ?? null,
    recordingUrl: recordingUrl ?? null,
    startedAt: startedAt ?? null,
    endedAt: endedAt ?? null,
  });

  request.log.info(
    {
      event: 'vapi_call_transcript_persisted',
      vapi_call_id: vapiCallId,
      call_transcript_id: saved.id,
      // NULL when the call registered nobody, which is not an error.
      patient_id: saved.patientId,
      ended_reason: endedReason,
      recording_url: recordingUrl,
    },
    'Persisted a call transcript',
  );

  const transcriptLength = transcript?.length ?? 0;
  const durationSeconds =
    startedAt !== undefined && endedAt !== undefined
      ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
      : 0;

  // A null patient_id is only *expected* on a call that never got going. Once
  // the caller talked for a while and still nobody was registered, something
  // upstream lost the linkage or the intake failed — and the info line above
  // reads identically to a hang-up, so it would never be noticed.
  if (
    shouldWarnCallWithoutPatient({
      patientId: saved.patientId,
      transcriptLength,
      durationSeconds,
    })
  ) {
    request.log.warn(
      {
        event: 'vapi_call_completed_without_patient',
        vapi_call_id: vapiCallId,
        transcript_length: transcriptLength,
        duration_seconds: durationSeconds,
        ended_reason: endedReason,
      },
      'A substantial call ended with no patient linked to its transcript',
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function vapiRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated error handler — the last net under the per-call try/catch.
  // Anything that escapes on /vapi/tool must still leave as a 200; a 500 there
  // is discarded by Vapi and the caller hears nothing at all.
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ event: 'vapi_route_error', err: error }, 'Unhandled error in a Vapi route');

    // Discriminate on the MESSAGE TYPE, not the URL.
    //
    // `/vapi/events` deliberately also handles `tool-calls`: a tool created
    // without its own `server.url` falls back to the assistant URL (contract
    // § 5.2), and 200-and-ignoring those would make the tool silently never
    // work. So a URL check answers 500 for a tool call that arrived on the
    // events route — Vapi discards it, the model never gets a result for that
    // toolCallId, and the caller hears silence mid-registration.
    //
    // The body may be unparseable here (that is often WHY we are in the error
    // handler), so read it defensively: any failure falls back to the URL, which
    // is still right for the common case.
    let isToolCall = request.url.startsWith('/vapi/tool');
    if (!isToolCall) {
      try {
        const type = (request.body as { message?: { type?: unknown } } | undefined)?.message?.type;
        isToolCall = type === 'tool-calls';
      } catch {
        // Leave isToolCall as the URL-derived value.
      }
    }

    if (isToolCall) {
      reply.code(200).send({ results: [] } satisfies ToolCallsResponse);
      return;
    }

    reply.code(500).send({
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred.', details: null },
    });
  });

  // -------------------------------------------------------------------------
  // POST /vapi/tool — `tool-calls` only. HTTP 200 for every outcome.
  // -------------------------------------------------------------------------
  app.post('/vapi/tool', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(request, reply)) return;

    // The first live call is what tells us which of the three published shapes
    // is actually on the wire (§ 2.1). Until then, log it all.
    request.log.debug({ event: 'vapi_tool_raw_body', body: request.body }, 'Raw /vapi/tool body');

    const message = asRecord(request.body)?.['message'];
    const response = await handleToolCalls(request, message);

    // Bare `{ results: [...] }`, NOT wrapped in `messageResponse` — every prose
    // doc and the troubleshooting page show the bare form (§ G17).
    reply.code(200).send(response);
  });

  // -------------------------------------------------------------------------
  // POST /vapi/events — everything else on the assistant server URL.
  // -------------------------------------------------------------------------
  app.post('/vapi/events', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(request, reply)) return;

    const message = asRecord(request.body)?.['message'];
    const type = toText(asRecord(message)?.['type']) ?? 'unknown';

    request.log.debug({ event: 'vapi_event_raw_body', type, body: request.body }, 'Raw /vapi/events body');

    // A tool created without its own `server.url` falls back to the assistant
    // URL (§ 5.2), so this route must handle `tool-calls` rather than 200-and-
    // ignore them — otherwise the tool silently never works.
    if (type === 'tool-calls') {
      const response = await handleToolCalls(request, message);
      reply.code(200).send(response);
      return;
    }

    if (type === 'end-of-call-report') {
      try {
        await handleEndOfCallReport(request, message);
      } catch (error) {
        // Vapi does not retry by default (§ G16), so a failed write is simply
        // lost — but a 500 here buys nothing and only muddies the logs.
        request.log.error(
          { event: 'vapi_end_of_call_persist_failed', err: error },
          'Failed to persist a call transcript',
        );
      }

      reply.code(200).send();
      return;
    }

    request.log.info({ event: 'vapi_event_ignored', type }, 'Vapi event acknowledged without action');

    // No response body is expected for informational events (§ 3.4).
    reply.code(200).send();
  });
}
