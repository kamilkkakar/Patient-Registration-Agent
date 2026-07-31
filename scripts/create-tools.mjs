// Creates the Vapi custom tools and wires them to the assistant.
//
// Run after the API is deployed and PUBLIC_BASE_URL is reachable.
//
// Two contract details that are easy to get wrong and expensive to debug over
// a phone call:
//
//   * NO canned `messages` on these tools. A `request-failed` message fires at
//     speech-precedence step 2 on EVERY error return and pre-empts the model,
//     which makes the challenge's per-field re-prompt unreachable no matter how
//     the prompt is worded. Error text comes back in the tool result instead and
//     the model speaks it in its own words.
//   * Field descriptions tell the model to pass through what the caller SAID.
//     The server normalizes ("nine oh two..." -> 9025550147). The model picks the
//     field; the server picks the format. Asking the model to format is what
//     produces non-deterministic parsing failures mid-call.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const { VAPI_API_KEY: KEY, VAPI_ASSISTANT_ID, VAPI_WEBHOOK_SECRET, PUBLIC_BASE_URL } = env;
for (const [k, v] of Object.entries({ KEY, VAPI_ASSISTANT_ID, VAPI_WEBHOOK_SECRET, PUBLIC_BASE_URL })) {
  if (!v) throw new Error(`missing ${k} in .env`);
}

async function api(method, path, body) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// Shared server config. timeoutSeconds above the 20s default: a cold container
// answering the first tool call of the day must not blow the deadline (G15).
const server = {
  url: `${PUBLIC_BASE_URL}/vapi/tool`,
  timeoutSeconds: 30,
  headers: { 'x-vapi-webhook-secret': VAPI_WEBHOOK_SECRET },
};

const SPOKEN = 'Pass through exactly what the caller said; the server normalizes it.';

const patientProps = {
  first_name: { type: 'string', description: `Caller's first name. ${SPOKEN} Spelled-out letters are fine.` },
  last_name: { type: 'string', description: `Caller's last name. ${SPOKEN} Spelled-out letters are fine.` },
  date_of_birth: { type: 'string', description: `Date of birth. ${SPOKEN} e.g. "February fifteenth ninety two".` },
  sex: { type: 'string', enum: ['Male', 'Female', 'Other', 'Decline to Answer'], description: 'One of the four options.' },
  phone_number: { type: 'string', description: `Phone number. ${SPOKEN} e.g. "nine oh two, five five five, oh one four seven".` },
  address_line_1: { type: 'string', description: 'Street address including number and street name.' },
  address_line_2: { type: 'string', description: 'Apartment, suite or unit. Omit entirely if not given.' },
  city: { type: 'string', description: 'City name.' },
  state: { type: 'string', description: `US state. ${SPOKEN} Full name like "Texas" is fine.` },
  zip_code: { type: 'string', description: `ZIP code. ${SPOKEN} Spoken digits are fine.` },
  email: { type: 'string', description: `Email. ${SPOKEN} e.g. "sarah dot davis at gmail dot com".` },
  insurance_provider: { type: 'string', description: 'Insurance company name. Omit if declined.' },
  insurance_member_id: { type: 'string', description: 'Member/subscriber ID. Omit if declined.' },
  preferred_language: { type: 'string', description: 'Preferred language. Omit if not given.' },
  emergency_contact_name: { type: 'string', description: 'Emergency contact full name. Omit if declined.' },
  emergency_contact_phone: { type: 'string', description: `Emergency contact phone. ${SPOKEN} Omit if declined.` },
};

const REQUIRED = [
  'first_name', 'last_name', 'date_of_birth', 'sex',
  'phone_number', 'address_line_1', 'city', 'state', 'zip_code',
];

const tools = [
  {
    type: 'function',
    server,
    function: {
      name: 'create_patient',
      description:
        'Save a new patient record. Call this ONLY after reading every collected field back to the caller and hearing them confirm. Omit optional fields the caller declined - never send empty strings or null.',
      parameters: { type: 'object', properties: patientProps, required: REQUIRED },
    },
  },
  {
    type: 'function',
    server,
    function: {
      name: 'lookup_patient_by_phone',
      description:
        'Check whether a patient already exists with this phone number. Returns patient_id, which is the only way to later call update_patient.',
      parameters: {
        type: 'object',
        properties: { phone_number: patientProps.phone_number },
        required: ['phone_number'],
      },
    },
  },
  {
    type: 'function',
    server,
    function: {
      name: 'update_patient',
      description:
        'Update an existing patient record. Requires patient_id from lookup_patient_by_phone. Send only the fields that are changing.',
      parameters: {
        type: 'object',
        properties: {
          patient_id: { type: 'string', description: 'The patient_id returned by lookup_patient_by_phone.' },
          ...patientProps,
        },
        required: ['patient_id'],
      },
    },
  },
];

console.log(`server.url = ${server.url}\n`);

// Remove any tools from a previous run so re-running does not accumulate
// duplicates the model then sees twice.
const existing = await api('GET', '/tool');
const ours = new Set(['create_patient', 'lookup_patient_by_phone', 'update_patient']);
if (Array.isArray(existing.json)) {
  for (const t of existing.json) {
    if (ours.has(t?.function?.name)) {
      const del = await api('DELETE', `/tool/${t.id}`);
      console.log(`deleted stale tool ${t.function.name} (${t.id}) -> ${del.status}`);
    }
  }
}

const toolIds = [];
for (const tool of tools) {
  const res = await api('POST', '/tool', tool);
  const name = tool.function.name;
  if (res.status !== 200 && res.status !== 201) {
    console.log(`FAILED ${name} (${res.status}):`, JSON.stringify(res.json).slice(0, 400));
    process.exit(1);
  }
  console.log(`created ${name} -> ${res.json.id}`);
  toolIds.push(res.json.id);
}

console.log('\n=== attach tools + event webhook to assistant ===');
const current = await api('GET', `/assistant/${VAPI_ASSISTANT_ID}`);
if (current.status !== 200) {
  console.log('could not read assistant:', current.status);
  process.exit(1);
}

const patch = await api('PATCH', `/assistant/${VAPI_ASSISTANT_ID}`, {
  model: { ...current.json.model, toolIds },
  // Assistant-level server receives the NON-tool events (end-of-call-report,
  // status-update, hang). Tool calls go to the tool-level url above; tool.server
  // wins for tool-calls only.
  server: {
    url: `${PUBLIC_BASE_URL}/vapi/events`,
    timeoutSeconds: 30,
    headers: { 'x-vapi-webhook-secret': VAPI_WEBHOOK_SECRET },
  },
});

console.log('status', patch.status);
console.log(
  JSON.stringify(
    {
      assistantId: patch.json.id,
      model: patch.json.model?.model,
      toolIds: patch.json.model?.toolIds,
      serverUrl: patch.json.server?.url,
      serverMessages: patch.json.serverMessages,
    },
    null,
    2
  )
);
