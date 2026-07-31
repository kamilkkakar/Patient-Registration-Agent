// Creates the patient-intake assistant from prompts/intake-coordinator.md and
// attaches it to the provisioned phone number for INBOUND routing.
//
// Inbound in Vapi == the phone number carries an assistantId. Without it an
// incoming call has nowhere to go. Outbound would be POST /call with a customer
// number, which is not what this challenge needs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLINIC_NAME = 'Northside Family Health';
// Matched to the voice. The first build used "Riley" with a female voice, which
// reads as a mismatch on the phone - the caller hears a woman introduce herself
// with a name that doesn't fit the voice, and it undercuts the persona in the
// first three seconds.
const AGENT_NAME = 'Nora';

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const KEY = env.VAPI_API_KEY;
if (!KEY) throw new Error('VAPI_API_KEY missing');

const PHONE_NUMBER_ID = env.VAPI_PHONE_NUMBER_ID;
if (!PHONE_NUMBER_ID) throw new Error('VAPI_PHONE_NUMBER_ID missing');

// Extract the system prompt between the artifact's markers, dropping fences.
const md = readFileSync(join(ROOT, 'prompts/intake-coordinator.md'), 'utf8').split(/\r?\n/);
const begin = md.findIndex((l) => l.includes('BEGIN SYSTEM PROMPT'));
const end = md.findIndex((l) => l.includes('END SYSTEM PROMPT'));
if (begin < 0 || end < 0) throw new Error('prompt markers not found');

const systemPrompt = md
  .slice(begin + 1, end)
  .filter((l) => !l.trimStart().startsWith('```'))
  .join('\n')
  .replaceAll('{{CLINIC_NAME}}', CLINIC_NAME)
  .replaceAll('{{AGENT_NAME}}', AGENT_NAME)
  .trim();

console.log(`system prompt: ${systemPrompt.length} chars`);
if (systemPrompt.includes('{{')) throw new Error('unreplaced placeholder remains');

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

const assistant = {
  name: 'patient-intake-coordinator',
  firstMessage: `Hello! Thanks for calling ${CLINIC_NAME}, this is ${AGENT_NAME}. I'd love to help you get registered as a new patient — is that what you're calling about today?`,
  model: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    // Low temperature: this is a data-collection task. Creativity here shows up
    // as invented field values and drifting off-script, not as better phrasing.
    temperature: 0.3,
    messages: [{ role: 'system', content: systemPrompt }],
  },
  // Savannah is the chosen voice (warm, natural). speed 1.0 = normal — do not
  // bump to 1.1; it reads faster and more robotic. Fallback candidates below
  // are only used if Savannah is rejected on first create.
  voice: { provider: 'vapi', voiceId: 'Savannah', speed: 1.0 },
  // Explicit, per the pinned contract: any array REPLACES the defaults wholesale.
  // conversation-update and transcript are omitted deliberately - huge volume,
  // and nothing in this build consumes live turns.
  serverMessages: ['tool-calls', 'end-of-call-report', 'status-update', 'hang'],
  // Lets the MODEL decide to hang up, which is the reliable mechanism. Relying on
  // endCallPhrases alone made the first live call limp: the model said "Take
  // care", which matched nothing, so the line stayed open through two more turns
  // until it happened to say "Goodbye". The caller had already said "bye bye".
  endCallFunctionEnabled: true,
  endCallMessage: `Thanks so much for calling ${CLINIC_NAME} — take care. Goodbye!`,
  // Kept as a backstop for when the model narrates a farewell instead of calling
  // the hangup function. Lowercase substring matches.
  endCallPhrases: ['goodbye', 'good bye', 'bye now', 'bye bye', 'take care now', 'have a great day'],
  // A registration call that runs past 10 minutes has gone wrong; cap the spend.
  maxDurationSeconds: 600,
  silenceTimeoutSeconds: 30,
  backgroundSound: 'off',
};

// Preferred voice is Savannah. Remaining names are create-time fallbacks only
// (Vapi rejects its retired legacy set at creation time).
const VOICE_PREFERRED = 'Savannah';
const VOICE_CANDIDATES = [VOICE_PREFERRED, 'Hana', 'Lily', 'Kylie', 'Neha', 'Elliot'];

