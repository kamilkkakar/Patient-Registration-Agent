// POST /vapi/tool — routing, the HTTP-200-always rule, and the error-return
// contract from prompts/intake-coordinator.md § 2.7.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, prisma, purgeTestPatients, startTestApp, testLastName } from '../helpers.js';
import { WEBHOOK_SECRET_HEADER } from '../../src/vapi/verify.js';

let app: FastifyInstance;

const ORIGINAL_SECRET = process.env.VAPI_WEBHOOK_SECRET;

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();

  if (ORIGINAL_SECRET === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

// The ambient .env may or may not define VAPI_WEBHOOK_SECRET, and these tests
// must not depend on which. Every test starts from a KNOWN state — unset, which
// the verifier treats as "allow with a loud warning" — and the auth block below
// sets it explicitly for the cases that are about authentication.
beforeEach(() => {
  delete process.env.VAPI_WEBHOOK_SECRET;
});

// ---------------------------------------------------------------------------
// Body builders — one per published shape (phase-1 contract § 2.1)
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

/** [SPEC]/[SDK]: `function.arguments` is a JSON STRING. */
function specShape(id: string, name: string, args: Args): unknown {
  return {
    message: {
      type: 'tool-calls',
      toolCallList: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      call: { id: `vapi-call-${id}` },
    },
  };
}

/** docs/tools/custom-tools: top-level `name`, `arguments` as an object. */
function customToolsShape(id: string, name: string, args: Args): unknown {
  return { message: { type: 'tool-calls', toolCallList: [{ id, name, arguments: args }] } };
}

/** docs/server-url/events: top-level `name`, `parameters` as an object. */
function eventsShape(id: string, name: string, args: Args): unknown {
  return { message: { type: 'tool-calls', toolCallList: [{ id, name, parameters: args }] } };
}

interface ToolResult {
  name: string;
  toolCallId: string;
  result?: string;
  error?: string;
  message?: { type: string; content: string };
}

async function postTool(body: unknown): Promise<{ status: number; results: ToolResult[] }> {
  const res = await api(app).post('/vapi/tool').send(body as object);
  return { status: res.status, results: (res.body as { results: ToolResult[] }).results };
}

/** What the caller SAID, not what the database stores. */
function spokenPayload(overrides: Args = {}): Args {
  return {
    first_name: 'Sarah',
    last_name: testLastName('Bridge'),
    date_of_birth: 'February fifteenth, ninety two',
    sex: 'Female',
    phone_number: 'nine oh two, five five five, oh one four seven',
    address_line_1: '4120 Guadalupe Street',
    city: 'Austin',
    state: 'Texas',
    zip_code: 'seven eight seven oh one',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('POST /vapi/tool — all three published shapes route to the right handler', () => {
  it.each([
    ['[SPEC] function.arguments JSON string', specShape],
    ['docs/custom-tools arguments object', customToolsShape],
    ['docs/events parameters object', eventsShape],
  ])('%s', async (_label, build) => {
    const { status, results } = await postTool(
      build('tc-shape-1', 'lookup_patient_by_phone', {
        phone_number: 'nine oh two, five five five, oh one four seven',
      }),
    );

    expect(status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('lookup_patient_by_phone');
    // Echoed back VERBATIM — a mismatch is Vapi's "Tool call ID mismatch" (G6).
    expect(results[0]?.toolCallId).toBe('tc-shape-1');
    expect(results[0]?.error).toBeUndefined();
    expect(typeof results[0]?.result).toBe('string');
  });

  it('dispatches each tool name to its own handler', async () => {
    const lookup = await postTool(
      specShape('tc-a', 'lookup_patient_by_phone', { phone_number: '(512) 555-0199' }),
    );
    expect(lookup.results[0]?.result).toContain('No patient is registered');

    const update = await postTool(specShape('tc-b', 'update_patient', { city: 'Austin' }));
    expect(update.results[0]?.error).toContain('patient_id');

    const create = await postTool(specShape('tc-c', 'create_patient', {}));
    // create_patient reached the create schema, not the update one.
    expect(create.results[0]?.error).toContain('first_name');
  });

  it('preserves order and answers every call in a multi-call message', async () => {
    const res = await api(app)
      .post('/vapi/tool')
      .send({
        message: {
          type: 'tool-calls',
          toolCallList: [
            { id: 'tc-1', function: { name: 'lookup_patient_by_phone', arguments: '{"phone_number":"(512) 555-0199"}' } },
            { id: 'tc-2', function: { name: 'no_such_tool', arguments: '{}' } },
          ],
        },
      });

    expect(res.status).toBe(200);
    const results = (res.body as { results: ToolResult[] }).results;
    expect(results.map((r) => r.toolCallId)).toEqual(['tc-1', 'tc-2']);
  });
});

describe('POST /vapi/tool — HTTP 200 for EVERY outcome (§ G5)', () => {
  it('200 on a validation failure', async () => {
    const { status, results } = await postTool(
      specShape('tc-invalid', 'create_patient', spokenPayload({ zip_code: 'one two three' })),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeTruthy();
  });

  it('200 on an unknown tool name', async () => {
    const { status, results } = await postTool(specShape('tc-unknown', 'delete_everything', {}));

    expect(status).toBe(200);
    expect(results[0]?.name).toBe('delete_everything');
    expect(results[0]?.error).toContain('Unknown tool');
  });

  it('200 with an error result — not a 500 — when `arguments` is malformed JSON', async () => {
    const res = await api(app)
      .post('/vapi/tool')
      .send({
        message: {
          type: 'tool-calls',
          toolCallList: [
            { id: 'tc-bad-json', function: { name: 'create_patient', arguments: '{"first_name": "Sarah"' } },
          ],
        },
      });

    expect(res.status).toBe(200);
    const results = (res.body as { results: ToolResult[] }).results;
    expect(results[0]?.toolCallId).toBe('tc-bad-json');
    expect(results[0]?.error).toBeTruthy();
  });

  it('200 with an empty results array when there are no tool calls at all', async () => {
    const res = await api(app).post('/vapi/tool').send({ message: { type: 'tool-calls' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it('200 on a body with no message at all', async () => {
    const res = await api(app).post('/vapi/tool').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });
});

describe('POST /vapi/tool — the normalization bridge reaches the service', () => {
  it('stores canonical values from an entirely spoken payload', async () => {
    const { status, results } = await postTool(
      specShape(
        'tc-create-1',
        'create_patient',
        spokenPayload({
          last_name: `${testLastName('Spoken')}, not D-A-V-I-E-S`,
          email: 'sarah dot davis at gmail dot com',
        }),
      ),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeUndefined();

    const id = /Patient ID ([0-9a-f-]{36})\./.exec(results[0]?.result ?? '')?.[1];
    expect(id).toBeTruthy();

    const patient = await prisma.patient.findUniqueOrThrow({ where: { patientId: id ?? '' } });

    // Spelled name resolved past the negation marker, and title-cased.
    expect(patient.lastName).toBe('Zzqatestspoken');
    expect(patient.phoneNumber).toBe('9025550147');
    expect(patient.zipCode).toBe('78701');
    expect(patient.state).toBe('TX');
    expect(patient.email).toBe('sarah.davis@gmail.com');
    expect(patient.sex).toBe('FEMALE');
    // A bare `date`, compared in UTC — the suite runs under America/Los_Angeles.
    expect(patient.dateOfBirth.toISOString()).toBe('1992-02-15T00:00:00.000Z');
  });

  it('lookup_patient_by_phone finds that record by its SPOKEN phone number, and returns the id', async () => {
    const { results } = await postTool(
      specShape('tc-lookup-1', 'lookup_patient_by_phone', {
        phone_number: 'nine oh two, five five five, oh one four seven',
      }),
    );

    // The id is the only route the model has to update_patient.
    expect(results[0]?.result).toMatch(/patient_id [0-9a-f-]{36}/);
    expect(results[0]?.result).toContain('Zzqatestspoken');
  });

  it('caps a household lookup at three described matches and counts the rest', async () => {
    // A shared household number is normal, not an error — but every described
    // match is another person's name and DOB entering the model context, the
    // transcript and the logs, so the list is bounded.
    const shared = '5125550188';
    for (const suffix of ['HouseA', 'HouseB', 'HouseC', 'HouseD']) {
      await prisma.patient.create({
        data: {
          firstName: 'Jane',
          lastName: testLastName(suffix),
          dateOfBirth: new Date('1992-02-15T00:00:00.000Z'),
          sex: 'FEMALE',
          phoneNumber: shared,
          addressLine1: '123 Main St',
          city: 'Austin',
          state: 'TX',
          zipCode: '78701',
        },
      });
    }

    const { results } = await postTool(
      specShape('tc-household', 'lookup_patient_by_phone', { phone_number: shared }),
    );

    const result = results[0]?.result ?? '';
    expect(result).toContain('Found 4 patients');
    expect(result.match(/patient_id/g)).toHaveLength(3);
    expect(result).toContain('Plus 1 more');
  });

  it('update_patient normalizes too, and strips patient_id before the strict schema', async () => {
    const created = await prisma.patient.findFirstOrThrow({
      where: { lastName: 'Zzqatestspoken' },
    });

    const { status, results } = await postTool(
      specShape('tc-update-1', 'update_patient', {
        patient_id: created.patientId,
        state: 'California',
        zip_code: 'nine oh two one oh',
      }),
    );

    expect(status).toBe(200);
    // `.strict()` would have rejected patient_id as an unknown key.
    expect(results[0]?.error).toBeUndefined();

    const updated = await prisma.patient.findUniqueOrThrow({
      where: { patientId: created.patientId },
    });
    expect(updated.state).toBe('CA');
    expect(updated.zipCode).toBe('90210');
  });
});

describe('POST /vapi/tool — error-return contract (§ 2.7)', () => {
  it('a normalizer returning null yields a FIELD-SPECIFIC error, not "required"', async () => {
    const { results } = await postTool(
      specShape('tc-zip', 'create_patient', spokenPayload({ zip_code: 'one two three' })),
    );

    const error = results[0]?.error ?? '';
    expect(error).toContain('zip_code');
    expect(error).toContain('5-digit ZIP');
    // The raw value survived to Zod — it was not dropped, which would have
    // produced a generic "Required".
    expect(error).not.toContain('Required');
  });

  it('a future date of birth is named as such', async () => {
    const { results } = await postTool(
      specShape(
        'tc-dob',
        'create_patient',
        spokenPayload({ date_of_birth: 'February fifteenth, twenty ninety' }),
      ),
    );

    expect(results[0]?.error).toContain('date_of_birth');
    expect(results[0]?.error).toContain('future');
  });

  it('validation failures carry NO inline request-failed message', async () => {
    // Speech precedence: an inline message pre-empts the model at step (2), and
    // the per-field re-prompt requirement becomes unreachable.
    const { results } = await postTool(
      specShape('tc-nomsg', 'create_patient', spokenPayload({ phone_number: 'five five five' })),
    );

    expect(results[0]?.error).toContain('phone_number');
    expect(results[0]?.message).toBeUndefined();
  });

  it('field validation error ends with the re-ask instruction', async () => {
    const { results } = await postTool(
      specShape('tc-reask', 'create_patient', spokenPayload({ zip_code: 'one two three' })),
    );

    expect(results[0]?.error).toMatch(/Ask the caller again for only the field/);
  });

  it('infrastructure failures DO carry an inline request-failed message', async () => {
    // An unknown tool is a deployment/config fault, not a caller fault.
    const { results } = await postTool(specShape('tc-infra', 'no_such_tool', {}));

    expect(results[0]?.message?.type).toBe('request-failed');
    // Must match INFRA_SPEECH in src/vapi/tools.ts — duplicated here on purpose
    // rather than exporting the constant from production.
    expect(results[0]?.message?.content).toBe(
      "I'm sorry — I've got all your details but our system isn't saving them right now. Let me try once more.",
    );
  });

  it('every result string is single-line (§ G4)', async () => {
    const { results } = await postTool(specShape('tc-lines', 'create_patient', {}));

    expect(results[0]?.error).not.toMatch(/[\r\n]/);
  });
});

describe('create_patient spoken success contract', () => {
  it('returns exactly Registered. Patient ID <uuid>. with no error and no message', async () => {
    const { status, results } = await postTool(
      specShape(
        'tc-create-speech',
        'create_patient',
        spokenPayload({
          last_name: testLastName('CreateSpeech'),
          phone_number: 'five one two, five five five, oh one five five',
        }),
      ),
    );

    expect(status).toBe(200);
    const id = /Patient ID ([0-9a-f-]{36})\./.exec(results[0]?.result ?? '')?.[1];
    expect(id).toBeTruthy();
    expect(results[0]?.result).toBe(`Registered. Patient ID ${id}.`);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('identical full row → Already registered with the same Patient ID (not phone-only dedupe)', async () => {
    const payload = spokenPayload({
      last_name: testLastName('CreateDedupe'),
      phone_number: 'five one two, five five five, oh one nine five',
    });

    const first = await postTool(specShape('tc-dedupe-1', 'create_patient', payload));
    const id = /Patient ID ([0-9a-f-]{36})\./.exec(first.results[0]?.result ?? '')?.[1];
    expect(first.results[0]?.result).toBe(`Registered. Patient ID ${id}.`);

    const second = await postTool(specShape('tc-dedupe-2', 'create_patient', payload));
    expect(second.status).toBe(200);
    expect(second.results[0]?.result).toBe(
      `Already registered. Identical record on file. Patient ID ${id}.`,
    );
    expect(second.results[0]?.error).toBeUndefined();
    expect(second.results[0]?.message).toBeUndefined();
  });

  it('same phone, different name → second Registered (household, not a duplicate)', async () => {
    const phone = 'five one two, five five five, oh one nine six';
    const a = await postTool(
      specShape(
        'tc-hh-a',
        'create_patient',
        spokenPayload({
          first_name: 'Alex',
          last_name: testLastName('CreateHhA'),
          phone_number: phone,
        }),
      ),
    );
    const b = await postTool(
      specShape(
        'tc-hh-b',
        'create_patient',
        spokenPayload({
          first_name: 'Blake',
          last_name: testLastName('CreateHhB'),
          phone_number: phone,
          date_of_birth: 'March twentieth, nineteen ninety',
        }),
      ),
    );

    expect(a.results[0]?.result).toMatch(/^Registered\. Patient ID /);
    expect(b.results[0]?.result).toMatch(/^Registered\. Patient ID /);
    expect(a.results[0]?.result).not.toBe(b.results[0]?.result);
  });
});

describe('lookup_patient_by_phone spoken contract', () => {
  it('zero match → exact no-patient sentence, no message', async () => {
    const { status, results } = await postTool(
      specShape('tc-lookup-zero', 'lookup_patient_by_phone', {
        phone_number: '(512) 555-0190',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.result).toBe('No patient is registered with that phone number.');
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('missing phone → field error mentioning phone, no request-failed message', async () => {
    const { results } = await postTool(specShape('tc-lookup-nophone', 'lookup_patient_by_phone', {}));

    expect(results[0]?.error).toMatch(/phone/i);
    expect(results[0]?.result).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('invalid spoken phone → field error, no message', async () => {
    const { results } = await postTool(
      specShape('tc-lookup-badphone', 'lookup_patient_by_phone', {
        phone_number: 'one two three',
      }),
    );

    expect(results[0]?.error).toMatch(/phone/i);
    expect(results[0]?.result).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('single match → Found 1 patient: … patient_id <uuid>.', async () => {
    const phone = 'five one two, five five five, oh one six six';

    const created = await postTool(
      specShape(
        'tc-lookup-one-create',
        'create_patient',
        spokenPayload({ last_name: testLastName('LookupOne'), phone_number: phone }),
      ),
    );
    const id = /Patient ID ([0-9a-f-]{36})\./.exec(created.results[0]?.result ?? '')?.[1];
    expect(id).toBeTruthy();

    const patient = await prisma.patient.findUniqueOrThrow({ where: { patientId: id ?? '' } });

    const { results } = await postTool(
      specShape('tc-lookup-one', 'lookup_patient_by_phone', { phone_number: phone }),
    );

    // Exact format from tools.ts: `Found ${n} patient${s}: ${listed}.`
    expect(results[0]?.result).toBe(
      `Found 1 patient: ${patient.firstName} ${patient.lastName}, born 02/15/1992, patient_id ${id}.`,
    );
    expect(results[0]?.result).toMatch(/^Found 1 patient: .+ patient_id [0-9a-f-]{36}\.$/);
    expect(results[0]?.message).toBeUndefined();
  });
});

describe('update_patient spoken contract', () => {
  it('after create+lookup, update returns exactly Updated. Patient ID <uuid>.', async () => {
    const phone = 'five one two, five five five, oh one seven seven';
    const created = await postTool(
      specShape(
        'tc-upd-create',
        'create_patient',
        spokenPayload({ last_name: testLastName('UpdateSpeech'), phone_number: phone }),
      ),
    );
    const id = /Patient ID ([0-9a-f-]{36})\./.exec(created.results[0]?.result ?? '')?.[1];
    expect(id).toBeTruthy();

    const lookup = await postTool(
      specShape('tc-upd-lookup', 'lookup_patient_by_phone', { phone_number: phone }),
    );
    expect(lookup.results[0]?.result).toContain(`patient_id ${id}`);

    const { status, results } = await postTool(
      specShape('tc-upd-ok', 'update_patient', { patient_id: id, city: 'Dallas' }),
    );

    expect(status).toBe(200);
    expect(results[0]?.result).toBe(`Updated. Patient ID ${id}.`);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('bad/missing patient_id → field error, no request-failed', async () => {
    const { results } = await postTool(
      specShape('tc-upd-badid', 'update_patient', { city: 'Austin' }),
    );

    expect(results[0]?.error).toContain('patient_id');
    expect(results[0]?.message).toBeUndefined();
  });

  it('unknown uuid → error contains No patient exists with that patient_id', async () => {
    const { results } = await postTool(
      specShape('tc-upd-unknown', 'update_patient', {
        patient_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        city: 'Austin',
      }),
    );

    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });

  it('soft-deleted patient → field error (NotFound path), no request-failed', async () => {
    const created = await postTool(
      specShape(
        'tc-upd-del-create',
        'create_patient',
        spokenPayload({
          last_name: testLastName('UpdateDeleted'),
          phone_number: 'five one two, five five five, oh one eight eight',
        }),
      ),
    );
    const id = /Patient ID ([0-9a-f-]{36})\./.exec(created.results[0]?.result ?? '')?.[1];
    expect(id).toBeTruthy();

    const del = await api(app).delete(`/patients/${id}`);
    expect(del.status).toBe(200);

    const { status, results } = await postTool(
      specShape('tc-upd-del', 'update_patient', { patient_id: id, city: 'Houston' }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });
});

describe('POST /vapi/tool — webhook authentication', () => {
  it('rejects a wrong secret with 401', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'the-real-secret';

    const res = await api(app)
      .post('/vapi/tool')
      .set(WEBHOOK_SECRET_HEADER, 'not-the-secret')
      .send(specShape('tc-auth-1', 'lookup_patient_by_phone', { phone_number: '(512) 555-0199' }) as object);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ data: null, error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects a missing secret with 401 when one is configured', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'the-real-secret';

    const res = await api(app).post('/vapi/tool').send({ message: { type: 'tool-calls' } });

    expect(res.status).toBe(401);
  });

  it('accepts the correct secret', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'the-real-secret';

    const res = await api(app)
      .post('/vapi/tool')
      .set(WEBHOOK_SECRET_HEADER, 'the-real-secret')
      .send(specShape('tc-auth-2', 'lookup_patient_by_phone', { phone_number: '(512) 555-0199' }) as object);

    expect(res.status).toBe(200);
    expect((res.body as { results: ToolResult[] }).results[0]?.toolCallId).toBe('tc-auth-2');
  });

  it('allows the request when VAPI_WEBHOOK_SECRET is unset (dev is not blocked)', async () => {
    delete process.env.VAPI_WEBHOOK_SECRET;

    const res = await api(app).post('/vapi/tool').send({ message: { type: 'tool-calls' } });

    expect(res.status).toBe(200);
  });
});
