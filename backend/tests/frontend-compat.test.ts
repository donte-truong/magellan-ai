import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../src/server/api';
import type { Graph, Run } from '../src/research/schema';

type ClientRun = Run & { provider: string };
type Bom = { run_id: string; revision: number; provider: string; items: { node_id: string; name: string; kind: string; tier: number; parent_node_id: string; edge_id: string; quantity: number | null; support_label: string; evidence: { span: string; source: { url: string } | null }[] }[]; method: { name: string }; data_quality: { coverage_pct: number } };

test('frontend contract: decompose falls back to the curated replay without keys, runs carry provider, list exposes items, and the BOM view derives from the graph', async () => {
  const saved = { token: process.env.RESEARCH_API_TOKEN, root: process.env.RESEARCH_RUNS_DIR, openai: process.env.OPENAI_API_KEY, tavily: process.env.TAVILY_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, provider: process.env.RESEARCH_MODEL_PROVIDER };
  const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  process.env.RESEARCH_API_TOKEN = 'local-test-token'; process.env.RESEARCH_RUNS_DIR = await mkdtemp(join(tmpdir(), 'supply-compat-test-'));
  delete process.env.OPENAI_API_KEY; delete process.env.TAVILY_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.RESEARCH_MODEL_PROVIDER;
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => new Request(`http://localhost/v1/${path}`, { method, headers: { Authorization: 'Bearer local-test-token', ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    // Other products cannot be researched without provider keys; the message names the available example.
    const refused = await handle(request('bom/decompose', 'POST', { product: 'Unlisted test product 314159' }), ['bom', 'decompose']);
    assert.equal(refused.status, 503); assert.match((await refused.json()).error.message, /Raspberry Pi 5 curated example/);
    assert.equal((await handle(request('bom/decompose', 'POST', { product: '' }), ['bom', 'decompose'])).status, 400);
    assert.equal((await handle(request('bom/decompose', 'POST', { product: 'Raspberry Pi 5', mode: 'live' }), ['bom', 'decompose'])).status, 400);
    const started = await handle(request('bom/decompose', 'POST', { product: 'Raspberry Pi 5', company: '' }, { 'Idempotency-Key': 'compat-run' }), ['bom', 'decompose']);
    assert.equal(started.status, 202, await started.clone().text());
    let run = await started.json() as ClientRun;
    assert.equal(run.mode, 'replay'); assert.equal(run.provider, 'curated_fixture'); assert.equal(run.company, null);
    for (let i = 0; i < 200 && run.status === 'running'; i++) {
      await new Promise(res => setTimeout(res, 10));
      run = await (await handle(request(`runs/${run.id}`), ['runs', run.id])).json() as ClientRun;
    }
    assert.equal(run.status, 'completed'); assert.equal(run.provider, 'curated_fixture');
    const again = await handle(request('bom/decompose', 'POST', { product: 'Raspberry Pi 5', company: '' }, { 'Idempotency-Key': 'compat-run' }), ['bom', 'decompose']);
    assert.equal(again.status, 200); assert.equal((await again.json() as ClientRun).id, run.id);
    const list = await (await handle(request('runs?limit=5'), ['runs'])).json() as { runs: ClientRun[]; items: ClientRun[] };
    assert.equal(list.items.length, 1); assert.equal(list.items[0].id, run.id); assert.equal(list.items[0].provider, 'curated_fixture'); assert.deepEqual(list.items, list.runs);
    assert.equal((await handle(request('runs?limit=abc'), ['runs'])).status, 400);
    const graph = await (await handle(request(`graphs/${run.graph_id}`), ['graphs', run.graph_id])).json() as Graph;
    const bom = await (await handle(request(`runs/${run.id}/bom?revision=${graph.revision}`), ['runs', run.id, 'bom'])).json() as Bom;
    assert.equal(bom.run_id, run.id); assert.equal(bom.revision, graph.revision); assert.equal(bom.provider, 'curated_fixture'); assert.equal(bom.method.name, 'graph_dependency_edges_v1');
    assert.deepEqual(bom.items.map(i => i.name), ['Broadcom BCM2712', 'Sony UK Technology Centre']);
    const chip = bom.items[0];
    assert.equal(chip.kind, 'component'); assert.equal(chip.tier, 1); assert.equal(chip.parent_node_id, graph.root_node_id); assert.equal(chip.quantity, null);
    assert.equal(chip.support_label, 'directly_supported'); assert.ok(chip.evidence[0].span.includes('BCM2712')); assert.match(chip.evidence[0].source?.url ?? '', /^https:\/\//);
    assert.ok(graph.edges.some(e => e.id === chip.edge_id)); assert.equal(bom.data_quality.coverage_pct, 100);
    // Child reads pinned to an earlier revision are served from the latest graph; the whole-graph read stays strict.
    assert.equal((await handle(request(`graphs/${run.graph_id}/edges/${chip.edge_id}?revision=0`), ['graphs', run.graph_id, 'edges', chip.edge_id])).status, 200);
    assert.equal((await handle(request(`graphs/${run.graph_id}/export?revision=${graph.revision + 5}`), ['graphs', run.graph_id, 'export'])).status, 409);
    assert.equal((await handle(request(`graphs/${run.graph_id}?revision=0`), ['graphs', run.graph_id])).status, 409);
    const cancel = await (await handle(request(`runs/${run.id}/cancel`, 'POST', {}), ['runs', run.id, 'cancel'])).json() as ClientRun & { cancellation_requested: boolean };
    assert.equal(cancel.provider, 'curated_fixture'); assert.equal(cancel.cancellation_requested, false);
  } finally {
    restore('RESEARCH_API_TOKEN', saved.token); restore('RESEARCH_RUNS_DIR', saved.root); restore('OPENAI_API_KEY', saved.openai); restore('TAVILY_API_KEY', saved.tavily); restore('OPENROUTER_API_KEY', saved.openrouter); restore('RESEARCH_MODEL_PROVIDER', saved.provider);
  }
});
