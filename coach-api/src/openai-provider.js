import { snapshotExact, validateFraming, parseRequestJSON } from './contract.js';
import { purposeFor } from './rule-policy.js';
import { boundedOperation, SYSTEM_CLOCK, R3C2_B_PROVIDER_TIMEOUT_MS } from './provider.js';

// C1A is deliberately unwired. A future server composition must supply both dependencies.
const MODELS = Object.freeze({ economy: 'gpt-5.6-luna', balanced: 'gpt-5.6-terra', quality: 'gpt-5.6-sol' });
const ENDPOINT = 'https://api.openai.com/v1/responses';
const INSTRUCTIONS = 'Generate only short Traditional Chinese teacher framing. The deterministic R3C-1 teaching message is the sole chess authority. Do not analyze boards, calculate moves, judge move quality or invent chess facts. Do not mention check, mate, captures, score, PV, threats, winning, losing, correctness, model, provider or internal prompts. Return only the requested framing JSON with short neutral leadIn and encouragement.';
const INPUT_KEYS = Object.freeze(['sourceRuleId', 'locale', 'style', 'modelProfile', 'purpose']);

function failure() {
  // No cause, stack, upstream diagnostics or content crosses this boundary.
  return Object.freeze({ name: 'CoachProviderError', code: 'provider_unavailable', message: 'Provider unavailable' });
}

function requestBody(value) {
  const input = snapshotExact(value, INPUT_KEYS);
  if (!input || input.locale !== 'zh-Hant' || input.style !== 'child-neutral-teacher-v1'
    || typeof input.modelProfile !== 'string' || !Object.hasOwn(MODELS, input.modelProfile)
    || purposeFor(input.sourceRuleId) === null || input.purpose !== purposeFor(input.sourceRuleId)) throw failure();
  return {
    model: MODELS[input.modelProfile], store: false, reasoning: { effort: 'none' }, max_output_tokens: 128,
    instructions: INSTRUCTIONS, input: purposeFor(input.sourceRuleId),
    text: { format: { type: 'json_schema', name: 'review_coach_framing', strict: true,
      schema: { type: 'object', additionalProperties: false, required: ['leadIn', 'encouragement'],
        properties: { leadIn: { type: 'string', minLength: 1, maxLength: 24 },
          encouragement: { type: 'string', minLength: 1, maxLength: 24 } } } } },
  };
}

function parseResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.object !== 'response'
    || value.status !== 'completed' || value.error != null || value.incomplete_details != null
    || !Array.isArray(value.output) || value.output.length < 1 || value.output.length > 8) throw failure();
  let text = null;
  for (const item of value.output) {
    if (!item || typeof item !== 'object') throw failure();
    // Reasoning is opaque and never returned, concatenated or interpreted as framing.
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed'
      || !Array.isArray(item.content) || item.content.length !== 1 || text !== null) throw failure();
    const part = item.content[0];
    if (!part || part.type !== 'output_text' || typeof part.text !== 'string'
      || part.text.length > 1024) throw failure();
    text = part.text;
  }
  if (text === null) throw failure();
  // Flat parser rejects duplicate (including escaped duplicate) members before validation.
  const framing = validateFraming(parseRequestJSON(text));
  if (!framing) throw failure();
  return framing;
}

async function readResponse(response, signal) {
  if (response.status !== 200 || !response.body) throw failure();
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    if (signal.aborted) throw failure();
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw failure();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw failure();
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

export function createOpenAIProvider({ fetch: fetchImpl, apiKey, clock = SYSTEM_CLOCK } = {}) {
  if (typeof fetchImpl !== 'function' || typeof apiKey !== 'string'
    || apiKey.length < 1 || apiKey.length > 512 || /[^\x21-\x7e]/u.test(apiKey)) throw failure();
  return async (input, { signal } = {}) => {
    try {
      const body = requestBody(input);
      const result = await boundedOperation(async (requestSignal) => {
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: requestSignal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return readResponse(response, requestSignal);
      }, { clock, deadline: clock.now() + R3C2_B_PROVIDER_TIMEOUT_MS, parentSignal: signal });
      if (result.kind !== 'success') throw failure();
      return result.value;
    } catch {
      throw failure();
    }
  };
}
