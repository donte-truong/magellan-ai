import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Budget, Stop } from '../src/research/budget';
import { LiveProvider, type ModelRequest } from '../src/research/providers';
import { hash, id, inputSchema } from '../src/research/schema';
import { RunStore } from '../src/research/store';
import { generateBom, rankHits, type BomOptions } from '../src/bom/pipeline';
import { handle, readBomBody } from '../src/server/api';
import type { Bom } from '../src/bom/schema';

const temp = () => mkdtemp(join(tmpdir(), 'supply-bom-test-'));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const productPage = 'Sensor One developer kit. The board contains the Atlas A1 processor and ships with a USB-C cable.';
const teardownPage = 'Teardown of the Sensor One reveals an OLED display module connected by a ribbon cable to the main board.';
const pages: Record<string, string> = { 'https://manufacturer.org/sensor-one': productPage, 'https://teardown.org/sensor-one': teardownPage };

function fakeProvider(calls: ModelRequest<unknown>[]): NonNullable<BomOptions['providerFactory']> {
  return (budget, store) => ({
    mode: 'live',
    async search(query) { budget.retrieval('searches', false); await store.trace('search', 'synthetic', { query }); return [{ url: 'https://teardown.org/sensor-one', title: 'Sensor One teardown', snippet: 'Inside the Sensor One: an Atlas A1 and an OLED display.' }, { url: 'https://youtube.com/watch?v=1', title: 'Video', snippet: 'unboxing video' }]; },
    async fetch(url) {
      budget.retrieval('documents', false);
      const text = pages[url]; if (!text) throw new Error('Source extraction unavailable or empty');
      return { text, source: { id: id('src'), url, title: null, publisher: 'synthetic', published_at: null, retrieved_at: new Date().toISOString(), content_hash: hash(text), source_family_id: 'family_synthetic', kind: 'other', license_notes: 'Synthetic test data' } };
    },
    async model<T>(): Promise<T> { throw new Error('research stages are not used by the BOM pipeline'); },
    async respond<T>(request: ModelRequest<T>): Promise<T> {
      budget.reserveModel(request.input, 100, false); calls.push(request as ModelRequest<unknown>);
      await store.trace(request.stage, 'synthetic_test_output', { has_images: !!request.images?.length });
      return request.schema.parse(output(request.stage, request.input));
    },
  });
}
function output(stage: string, input: unknown): unknown {
  if (stage === 'bom.vision') return { product_guess: 'Sensor One', brand_guess: 'Sensorly', category: 'sensor developer kit', visible_text: ['SENSOR ONE'], visible_items: [{ name: 'Black plastic enclosure', category: 'component', material: 'ABS plastic', notes: 'matte finish' }], notes: 'Clear photo of the kit.' };
  if (stage === 'bom.identify') return { product_name: 'Sensor One', brand: 'Sensorly', category: 'sensor developer kit', identifiers: ['SO-1'], summary: 'A small sensor development kit.', search_queries: ['Sensor One teardown'], ambiguity: null };
  if (stage === 'bom.extract') {
    const text = (input as { document: { text: string } }).document.text;
    if (text.includes('Atlas A1')) return { relevant: true, items: [
      { name: 'Atlas A1 processor', category: 'component', quantity: 1, unit: 'ea', material: null, manufacturer: 'Atlas Semiconductor', part_number: 'A1', notes: null, quote: 'contains the Atlas A1 processor' },
      // Fabricated quote: the pipeline must keep the item but downgrade its provenance.
      { name: 'Lithium battery', category: 'component', quantity: 1, unit: 'ea', material: null, manufacturer: null, part_number: null, notes: null, quote: 'a 3000 mAh lithium battery pack' },
    ] };
    return { relevant: true, items: [{ name: 'OLED display module', category: 'subassembly', quantity: 1, unit: 'ea', material: null, manufacturer: null, part_number: null, notes: null, quote: 'reveals an OLED display module' }] };
  }
  const { candidates, search_snippets } = input as { candidates: { id: string; name: string | null }[]; search_snippets: { id: string }[] };
  const ids = (...names: string[]) => names.map(name => candidates.find(c => c.name === name)?.id).filter((x): x is string => !!x);
  const item = (name: string, evidence_ids: string[], extra: Record<string, unknown> = {}) => ({ name, category: 'component', quantity: 1, unit: 'ea', material: null, manufacturer: null, part_number: null, parent_name: null, notes: null, evidence_ids, general_knowledge: false, confidence: 'high', ...extra });
  return { items: [
    item('Atlas A1 processor', ids('Atlas A1 processor'), { manufacturer: 'Atlas Semiconductor', part_number: 'A1' }),
    item('Lithium battery', [...ids('Lithium battery'), 'E999'], { general_knowledge: true, confidence: 'medium' }),
    item('OLED display module', [...ids('OLED display module'), ...search_snippets.slice(0, 1).map(s => s.id)], { category: 'subassembly' }),
    item('Black plastic enclosure', ids('Black plastic enclosure'), { material: 'ABS plastic', confidence: 'medium' }),
    item('Main PCB', [], { general_knowledge: true }),
    item('Atlas A1 processor', ids('Atlas A1 processor'), { notes: 'duplicate row that must merge' }),
    item('Display ribbon cable', ids('OLED display module'), { parent_name: 'OLED display module', confidence: 'medium' }),
  ], open_questions: ['Verify the battery capacity against the datasheet.'] };
}

