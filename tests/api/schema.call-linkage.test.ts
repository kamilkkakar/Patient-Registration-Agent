// The `add_call_linkage` migration, asserted against the live database rather
// than against prisma/schema.prisma.
//
// A schema file that says VARCHAR(128) proves nothing about the database the
// tests just ran on: only an applied migration does. These queries are the same
// information_schema / pg_indexes lookups a reviewer would run by hand.

import { describe, expect, it } from 'vitest';
import { prisma } from '../helpers.js';

interface ColumnRow {
  data_type: string;
  character_maximum_length: number | null;
  is_nullable: string;
}

async function column(table: string, name: string): Promise<ColumnRow | undefined> {
  const rows = await prisma.$queryRaw<ColumnRow[]>`
    SELECT data_type, character_maximum_length, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${name}
  `;
  return rows[0];
}

describe('add_call_linkage migration', () => {
  it('adds call_transcripts.recording_url as nullable text', async () => {
    const col = await column('call_transcripts', 'recording_url');

    expect(col?.data_type).toBe('text');
    // A signed storage URL has no length this codebase gets to decide.
    expect(col?.character_maximum_length).toBeNull();
    expect(col?.is_nullable).toBe('YES');
  });

  it('adds patients.vapi_call_id as nullable varchar(128)', async () => {
    const col = await column('patients', 'vapi_call_id');

    expect(col?.data_type).toBe('character varying');
    expect(col?.character_maximum_length).toBe(128);
    // Nullable by design: a REST-created patient came from no call.
    expect(col?.is_nullable).toBe('YES');
  });

  it('indexes patients(vapi_call_id) — the transcript link is a lookup on it', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'patients' AND indexname = 'patients_vapi_call_id_idx'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('(vapi_call_id)');
  });

  it('leaves patients(vapi_call_id) NON-unique — one call can register a family', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'patients' AND indexname = 'patients_vapi_call_id_idx'
    `;

    expect(rows[0]?.indexdef).not.toContain('UNIQUE');
  });
});
