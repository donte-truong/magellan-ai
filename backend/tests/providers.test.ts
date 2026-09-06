import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../src/research/budget';
import { LiveProvider } from '../src/research/providers';
import { inputSchema, planSchema } from '../src/research/schema';
import { RunStore } from '../src/research/store';

test('live REST adapter validates real response shapes, never uses search snippets as documents, records safe audit data, and fails closed', async () => {
  const originalFetch = globalThis.fetch; const oldOpenAI = process.env.OPENAI_API_KEY; const oldTavily = process.env.TAVILY_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-openai-secret'; process.env.TAVILY_API_KEY = 'synthetic-tavily-secret';
  const root = await mkdtemp(join(tmpdir(), 'supply-provider-test-'));
  const store = new RunStore(root, 'synthetic'); await store.init({}, {});
  const b = new Budget(inputSchema.parse({ product: 'Sensor One' }).limits, { input: 75, output: 450, search: 2, extract: 2 }, new AbortController().signal);
  const provider = new LiveProvider(b, store, { model: 'gpt-5.4-mini', verifierModel: 'gpt-5.4-mini', prices: b.prices });
  const context = { task_id: 'test-task' };
  const calls: { url: string; body: any }[] = [];
  let responseStatus = 'completed'; let httpStatus = 200;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body });
    if (httpStatus !== 200) return new Response('provider error echo with private details', { status: httpStatus });
    if (String(url).endsWith('/search')) return Response.json({ request_id: 'tav-search', results: [{ url: 'https://manufacturer.org/spec', title: 'Product datasheet', content: 'This is only a search snippet.' }, { url: 'http://127.0.0.1', title: 'Bad URL', content: 'Bad' }], usage: { credits: 1 } });
    if (String(url).endsWith('/extract')) return Response.json({ request_id: 'tav-extract', results: [{ url: 'https://manufacturer.org/spec', raw_content: 'Sensor One contains the Atlas A1 processor.\r\nPublic specifications.' }], failed_results: [], usage: { credits: 0 } });
    return Response.json({ id: 'resp_test', status: responseStatus, usage: { input_tokens: 500, output_tokens: 150 }, output: [{ type: 'reasoning', summary: [{ text: 'Private internal reasoning must not be in history' }] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ tasks: [{ question: 'What components are used?', query: 'Sensor One official datasheet', reason: 'Seek first-party evidence.' }] }) }] }] }, { headers: { 'x-request-id': 'request-test' } });
  };
  try {
    const hits = await provider.search('Sensor One', context); assert.equal(hits.length, 1);
    const doc = await provider.fetch(hits[0].url, context);
    assert.ok(doc.text.includes('Public specifications')); assert.ok(!doc.text.includes(hits[0].snippet));
    assert.equal(doc.source.published_at, null);
    const plan = await provider.model('plan', planSchema, { product: 'Sensor One' }, context);
    assert.equal(plan.tasks.length, 1);
    const requestBody = calls.find(c => c.url.endsWith('/responses'))!.body;
    assert.equal(requestBody.store, false); assert.equal(requestBody.text.format.strict, true);
    assert.equal(requestBody.text.format.schema.additionalProperties, false);
    assert.ok(!('tools' in requestBody));
    assert.equal(b.usage.input_tokens, 500); assert.equal(b.usage.output_tokens, 150);
    responseStatus = 'incomplete';
    await assert.rejects(provider.model('plan', planSchema, {}, context), /no partial claims accepted/);
    httpStatus = 401; const before = calls.length;
    await assert.rejects(provider.search('retry must not occur', context), /Provider HTTP 401/);
    assert.equal(calls.length, before + 1);
    const history = await readFile(join(store.dir, 'history.jsonl'), 'utf8');
    assert.match(history, /resp_test/); assert.match(history, /request-test/); assert.match(history, /model_response/);
    assert.ok(!history.includes('synthetic-openai-secret')); assert.ok(!history.includes('synthetic-tavily-secret'));
    assert.ok(!history.includes('Private internal reasoning')); assert.ok(!history.includes('provider error echo'));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAI;
    if (oldTavily === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = oldTavily;
  }
});