test('BOM pipeline identifies the product from text, link and photo, verifies quotes, and labels every item with its provenance', async () => {
  const calls: ModelRequest<unknown>[] = [];
  const { bom, directory } = await generateBom({ description: 'Sensor One dev kit', url: 'https://manufacturer.org/sensor-one', image: { data: jpeg.toString('base64'), media_type: 'image/jpeg' }, company: 'Sensorly', limits: { max_searches: 2, max_documents: 3 } }, { root: await temp(), providerFactory: fakeProvider(calls) });
  assert.equal(bom.status, 'completed'); assert.equal(bom.stop_reason, 'finished');
  assert.equal(bom.product.name, 'Sensor One'); assert.deepEqual([...bom.product.identified_from].sort(), ['description', 'image', 'url']);
  assert.deepEqual(calls.map(c => c.stage), ['bom.vision', 'bom.identify', 'bom.extract', 'bom.extract', 'bom.compose']);
  assert.equal(calls[0].images?.length, 1); assert.ok(calls.slice(1).every(c => !c.images));
  assert.equal(bom.usage.searches, 2); assert.equal(bom.usage.documents, 2); assert.equal(bom.usage.model_calls, 5);
  assert.equal(bom.items.length, 6);
  const item = (name: string) => bom.items.find(i => i.name === name)!;
  const atlas = item('Atlas A1 processor');
  assert.equal(atlas.basis, 'evidenced'); assert.equal(atlas.confidence, 'high'); assert.equal(atlas.manufacturer, 'Atlas Semiconductor');
  assert.equal(atlas.sources.length, 1); const web = atlas.sources[0];
  assert.equal(web.type, 'web_page'); if (web.type !== 'web_page') return;
  const stored = await readFile(join(directory, 'sources', `${web.source_id}.txt`), 'utf8');
  const [, start, end] = /^text-utf16:(\d+)-(\d+);sha256=/.exec(web.locator)!;
  assert.equal(stored.slice(Number(start), Number(end)), web.quote); assert.equal(web.quote, 'contains the Atlas A1 processor');
  const battery = item('Lithium battery');
  assert.equal(battery.basis, 'inferred'); assert.deepEqual(battery.sources.map(s => s.type), ['web_page_unverified', 'model_knowledge']);
  const oled = item('OLED display module');
  assert.equal(oled.basis, 'evidenced'); assert.deepEqual(oled.sources.map(s => s.type), ['web_page', 'search_snippet']);
  const enclosure = item('Black plastic enclosure');
  assert.equal(enclosure.basis, 'inferred'); assert.equal(enclosure.sources[0].type, 'image_analysis');
  const pcb = item('Main PCB');
  assert.equal(pcb.basis, 'guessed'); assert.equal(pcb.confidence, 'medium'); assert.deepEqual(pcb.sources.map(s => s.type), ['model_knowledge']);
  assert.equal(item('Display ribbon cable').parent_item_id, oled.id);
  assert.ok(bom.open_questions.includes('Verify the battery capacity against the datasheet.'));
  assert.ok(bom.evidence.some(e => e.id === 'U1' && e.ref.type === 'user_input'));
  assert.ok(!bom.evidence.some(e => e.url?.includes('youtube.com')));
  const persisted = JSON.parse(await readFile(join(directory, 'bom.json'), 'utf8')) as Bom;
  assert.equal(persisted.id, bom.id); assert.equal(persisted.items.length, 6);
  const inputJson = await readFile(join(directory, 'input.json'), 'utf8');
  assert.ok(!inputJson.includes(jpeg.toString('base64'))); assert.match(inputJson, /sha256/);
  assert.equal((await stat(join(directory, 'input-image.jpg'))).size, jpeg.length);
  const history = await readFile(join(directory, 'history.jsonl'), 'utf8');
  assert.match(history, /unknown_evidence_ids_dropped/); assert.match(history, /E999/);
});
test('BOM pipeline keeps a truthful partial result when the final synthesis fails', async () => {
  const inner = fakeProvider([]);
  const { bom } = await generateBom({ description: 'Sensor One dev kit', url: 'https://manufacturer.org/sensor-one', limits: { max_searches: 1, max_documents: 2 } }, {
    root: await temp(), providerFactory: (budget, store) => {
      const provider = inner(budget, store);
      return { ...provider, async respond<T>(request: ModelRequest<T>, context: { task_id: string }): Promise<T> { if (request.stage === 'bom.compose') throw new Error('synthetic model outage'); return provider.respond(request, context); } };
    },
  });
  assert.equal(bom.status, 'partial'); assert.equal(bom.stop_reason, 'provider_or_workflow_error');
  assert.ok(bom.items.length >= 2); assert.ok(bom.items.every(i => i.basis !== 'guessed'));
  assert.ok(bom.open_questions.some(q => q.startsWith('Final synthesis did not run')));
  assert.ok(bom.open_questions.some(q => q.includes('synthetic model outage')));
});
test('BOM deadline interrupts a pending model call and leaves a readable partial estimate', async () => {
  const { bom } = await generateBom({ description: 'Sensor One', limits: { max_seconds: 1, max_searches: 0, max_documents: 0 } }, {
    root: await temp(), providerFactory: budget => ({
      mode: 'live', search: async () => [], fetch: async () => { throw new Error('unused'); },
      async model<T>(): Promise<T> { throw new Error('unused'); },
      async respond<T>(): Promise<T> {
        return new Promise((_, reject) => {
          const hold = setTimeout(() => reject(new Error('Deadline failed')), 3000);
          budget.signal.addEventListener('abort', () => { clearTimeout(hold); reject(new Stop('max_seconds')); }, { once: true });
        });
      },
    }),
  });
  assert.equal(bom.status, 'partial'); assert.equal(bom.stop_reason, 'max_seconds'); assert.equal(bom.items.length, 0);
});
test('search ranking skips video/social hosts and prefers teardown and brand domains', () => {
  const hit = (url: string, query = 'q') => ({ hit: { url, title: 't', snippet: 's' }, query });
  const ranked = rankHits([hit('https://youtube.com/watch?v=1'), hit('https://blog.org/post'), hit('https://www.ifixit.com/Teardown/x'), hit('https://sensorly.com/specs'), hit('https://blog.org/post', 'other')], 'Sensorly');
  assert.deepEqual(ranked.map(r => r.hit.url), ['https://www.ifixit.com/Teardown/x', 'https://sensorly.com/specs', 'https://blog.org/post']);
});
test('BOM HTTP route validates JSON and multipart input, requires provider configuration, and serves persisted estimates', async () => {
  const saved = { token: process.env.RESEARCH_API_TOKEN, root: process.env.RESEARCH_RUNS_DIR, openai: process.env.OPENAI_API_KEY, tavily: process.env.TAVILY_API_KEY };
  const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  process.env.RESEARCH_API_TOKEN = 'local-test-token'; process.env.RESEARCH_RUNS_DIR = await temp();
  delete process.env.OPENAI_API_KEY; delete process.env.TAVILY_API_KEY;
  const request = (path: string, method = 'GET', body?: BodyInit, headers: Record<string, string> = {}) => new Request(`http://localhost/v1/${path}`, { method, headers: { Authorization: 'Bearer local-test-token', ...headers }, ...(body !== undefined ? { body } : {}) });
  const jsonRequest = (body: unknown) => request('bom', 'POST', JSON.stringify(body), { 'Content-Type': 'application/json' });
  try {
    assert.equal((await handle(new Request('http://localhost/v1/bom', { method: 'POST' }), ['bom'])).status, 401);
    assert.equal((await handle(jsonRequest({}), ['bom'])).status, 400);
    assert.equal((await handle(jsonRequest({ description: 'x', image: { data: 'not base64!!', media_type: 'image/png' } }), ['bom'])).status, 400);
    assert.equal((await handle(jsonRequest({ description: 'x', image: { data: jpeg.toString('base64'), media_type: 'image/png' } }), ['bom'])).status, 400);
    assert.equal((await handle(jsonRequest({ description: 'x', url: 'http://127.0.0.1/secret' }), ['bom'])).status, 400);
    assert.equal((await handle(jsonRequest({ description: 'Sensor One' }), ['bom'])).status, 503);
    const form = new FormData(); form.append('description', 'Sensor One'); form.append('limits', JSON.stringify({ max_documents: 1 })); form.append('image', new Blob([jpeg], { type: 'image/jpeg' }), 'kit.jpg');
    const parsed = await readBomBody(new Request('http://localhost/v1/bom', { method: 'POST', body: form })) as { description: string; limits: { max_documents: number }; image: { media_type: string; data: string } };
    assert.equal(parsed.description, 'Sensor One'); assert.equal(parsed.limits.max_documents, 1); assert.equal(parsed.image.media_type, 'image/jpeg'); assert.equal(parsed.image.data, jpeg.toString('base64'));
    const multipart = new FormData(); multipart.append('description', 'Sensor One'); multipart.append('image', new Blob([jpeg], { type: 'image/jpeg' }), 'kit.jpg');
    assert.equal((await handle(request('bom', 'POST', multipart), ['bom'])).status, 503);
    const { bom } = await generateBom({ description: 'Sensor One dev kit' }, { root: process.env.RESEARCH_RUNS_DIR, providerFactory: fakeProvider([]) });
    const read = await handle(request(`bom/${bom.id}`), ['bom', bom.id]);
    assert.equal(read.status, 200); assert.equal(((await read.json()) as Bom).id, bom.id);
    assert.equal((await handle(request('bom/bom_00000000000000000000000000000000'), ['bom', 'bom_00000000000000000000000000000000'])).status, 404);
    assert.equal((await handle(request('bom/..'), ['bom', '..'])).status, 404);
    const history = await handle(request(`bom/${bom.id}/history`), ['bom', bom.id, 'history']);
    assert.equal(history.status, 200); assert.match(history.headers.get('content-type') ?? '', /x-ndjson/);
  } finally {
    restore('RESEARCH_API_TOKEN', saved.token); restore('RESEARCH_RUNS_DIR', saved.root); restore('OPENAI_API_KEY', saved.openai); restore('TAVILY_API_KEY', saved.tavily);
  }
});
test('live provider sends inline images to the Responses API and never records their bytes', async () => {
  const originalFetch = globalThis.fetch; const saved = { openai: process.env.OPENAI_API_KEY, tavily: process.env.TAVILY_API_KEY };
  process.env.OPENAI_API_KEY = 'synthetic-openai-secret'; process.env.TAVILY_API_KEY = 'synthetic-tavily-secret';
  const store = new RunStore(await temp(), 'synthetic'); await store.init({}, {});
  const budget = new Budget(inputSchema.parse({ product: 'Sensor One' }).limits, { input: 75, output: 450, search: 2, extract: 2 }, new AbortController().signal);
  const provider = new LiveProvider(budget, store, { model: 'gpt-5.4-mini', verifierModel: 'gpt-5.4-mini', prices: budget.prices });
  let body: { input: { content: { type: string; image_url?: string }[] }[]; text: { format: { name: string; strict: boolean } } } | undefined;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ id: 'resp_img', status: 'completed', usage: { input_tokens: 900, output_tokens: 20 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ok: true }) }] }] }, { headers: { 'x-request-id': 'req-img' } }); };
  try {
    const data = jpeg.toString('base64');
    const result = await provider.respond({ stage: 'bom.vision', schema_name: 'bom_vision_test', instructions: 'test', schema: z.object({ ok: z.boolean() }).strict(), input: { description: 'kit' }, images: [{ media_type: 'image/jpeg', data, bytes: jpeg.length, sha256: hash('synthetic') }], max_output_tokens: 200 }, { task_id: 'test-task' });
    assert.deepEqual(result, { ok: true });
    assert.equal(body?.input[0].content[0].type, 'input_text'); assert.equal(body?.input[0].content[1].type, 'input_image');
    assert.equal(body?.input[0].content[1].image_url, `data:image/jpeg;base64,${data}`);
    assert.equal(body?.text.format.name, 'bom_vision_test'); assert.equal(body?.text.format.strict, true);
    assert.equal(budget.usage.input_tokens, 900);
    const history = await readFile(join(store.dir, 'history.jsonl'), 'utf8');
    assert.ok(!history.includes(data)); assert.match(history, /omitted from history/); assert.match(history, /resp_img/); assert.ok(!history.includes('synthetic-openai-secret'));
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
    if (saved.tavily === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = saved.tavily;
  }
});
