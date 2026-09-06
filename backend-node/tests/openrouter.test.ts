import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Budget } from '../src/research/budget';
import { assertLiveCredentials, LiveProvider, liveConfig } from '../src/research/providers';
import { hash, inputSchema, planSchema } from '../src/research/schema';
import { RunStore } from '../src/research/store';

const envNames = ['OPENROUTER_OUTPUT_MODE', 'RESEARCH_MODEL_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_VERIFIER_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_VERIFIER_MODEL', 'TAVILY_API_KEY', 'RESEARCH_INPUT_CENTS_PER_MILLION', 'RESEARCH_OUTPUT_CENTS_PER_MILLION'] as const;
function environment() {
  const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  envNames.forEach(name => { delete process.env[name]; });
  Object.assign(process.env, { RESEARCH_MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'synthetic-router-secret', OPENROUTER_MODEL: 'openai/gpt-4o-mini', TAVILY_API_KEY: 'synthetic-tavily-secret', RESEARCH_INPUT_CENTS_PER_MILLION: '75', RESEARCH_OUTPUT_CENTS_PER_MILLION: '450' });
  return () => { for (const name of envNames) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } };
}

test('OpenRouter JSON object mode supplies a schema prompt and still rejects invalid local output', async () => {
  const restore = environment(); const originalFetch = globalThis.fetch;
  try {
    process.env.OPENROUTER_OUTPUT_MODE = 'invalid'; assert.throws(liveConfig, /OUTPUT_MODE/);
    process.env.OPENROUTER_OUTPUT_MODE = 'json_object';
    const config = liveConfig();
    const store = new RunStore(await mkdtemp(join(tmpdir(), 'router-json-')), 'test'); await store.init({}, config);
    const budget = new Budget(inputSchema.parse({ product: 'Board' }).limits, config.prices, new AbortController().signal);
    const provider = new LiveProvider(budget, store, config);
    let valid = true;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.match(body.messages[0].content, /JSON Schema/);
      assert.match(body.messages[0].content, /"required":\["ok"\]/);
      assert.equal(body.provider.require_parameters, true);
      return Response.json({ id: 'test', model: body.model, usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ok: valid ? true : 'wrong-type' }) } }] });
    };
    const request = { stage: 'bom.identify', schema_name: 'test', instructions: 'Identify', input: {}, schema: z.object({ ok: z.boolean() }).strict(), max_output_tokens: 100 };
    assert.deepEqual(await provider.respond(request, { task_id: 'one' }), { ok: true });
    valid = false;
    await assert.rejects(provider.respond(request, { task_id: 'two' }), /boolean/);
    assert.match(await readFile(join(store.dir, 'history.jsonl'), 'utf8'), /wrong-type/);
  } finally { globalThis.fetch = originalFetch; restore(); }
});

test('OpenRouter configuration selects only its credentials/models and requires explicit tariffs', () => {
  const restore = environment();
  try {
    assert.doesNotThrow(() => assertLiveCredentials()); // No OpenAI key required.
    process.env.OPENAI_MODEL = 'must-not-be-used'; process.env.OPENAI_VERIFIER_MODEL = 'must-not-be-used';
    assert.equal(liveConfig().modelProvider, 'openrouter'); assert.equal(liveConfig().model, 'openai/gpt-4o-mini');
    assert.equal(liveConfig().verifierModel, 'openai/gpt-4o-mini');
    process.env.OPENROUTER_VERIFIER_MODEL = 'vendor/reviewer'; assert.equal(liveConfig().verifierModel, 'vendor/reviewer');
    delete process.env.OPENROUTER_API_KEY; assert.throws(() => assertLiveCredentials(), /Missing OPENROUTER_API_KEY/);
    delete process.env.RESEARCH_INPUT_CENTS_PER_MILLION; assert.throws(liveConfig, /conservative rates/);
    process.env.RESEARCH_INPUT_CENTS_PER_MILLION = '0'; assert.equal(liveConfig().prices.input, 0);
    process.env.OPENROUTER_MODEL = 'openrouter/auto'; assert.throws(liveConfig, /automatic routers/);
    delete process.env.OPENROUTER_MODEL; assert.throws(liveConfig, /Set OPENROUTER_MODEL/);
    process.env.RESEARCH_MODEL_PROVIDER = 'typo'; assert.throws(liveConfig, /must be openai or openrouter/);
    delete process.env.RESEARCH_MODEL_PROVIDER; delete process.env.OPENAI_MODEL; delete process.env.OPENAI_VERIFIER_MODEL;
    assert.equal(liveConfig().modelProvider, 'openai'); assert.equal(liveConfig().model, 'gpt-5.4-mini');
    assert.throws(() => assertLiveCredentials(), /Missing OPENAI_API_KEY/);
  } finally { restore(); }
});