// Re-running must UPDATE the assistant the phone number already points at.
// Creating a second one would leave the number wired to the stale config while
// everything here reports success.
const EXISTING_ID = env.VAPI_ASSISTANT_ID;
let created = null;

if (EXISTING_ID) {
  console.log(`\n=== PATCH /assistant/${EXISTING_ID} (updating in place) ===`);
  const current = await api('GET', `/assistant/${EXISTING_ID}`);
  if (current.status !== 200) {
    console.log('could not read existing assistant:', current.status);
    process.exit(1);
  }
  // Preserve what create-tools.mjs configured — toolIds live on model, and the
  // event webhook lives on server. PATCH replaces the whole `model` object, so
  // omitting toolIds (or sending []) silently unwires every tool while the API
  // still returns 200. That happened once: the assistant kept its new prompt and
  // lost the ability to save a patient.
  //
  // Only carry the key over when there is something to carry. Never send [].
  const priorToolIds = current.json.model?.toolIds;
  const hasTools = Array.isArray(priorToolIds) && priorToolIds.length > 0;

  const merged = {
    ...assistant,
    model: { ...assistant.model, ...(hasTools ? { toolIds: priorToolIds } : {}) },
    ...(current.json.server ? { server: current.json.server } : {}),
  };
  // Always pin Savannah + normal speed on update (do not inherit a faster speed).
  merged.voice = { provider: 'vapi', voiceId: VOICE_PREFERRED, speed: 1.0 };

  const patched = await api('PATCH', `/assistant/${EXISTING_ID}`, merged);
  if (patched.status !== 200) {
    console.log('PATCH failed:', patched.status, JSON.stringify(patched.json).slice(0, 600));
    process.exit(1);
  }
  console.log(`voice: ${patched.json.voice?.voiceId} | speed: ${patched.json.voice?.speed}`);

  // Re-READ rather than trusting the PATCH response. A 200 here has already
  // proven capable of hiding a broken assistant.
  const after = await api('GET', `/assistant/${EXISTING_ID}`);
  const nowTools = after.json?.model?.toolIds?.length ?? 0;
  const wasTools = hasTools ? priorToolIds.length : 0;
  console.log(`toolIds: ${wasTools} before -> ${nowTools} after`);
  if (nowTools < wasTools) {
    console.log('\nFATAL: tools were dropped by this update. Re-run scripts/create-tools.mjs.');
    process.exit(1);
  }
  if (nowTools === 0) {
    console.log('\nWARNING: assistant has NO tools attached. It cannot save a patient.');
    console.log('Run scripts/create-tools.mjs before calling the number.');
  }
  created = patched;
} else {
  console.log('\n=== POST /assistant (first run) ===');
  for (const voiceId of VOICE_CANDIDATES) {
    assistant.voice.voiceId = voiceId;
    const attempt = await api('POST', '/assistant', assistant);
    if (attempt.status === 200 || attempt.status === 201) {
      console.log(`voice "${voiceId}" accepted`);
      created = attempt;
      break;
    }
    const msg = typeof attempt.json === 'object' ? attempt.json.message : attempt.json;
    console.log(`voice "${voiceId}" rejected (${attempt.status}): ${String(msg).slice(0, 110)}`);
  }
  if (!created) {
    console.log('no candidate voice was accepted');
    process.exit(1);
  }
}
console.log('status', created.status);
const assistantId = created.json.id;
console.log('assistantId:', assistantId);
console.log('model:', created.json.model?.model, '| voice:', created.json.voice?.voiceId);

console.log('\n=== PATCH /phone-number (attach for INBOUND) ===');
const attached = await api('PATCH', `/phone-number/${PHONE_NUMBER_ID}`, { assistantId });
console.log('status', attached.status);
console.log(
  JSON.stringify(
    {
      number: attached.json.number,
      status: attached.json.status,
      assistantId: attached.json.assistantId,
      squadId: attached.json.squadId ?? null,
      serverUrl: attached.json.server?.url ?? null,
    },
    null,
    2
  )
);
