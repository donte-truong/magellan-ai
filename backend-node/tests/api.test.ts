import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handle } from '../src/server/api';
import type { Graph, Run } from '../src/research/schema';

test('HTTP API enforces auth, validates requests, persists idempotency, exposes graph evidence, and replays SSE cursor', async () => {
  const oldToken = process.env.RESEARCH_API_TOKEN; const oldRoot = process.env.RESEARCH_RUNS_DIR;
  process.env.RESEARCH_RUNS_DIR = await mkdtemp(join(tmpdir(), 'supply-api-test-'));
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => new Request(`http://localhost/v1/${path}`, { method, headers: { Authorization: 'Bearer local-test-token', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    delete process.env.RESEARCH_API_TOKEN;
    assert.equal((await handle(request('runs'), ['runs'])).status, 503);
    process.env.RESEARCH_API_TOKEN = 'local-test-token';
    assert.equal((await handle(new Request('http://localhost/v1/runs'), ['runs'])).status, 401);
    assert.equal((await handle(request('runs', 'POST', { product: 'Other', mode: 'replay' }), ['runs'])).status, 400);
    const body = { product: 'Raspberry Pi 5', mode: 'replay' };
    const response = await handle(request('runs', 'POST', body, { 'Idempotency-Key': 'same-run' }), ['runs']);
    assert.equal(response.status, 202);
    const initial = await response.json() as Run;
    let run = initial;
    for (let i = 0; i < 100 && run.status === 'running'; i++) {
      await new Promise(res => setTimeout(res, 10));
      run = await (await handle(request(`runs/${run.id}`), ['runs', run.id])).json() as Run;
    }
    assert.equal(run.status, 'completed');
    const again = await handle(request('runs', 'POST', body, { 'Idempotency-Key': 'same-run' }), ['runs']);
    assert.equal(again.status, 200); assert.equal((await again.json()).id, run.id);
    assert.equal((await handle(request('runs', 'POST', { ...body, limits: { max_hops: 1 } }, { 'Idempotency-Key': 'same-run' }), ['runs'])).status, 409);
    const graph = await (await handle(request(`graphs/${run.graph_id}`), ['graphs', run.graph_id])).json() as Graph;
    assert.equal(graph.edges.length, 3);
    const edge = await (await handle(request(`graphs/${run.graph_id}/edges/${graph.edges[0].id}`), ['graphs', run.graph_id, 'edges', graph.edges[0].id])).json();
    assert.ok(edge.claims[0].evidence[0].source.content_hash);
    assert.equal(typeof edge.confidence, 'number'); assert.ok(edge.source.length); assert.ok(edge.date && edge.time);
    const graphPath = join(process.env.RESEARCH_RUNS_DIR!, run.id, 'graph.json');
    const eventPath = join(process.env.RESEARCH_RUNS_DIR!, run.id, 'events.jsonl');
    const oldGraph = JSON.parse(await readFile(graphPath, 'utf8'));
    const oldEvents = (await readFile(eventPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const removeMetadata = (edge: Record<string, unknown>) => { for (const field of ['source', 'date', 'time', 'confidence', 'confidence_details']) delete edge[field]; };
    oldGraph.edges.forEach(removeMetadata);
    for (const event of oldEvents) if (event.payload.edge) removeMetadata(event.payload.edge);
    await writeFile(graphPath, JSON.stringify(oldGraph));
    await writeFile(eventPath, oldEvents.map(event => JSON.stringify(event)).join('\n') + '\n');
    const hydrated = await (await handle(request(`graphs/${run.graph_id}/export`), ['graphs', run.graph_id, 'export'])).json();
    assert.deepEqual(hydrated.edges[0], graph.edges[0]);
    assert.equal(JSON.parse(await readFile(graphPath, 'utf8')).edges[0].confidence, undefined);
    const sse = await handle(request(`runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': '4' }), ['runs', run.id, 'events']);
    const stream = await sse.text();
    assert.ok(!stream.includes('id: 4\n')); assert.match(stream, /id: 5\n/); assert.match(stream, /event: run.completed/);
    const streamedEdges = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(event => event.payload.edge);
    assert.ok(streamedEdges.length > 0);
    for (const event of streamedEdges) { assert.equal(typeof event.payload.edge.confidence, 'number'); assert.ok(event.payload.edge.source.length); }
    assert.ok(!(await readFile(eventPath, 'utf8')).includes('confidence_details'));
    assert.equal((await handle(request(`graphs/${run.graph_id}?revision=0`), ['graphs', run.graph_id])).status, 409);
    const cancel = await handle(request(`runs/${run.id}/cancel`, 'POST', {}), ['runs', run.id, 'cancel']);
    assert.equal((await cancel.json()).cancellation_requested, false);
    const history = await readFile(join(process.env.RESEARCH_RUNS_DIR!, run.id, 'history.jsonl'), 'utf8');
    assert.ok(!history.includes('local-test-token'));
  } finally {
    if (oldToken === undefined) delete process.env.RESEARCH_API_TOKEN; else process.env.RESEARCH_API_TOKEN = oldToken;
    if (oldRoot === undefined) delete process.env.RESEARCH_RUNS_DIR; else process.env.RESEARCH_RUNS_DIR = oldRoot;
  }
});
