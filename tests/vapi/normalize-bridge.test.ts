// The normalization bridge — the contract prompts/intake-coordinator.md § 2.3
// depends on. The model sends what the caller SAID; this turns it into what the
// database stores, and passes the raw value through when it cannot.

import { describe, expect, it } from 'vitest';
import { normalizeToolArguments } from '../../src/vapi/normalize-bridge.js';

describe('normalizeToolArguments — spoken input to canonical form', () => {
  it('maps every spoken field the way the prompt promises', () => {
    const out = normalizeToolArguments({
      first_name: 'Sarah',
      last_name: 'my last name is spelled D-A-V-I-S, not D-A-V-I-E-S',
      date_of_birth: 'February fifteenth, ninety two',
      phone_number: 'nine oh two, five five five, oh one four seven',
      emergency_contact_phone: 'five one two, five five five, oh one four two',
      email: 'sarah dot davis at gmail dot com',
      zip_code: 'seven eight seven oh one',
      state: 'Texas',
      insurance_member_id: 'B C one two three four five',
    });

    expect(out).toEqual({
      first_name: 'Sarah',
      // The negation marker is what makes this work — the model must NOT
      // pre-resolve the spelling, or "Davies" is what reaches the server.
      last_name: 'Davis',
      date_of_birth: '02/15/1992',
      phone_number: '9025550147',
      emergency_contact_phone: '5125550142',
      email: 'sarah.davis@gmail.com',
      zip_code: '78701',
      state: 'TX',
      insurance_member_id: 'BC12345',
    });
  });

  it('leaves free-text fields completely untouched', () => {
    const free = {
      sex: 'Female',
      address_line_1: '4120 Guadalupe Street',
      address_line_2: 'Apartment 4B',
      city: 'Austin',
      insurance_provider: 'Blue Cross',
      emergency_contact_name: 'Mary Davis',
      preferred_language: 'English',
    };

    expect(normalizeToolArguments(free)).toEqual(free);
  });

  it('never introduces a key the model did not send', () => {
    expect(normalizeToolArguments({ first_name: 'Sarah' })).toEqual({ first_name: 'Sarah' });
    expect(normalizeToolArguments({})).toEqual({});
  });
});

describe('normalizeToolArguments — a null normalizer result passes the RAW value through', () => {
  // The whole point: Zod then produces the field-SPECIFIC message the model
  // needs for a targeted re-prompt. Dropping the key would produce "required",
  // and the model would re-collect from scratch.
  it.each([
    ['phone_number', 'five five five'],
    ['zip_code', 'one two three'],
    ['state', 'Austin, Texas'],
    ['email', 'not an email at all'],
    ['date_of_birth', 'sometime in the spring'],
  ])('%s keeps its raw value when normalization fails', (field, raw) => {
    expect(normalizeToolArguments({ [field]: raw })).toEqual({ [field]: raw });
  });
});

describe('normalizeToolArguments — non-string values', () => {
  it('passes an explicit null through so the nullable schema can clear the field', () => {
    expect(normalizeToolArguments({ email: null, insurance_provider: null })).toEqual({
      email: null,
      insurance_provider: null,
    });
  });

  it('passes numbers and objects through rather than crashing a normalizer', () => {
    expect(normalizeToolArguments({ zip_code: 78701, state: { code: 'TX' } })).toEqual({
      zip_code: 78701,
      state: { code: 'TX' },
    });
  });
});
