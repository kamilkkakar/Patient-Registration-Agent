// Name validation: non-ASCII letters accepted, everything else still rejected.
//
// The old pattern was `/^[A-Za-z][A-Za-z\s'-]*$/`, which 422s José, Müller and
// Nguyễn. In a U.S. patient-registration system that is a wrong answer — those
// are ordinary names. The widened pattern is `/^\p{L}[\p{L}\s'-]*$/u`, and the
// second half of this file is the part that matters: widening to `\p{L}` must
// not open the door to digits, markup, emoji or bidi-control characters.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  api,
  assertEnvelope,
  purgeTestPatients,
  startTestApp,
  testLastName,
  validPayload,
} from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

describe('accepted names', () => {
  // Last names keep the Zzqatest prefix so purgeTestPatients still reaches
  // them; the non-ASCII part is appended to it.
  const accepted: Array<[label: string, firstName: string, lastSuffix: string]> = [
    ['Spanish acute', 'José', 'Ramirez'],
    ['German umlaut', 'Anna', 'Müller'],
    ['Vietnamese stacked diacritics', 'Nguyễn', 'Tran'],
    ['French cedilla', 'François', 'Dubois'],
    ['apostrophe', "O'Brien", 'Obrien'],
    ['hyphen', 'Mary-Jane', 'Watson'],
    ['internal spaces', 'Jan', 'Van Der Berg'],
    ['multiple internal spaces', 'Maria', 'De La Cruz'],
  ];

  for (const [label, firstName, lastSuffix] of accepted) {
    it(`accepts ${label}: "${firstName}" / "${lastSuffix}"`, async () => {
      const lastName = testLastName(lastSuffix);

      const res = await api(app)
        .post('/patients')
        .send(validPayload({ first_name: firstName, last_name: lastName }));

      expect(res.status).toBe(201);
      assertEnvelope(res.body);

      const created = res.body.data as Record<string, unknown>;
      // Stored verbatim — no transliteration, no stripping.
      expect(created['first_name']).toBe(firstName);
      expect(created['last_name']).toBe(lastName);
    });
  }
});

describe('rejected names', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE, built from its code point rather than typed
  // literally: an invisible bidi control in source silently reverses the rest
  // of the line for anyone reviewing this file.
  const RTL_OVERRIDE = String.fromCodePoint(0x202e);

  const rejected: Array<[label: string, value: string]> = [
    ['digits', 'John3'],
    ['bare digits', '1234'],
    ['markup', '<script>alert(1)</script>'],
    ['emoji', '😀'],
    ['letter plus emoji', 'Jane😀'],
    // The RTL override is \p{Cf}, not \p{L}, so widening to \p{L} does not
    // readmit it.
    ['RTL override', `Jane${RTL_OVERRIDE}eman`],
    ['leading RTL override', `${RTL_OVERRIDE}Jane`],
    ['underscore', 'Jane_Doe'],
    ['leading hyphen', '-Jane'],
    ['leading apostrophe', "'Jane"],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label} with 422`, async () => {
      const res = await api(app)
        .post('/patients')
        .send(validPayload({ first_name: value, last_name: testLastName('Reject') }));

      expect(res.status).toBe(422);
      assertEnvelope(res.body);

      const error = res.body.error as { code: string; details: Array<{ field: string }> };
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.map((d) => d.field)).toContain('first_name');
    });
  }
});

describe('REST date_of_birth contract is unchanged', () => {
  // Guards the parser split: the REST boundary keeps the STRICT parser. A
  // client sending a single-digit month must still 422 — only the voice ingress
  // gets the permissive spoken-form parser.
  it('still rejects a non-zero-padded MM/DD/YYYY date', async () => {
    const res = await api(app)
      .post('/patients')
      .send(validPayload({ date_of_birth: '2/15/1992', last_name: testLastName('Dobloose') }));

    expect(res.status).toBe(422);
    const error = res.body.error as { details: Array<{ field: string }> };
    expect(error.details.map((d) => d.field)).toContain('date_of_birth');
  });

  it('still rejects a spoken date', async () => {
    const res = await api(app)
      .post('/patients')
      .send(
        validPayload({
          date_of_birth: 'the fifth of March nineteen eighty five',
          last_name: testLastName('Dobspoken'),
        }),
      );

    expect(res.status).toBe(422);
  });
});
