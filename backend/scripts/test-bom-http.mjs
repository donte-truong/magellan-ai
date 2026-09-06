import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Live integration exercise: uses configured providers and their normal budget.
// Starts its own localhost server and keeps the ephemeral API token out of logs.
loadEnvFile(resolve('.env.local'));
const input = JSON.parse(await readFile(process.argv[2] ?? 'examples/bom-pico-2.json', 'utf8'));
const port = 3138;
const token = randomBytes(24).toString('hex');
const root = resolve(process.env.RESEARCH_RUNS_DIR ?? 'runs');
const report = join(root, `http-bom-${Date.now()}`);
await mkdir(report, { recursive: true });
await writeFile(join(report, 'request.json'), JSON.stringify(input, null, 2));
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
  console.log(`POST /v1/bom; model=${process.env.OPENROUTER_MODEL}; report=${report}`);
  const response = await request('bom', { method: 'POST', body: JSON.stringify(input) });
  const body = await response.text();
  await writeFile(join(report, 'response.json'), body, { mode: 0o600 });
  console.log(`HTTP ${response.status}`);
  const bom = JSON.parse(body);
  if (!response.ok) { console.log(JSON.stringify(bom)); process.exitCode = 1; }
  else {
    const reread = await request(`bom/${bom.id}`);
    const history = await request(`bom/${bom.id}/history`);
    await writeFile(join(report, 'history.jsonl'), await history.text(), { mode: 0o600 });
    console.log(JSON.stringify({ bom_id: bom.id, status: bom.status, stop_reason: bom.stop_reason, product: bom.product, items: bom.items.length, sources: bom.sources.length, usage: bom.usage, open_questions: bom.open_questions, persisted_get_status: reread.status, history_get_status: history.status, directory: join(root, bom.id) }, null, 2));
    if (bom.status !== 'completed') process.exitCode = 1;
  }
} finally {
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 3000); force.unref();
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  clearTimeout(force);
  await writeFile(join(report, 'server.log'), logs, { mode: 0o600 });
}
