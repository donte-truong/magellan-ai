import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Live integration exercise: uses configured providers and their normal budget.
// Starts its own localhost server and keeps the ephemeral API token out of logs.
loadEnvFile(resolve('.env.local'));
const bomPath = resolve(process.argv[2] ?? 'runs/bom_8d670889dbbb4acba697a3a243af4bd7/bom.json');
const bom = JSON.parse(await readFile(bomPath, 'utf8'));
const input = {
  mode: 'live', product: bom.product.name, ...(bom.product.brand ? { company: bom.product.brand } : {}),
  bom_estimate: bom,
  limits: { max_hops: 2, max_tasks: 6, max_searches: 6, max_documents: 8, max_model_calls: 30, max_seconds: 240, max_cost_minor: 100 },
};
const port = 3139;
const token = randomBytes(24).toString('hex');
const root = resolve(process.env.RESEARCH_RUNS_DIR ?? 'runs');
const report = join(root, `http-graph-${Date.now()}`);
await mkdir(report, { recursive: true });
await writeFile(join(report, 'request.json'), JSON.stringify(input, null, 2));
await writeFile(join(report, 'bom-mapping.json'), JSON.stringify({ source_bom: bomPath, source_bom_id: bom.id, note: 'Full original BOM submitted in bom_estimate; no client-side flattening.' }, null, 2));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, RESEARCH_API_TOKEN: token, RESEARCH_RUNS_DIR: root,
    BOM_RESPONSE_CAPTURE_DIR: join(report, 'model-responses'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${resolve('scripts/capture-model-response.mjs')}`,
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; let serverError;
server.on('error', e => { serverError = e; });
server.stdout.on('data', d => { logs = (logs + d).slice(-16000); });
server.stderr.on('data', d => { logs = (logs + d).slice(-16000); });
const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}/v1/${path}`, {
  ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  signal: AbortSignal.timeout(options.method === 'POST' ? ((input.limits?.max_seconds ?? 180) + 30) * 1000 : 10000),
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error('Temporary server exited before becoming ready');
    try { if ((await request('runs')).ok) { ready = true; break; } } catch { /* startup */ }
    await delay(200);
  }
  if (!ready) throw new Error('Temporary server did not become ready');
  console.log(`POST /v1/runs; model=${process.env.OPENROUTER_MODEL}; report=${report}`);
  const response = await request('runs', { method: 'POST', body: JSON.stringify(input) });
  const body = await response.text();
  await writeFile(join(report, 'launch.json'), body, { mode: 0o600 });
  console.log(`HTTP ${response.status}`);
  if (!response.ok) throw new Error(body);
  let run = JSON.parse(body);
  console.log(`run_id=${run.id}`);
  const until = Date.now() + (input.limits.max_seconds + 30) * 1000;
  while (run.status === 'running' || run.status === 'queued') {
    if (Date.now() > until) { await request(`runs/${run.id}/cancel`, { method: 'POST' }); throw new Error('HTTP test deadline; cancellation requested'); }
    await delay(2000);
    const status = await request(`runs/${run.id}`);
    if (!status.ok) throw new Error(`Status endpoint: ${status.status}`);
    run = await status.json();
  }
  await writeFile(join(report, 'run.json'), JSON.stringify(run, null, 2));
  for (const [path, file] of [[`graphs/${run.graph_id}/export`, 'graph.json'], [`graphs/${run.graph_id}/view`, 'graph.html'], [`runs/${run.id}/history`, 'history.jsonl'], [`runs/${run.id}/events`, 'events.sse']]) {
    const result = await request(path);
    if (!result.ok) throw new Error(`${path}: HTTP ${result.status}`);
    await writeFile(join(report, file), await result.text(), { mode: 0o600 });
  }
  const graph = JSON.parse(await readFile(join(report, 'graph.json'), 'utf8'));
  console.log(JSON.stringify({ run_id: run.id, status: run.status, stop_reason: run.stop_reason,
    nodes: graph.nodes.length, edges: graph.edges.length, support_labels: graph.edges.reduce((counts,e) => ({...counts, [e.support_label]: (counts[e.support_label] ?? 0) + 1}), {}),
    usage: run.usage, open_questions: run.open_questions, directory: join(root, run.id), report }, null, 2));
  if (run.status === 'failed') process.exitCode = 1;

} finally {
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 3000); force.unref();
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  clearTimeout(force);
  await writeFile(join(report, 'server.log'), logs, { mode: 0o600 });
}