test('OpenRouter transport supports research and vision, normalizes usage, isolates keys, and records sanitized routing metadata', async () => {
  const restore = environment(); const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_VERIFIER_MODEL = 'vendor/reviewer';
  const config = liveConfig();
  const store = new RunStore(await mkdtemp(join(tmpdir(), 'openrouter-test-')), 'synthetic'); await store.init({}, config);
  const budget = new Budget(inputSchema.parse({ product: 'Board' }).limits, config.prices, new AbortController().signal);
  const provider = new LiveProvider(budget, store, config);
  const calls: { url: string; body: any; key: string | null }[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, key: new Headers(init?.headers).get('authorization') });
    if (String(url).endsWith('/search')) return Response.json({ results: [], request_id: 'tav-test' });
    const output = body.response_format.json_schema.name === 'supply_plan' ? { tasks: [] } : { ok: true };
    return Response.json({ id: 'gen-router-test', model: body.model, provider: 'test-upstream', usage: { prompt_tokens: 800, completion_tokens: 100, cost: 0.00018 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output), reasoning: 'hidden-reasoning-sentinel', reasoning_details: [{ text: 'hidden-detail-sentinel' }] } }] }, { headers: { 'x-request-id': 'router-request' } });
  };
  try {
    assert.deepEqual(await provider.model('plan', planSchema, { product: 'Board' }, { task_id: 'plan' }), { tasks: [] });
    await provider.search('Board', { task_id: 'search' });
    const bytes = Buffer.from('synthetic-inline-image'); const data = bytes.toString('base64');
    const result = await provider.respond({ stage: 'bom.vision', schema_name: 'test_vision', instructions: 'Read image data', input: { description: 'Board' }, schema: z.object({ ok: z.boolean() }).strict(), role: 'verifier', max_output_tokens: 200, images: [{ media_type: 'image/png', data, bytes: bytes.length, sha256: hash(data) }, { url: 'https://manufacturer.org/photo.png' }] }, { task_id: 'vision' });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].key, 'Bearer synthetic-router-secret');
    assert.equal(calls[1].key, 'Bearer synthetic-tavily-secret');
    const body = calls[0].body;
    assert.equal(body.model, 'openai/gpt-4o-mini'); assert.equal(body.max_tokens, 1400);
    assert.equal(body.messages[0].role, 'system'); assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.provider.require_parameters, true); assert.equal(body.provider.allow_fallbacks, false);
    assert.deepEqual(body.provider.max_price, { prompt: 0.75, completion: 4.5 });
    assert.ok(!('tools' in body)); assert.ok(!('input' in body));
    assert.equal(calls[2].body.model, 'vendor/reviewer');
    assert.equal(calls[2].body.messages[1].content[1].image_url.url, `data:image/png;base64,${data}`);
    assert.equal(calls[2].body.messages[1].content[2].image_url.url, 'https://manufacturer.org/photo.png');
    assert.equal(budget.usage.input_tokens, 1600); assert.equal(budget.usage.output_tokens, 200);
    assert.equal(budget.usage.reserved_input_tokens, 1600);
    const trace = await readFile(join(store.dir, 'history.jsonl'), 'utf8');
    for (const secret of [data, 'synthetic-router-secret', 'synthetic-tavily-secret', 'hidden-reasoning-sentinel', 'hidden-detail-sentinel']) assert.ok(!trace.includes(secret));
    assert.match(trace, /omitted from history/); assert.match(trace, /test-upstream/); assert.match(trace, /reported_cost_usd/);
    assert.match(trace, /gen-router-test/); assert.match(trace, /router-request/); assert.match(trace, /model_provider/);
  } finally { globalThis.fetch = originalFetch; restore(); }
});

test('OpenRouter rejects truncated/refused/invalid/missing-usage/error responses without retry or schema repair', async () => {
  const restore = environment(); const originalFetch = globalThis.fetch;
  const config = liveConfig();
  const store = new RunStore(await mkdtemp(join(tmpdir(), 'openrouter-errors-')), 'synthetic'); await store.init({}, config);
  const budget = new Budget(inputSchema.parse({ product: 'Board' }).limits, config.prices, new AbortController().signal);
  const provider = new LiveProvider(budget, store, config);
  const normal = { id: 'gen-test', model: config.model, usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: '{"tasks":[]}' } }] };
  let payload: unknown = normal; let status = 200; let count = 0;
  globalThis.fetch = async () => { count++; return Response.json(payload, { status }); };
  try {
    const failures = [
      { ...normal, choices: [{ finish_reason: 'length', message: { content: '{"tasks":[]}' } }] },
      { ...normal, choices: [{ finish_reason: 'stop', message: { content: '{"tasks":[]}', refusal: 'Refused' } }] },
      { ...normal, choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] },
      { ...normal, choices: [{ finish_reason: 'stop', message: { content: '{"unexpected":true}' } }] },
      { ...normal, usage: null },
      { error: { code: 500, message: 'private-provider-error-sentinel' } },
    ];
    for (const failure of failures) { payload = failure; const before = count; await assert.rejects(provider.model('plan', planSchema, {}, { task_id: 'test' })); assert.equal(count, before + 1); }
    status = 401; const before = count;
    await assert.rejects(provider.model('plan', planSchema, {}, { task_id: 'test' }), /Provider HTTP 401/); assert.equal(count, before + 1);
    assert.ok(budget.usage.cost_minor > 0);
    assert.ok(!(await readFile(join(store.dir, 'history.jsonl'), 'utf8')).includes('private-provider-error-sentinel'));
  } finally { globalThis.fetch = originalFetch; restore(); }
});
