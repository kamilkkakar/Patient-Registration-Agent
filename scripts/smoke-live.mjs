/**
 * Live production smoke — REST + Vapi tool path + assistant wiring.
 *
 * Usage: node scripts/smoke-live.mjs
 * Requires .env with VAPI_* and a reachable PUBLIC API (Railway).
 * Creates temporary patients and soft-deletes them.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const API = env.PUBLIC_BASE_URL?.replace(/\/$/, '') || 'https://api-production-10c0.up.railway.app';
const KEY = env.VAPI_API_KEY;
const SECRET = env.VAPI_WEBHOOK_SECRET;
const ASSISTANT = env.VAPI_ASSISTANT_ID;
const PHONE_ID = env.VAPI_PHONE_NUMBER_ID;

let failed = 0;
function pass(msg) {
  console.log(`PASS  ${msg}`);
}
function fail(msg) {
  failed += 1;
  console.error(`FAIL  ${msg}`);
}
function assert(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

async function tool(name, args, id) {
  const res = await fetch(`${API}/vapi/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-webhook-secret': SECRET },
    body: JSON.stringify({
      message: {
        type: 'tool-calls',
        call: { id: `smoke-${Date.now()}` },
        toolCallList: [{ id, function: { name, arguments: JSON.stringify(args) } }],
      },
    }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

console.log(`API ${API}\n`);

// Health + dashboard
{
  const h = await fetch(`${API}/health`).then((r) => r.json());
  assert(h.data?.status === 'ok' && h.data?.database === 'up', 'health');
  const dash = await fetch(`${API}/dashboard`).then((r) => r.text());
  assert(dash.includes('<th scope="col">Email</th>'), 'dashboard email column');
}

// Assistant wiring
{
  const a = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  }).then((r) => r.json());
  const sys = (a.model?.messages || []).find((m) => m.role === 'system')?.content || '';
  assert(a.model?.model === 'gpt-4.1-mini', `model ${a.model?.model}`);
  assert(a.voice?.voiceId === 'Savannah' && Number(a.voice?.speed) === 1, 'Savannah@1.0');
  assert(a.transcriber?.model === 'nova-3' && a.transcriber?.numerals === true, 'nova-3 numerals');
  assert((a.startSpeakingPlan?.transcriptionEndpointingPlan?.onNumberSeconds ?? 0) >= 1.4, 'digit patience');
  assert((a.model?.toolIds || []).length === 3, '3 tools attached');
  assert(sys.includes('When they confront') && sys.includes('Hard gate before optionals'), 'prompt gates');
  assert(/^Hello!/.test(a.firstMessage || ''), 'Hello firstMessage');

  const ph = await fetch(`https://api.vapi.ai/phone-number/${PHONE_ID}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  }).then((r) => r.json());
  assert(ph.assistantId === ASSISTANT && ph.number === '+16624438181', `phone ${ph.number}`);
}

// Voice tool path: spoken create → REST verify → update → delete
{
  const phoneDigits = `512555${String(Date.now()).slice(-4)}`;
  const created = await tool(
    'create_patient',
    {
      first_name: 'Smoke',
      last_name: 'Caller',
      date_of_birth: 'March twenty second ninety one',
      sex: "ma'am",
      phone_number: phoneDigits.split('').join(' '),
      email: 'smoke dot caller at gmail dot com',
      address_line_1: '100 Smoke Lane',
      city: 'Austin',
      state: 'Texas',
      zip_code: 'seven eight seven oh one',
    },
    'smoke-create',
  );
  assert(created.status === 200, 'create_patient HTTP 200');
  assert(/Registered|Already registered/i.test(created.body.results?.[0]?.result || ''), created.body.results?.[0]?.result);

  const list = await fetch(`${API}/patients`).then((r) => r.json());
  const row = (list.data || []).find((p) => p.phone_number === phoneDigits);
  assert(!!row, 'REST sees voice-created patient');
  if (row) {
    assert(row.sex === 'Female', `sex ${row.sex}`);
    assert(row.email === 'smoke.caller@gmail.com', `email ${row.email}`);
    assert(row.state === 'TX' && row.zip_code === '78701', `address ${row.state} ${row.zip_code}`);
    assert(row.date_of_birth === '03/22/1991', `dob ${row.date_of_birth}`);

    const upd = await tool('update_patient', { patient_id: row.patient_id, city: 'Round Rock' }, 'smoke-upd');
    assert(/Updated/i.test(upd.body.results?.[0]?.result || ''), 'update_patient');

    const del = await fetch(`${API}/patients/${row.patient_id}`, { method: 'DELETE' }).then((r) => r.json());
    assert(!!del.data?.deleted_at, 'soft-delete');
  }
}

// Field re-prompt (future DOB) returns error payload on 200
{
  const bad = await tool(
    'create_patient',
    {
      first_name: 'Future',
      last_name: 'Kid',
      date_of_birth: '01/01/2099',
      sex: 'Male',
      phone_number: '5125550123',
      address_line_1: '1 Future St',
      city: 'Austin',
      state: 'TX',
      zip_code: '78701',
    },
    'smoke-future',
  );
  assert(bad.status === 200, 'future DOB still HTTP 200');
  assert(/future/i.test(bad.body.results?.[0]?.error || ''), 'future DOB field error for model');
}

// Events webhook
{
  const ev = await fetch(`${API}/vapi/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-webhook-secret': SECRET },
    body: JSON.stringify({
      message: { type: 'status-update', status: 'in-progress', call: { id: `smoke-ev-${Date.now()}` } },
    }),
  });
  assert(ev.status === 200, 'events status-update 200');
}

// Seed patients remain
{
  const list = await fetch(`${API}/patients`).then((r) => r.json());
  const names = (list.data || []).map((p) => `${p.first_name} ${p.last_name}`);
  assert(names.includes('Sarah Davis'), 'seed Sarah present');
  assert(names.includes('James Jonathan'), 'SHIP-1 James present');
}

console.log(failed === 0 ? '\nSMOKE LIVE: ALL PASS' : `\nSMOKE LIVE: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
