import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { runResearch } from './research/engine';

try { loadEnvFile(resolve('.env.local')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const help = `Supply-chain research (run from backend/)\n\n  npm run demo\n  npm run research -- --product "Raspberry Pi 5" --company "Raspberry Pi"\n  npm run research -- --input examples/raspberry-pi-5.json --mode live\n\nOptions:\n  --input FILE          JSON: product, company?, seed_urls?, bom?, limits?\n  --product NAME        Overrides product in input file\n  --company NAME        Optional company context; creates no assumed relation\n  --seed URL            Repeatable source URLs (Tavily extracts in live mode)\n  --mode live|replay    Default live; replay is the curated Pi 5 fixture only\n  --out DIRECTORY       Run root; a unique run directory is created inside it\n  --max-hops N          Discovery radius (1–4)\n  --max-seconds N       Wall-clock deadline (1–900)\n  --max-cost-minor N    Conservative USD-cent request-reservation ceiling\n  --help               Show this message\n\nLive mode requires the selected model key (OPENAI_API_KEY or OPENROUTER_API_KEY)\nand TAVILY_API_KEY. Set RESEARCH_MODEL_PROVIDER=openrouter to use OpenRouter. Histories and graphs stay\non disk; progress goes to stderr, final artifact paths to stdout. Ctrl-C keeps\ncommitted findings. Exit: 0 completed/partial, 1 failed/config error, 130 cancelled.\n`;
async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, input: { type: 'string' }, product: { type: 'string' }, company: { type: 'string' }, seed: { type: 'string', multiple: true }, mode: { type: 'string', default: 'live' }, out: { type: 'string' }, 'max-hops': { type: 'string' }, 'max-seconds': { type: 'string' }, 'max-cost-minor': { type: 'string' } } });
  if (values.help) { process.stdout.write(help); return; }
  if (values.mode !== 'live' && values.mode !== 'replay') throw new Error('--mode must be live or replay');
  const input = values.input ? JSON.parse(await readFile(resolve(values.input), 'utf8')) : {};
  if (values.product) input.product = values.product;
  if (values.company) input.company = values.company;
  if (values.seed) input.seed_urls = values.seed;
  input.limits ??= {};
  for (const name of ['max-hops', 'max-seconds', 'max-cost-minor'] as const) if (values[name] !== undefined) input.limits[name.replaceAll('-', '_')] = Number(values[name]);
  const controller = new AbortController();
  const cancel = () => { process.stderr.write('\nCancelling; keeping committed findings…\n'); controller.abort(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runResearch(input, { mode: values.mode, root: values.out, signal: controller.signal,
      onCreated: (run, dir) => process.stderr.write(`Run ${run.id}\nHistory: ${dir}/history.jsonl\nEvents:  ${dir}/events.jsonl\n`),
      onEvent: event => { if (['task.started', 'source.retrieved', 'source.failed', 'claim.committed', 'claim.rejected', 'run.completed'].includes(event.type)) process.stderr.write(`[${event.seq}] ${event.type} ${JSON.stringify(event.payload)}\n`); },
    });
    process.stdout.write(JSON.stringify({ run_id: result.run.id, status: result.run.status, stop_reason: result.run.stop_reason, mode: result.run.mode, stats: result.graph.stats, graph: `${result.directory}/graph.json`, view: `${result.directory}/graph.html`, markdown: `${result.directory}/graph.md`, history: `${result.directory}/history.jsonl`, events: `${result.directory}/events.jsonl`, open_questions: result.run.open_questions }, null, 2) + '\n');
    process.exitCode = result.run.status === 'failed' ? 1 : result.run.status === 'cancelled' ? 130 : 0;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(error => { process.stderr.write(`Research failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
