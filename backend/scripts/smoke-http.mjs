import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Requires npm run build first. No provider keys or paid calls; only local replay.
const token = randomBytes(24).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'supply-http-smoke-'));
const port = Number(process.env.RESEARCH_SMOKE_PORT ?? 3137);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid RESEARCH_SMOKE_PORT');
const base = `http://127.0.0.1:${port}`;
// Provider keys are blanked so the BOM route check below can never start a paid live estimate.
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { env: { ...process.env, RESEARCH_API_TOKEN: token, RESEARCH_RUNS_DIR: directory, OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', TAVILY_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; let serverError;
server.on('error', error => { serverError = error; });
server.stdout.on('data', data => { logs = (logs + data).slice(-8000); });
server.stderr.on('data', data => { logs = (logs + data).slice(-8000); });
const request = (path, options = {}) => fetch(`${base}/v1/${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(5000) });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`Next.js exited: ${logs}`);
    try { const r = await request('runs'); if (r.ok) { ready = true; break; } } catch { /* startup */ }
    await delay(100);
  }
  assert.ok(ready, `Next.js did not become ready: ${logs}`);
  assert.equal((await fetch(`${base}/v1/runs`)).status, 401);
  const response = await request('runs', { method: 'POST', body: JSON.stringify({ product: 'Raspberry Pi 5', company: 'Raspberry Pi', mode: 'replay' }), headers: { 'Idempotency-Key': 'http-smoke' } });
  assert.equal(response.status, 202, await response.clone().text());
  let run = await response.json();
  for (let i = 0; i < 100 && run.status === 'running'; i++) { await delay(50); run = await (await request(`runs/${run.id}`)).json(); }
  assert.equal(run.status, 'completed');
  const graph = await (await request(`graphs/${run.graph_id}/export`)).json();
  assert.equal(graph.edges.length, 3); assert.equal(graph.mode, 'replay');
  for (const edge of graph.edges) {
    assert.ok(edge.source.length > 0);
    assert.match(edge.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(edge.time, /^\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(edge.confidence >= 0 && edge.confidence <= 1);
    assert.equal(edge.confidence_details.method.name, 'edge_evidence_v1');
  }
  const stream = await (await request(`runs/${run.id}/events`)).text();
  assert.match(stream, /event: run.completed/); assert.match(stream, /event: claim.committed/);
  // BOM route wiring: validation and configuration errors only; no provider keys, so no live estimate can start.
  const bomInvalid = await request('bom', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(bomInvalid.status, 400, await bomInvalid.clone().text());
  const bomUnconfigured = await request('bom', { method: 'POST', body: JSON.stringify({ description: 'Raspberry Pi 5' }) });
  assert.equal(bomUnconfigured.status, 503, await bomUnconfigured.clone().text());
  assert.equal((await request('bom/bom_00000000000000000000000000000000')).status, 404);
  console.log(JSON.stringify({ status: 'passed', mode: 'replay', run_id: run.id, nodes: graph.nodes.length, edges: graph.edges.length, bom_routes: 'validated 400/503/404 without provider keys', artifacts: join(directory, run.id) }, null, 2));
} finally {
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 3000); force.unref();
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  clearTimeout(force);
}
