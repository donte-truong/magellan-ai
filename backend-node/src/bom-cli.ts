import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { generateBom } from './bom/pipeline';
import { sniffImage } from './bom/schema';

try { loadEnvFile(resolve('.env.local')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const help = `Bill-of-materials estimate (run from backend/)\n\n  npm run bom -- --description "Raspberry Pi 5 8GB"\n  npm run bom -- --url https://www.raspberrypi.com/products/raspberry-pi-5/\n  npm run bom -- --image ./photo.jpg --description "board found in a drawer"\n\nOptions:\n  --description TEXT    Free-text product description\n  --url URL             Product page link (fetched through Tavily extract)\n  --image FILE          Photo (JPEG, PNG, WebP, GIF; at most 5 MB)\n  --image-url URL       Public photo URL passed to the vision model\n  --company NAME        Optional company context\n  --out DIRECTORY       Run root; a unique bom_… directory is created inside it\n  --max-searches N      Web searches (0–20, default 5)\n  --max-documents N     Pages to read (0–20, default 6)\n  --max-items N         Items in the final list (1–200, default 60)\n  --max-seconds N       Wall-clock deadline (1–600, default 180)\n  --max-cost-minor N    Conservative USD-cent reservation ceiling (default 300)\n  --help                Show this message\n\nRequires the selected model key (OPENAI_API_KEY or OPENROUTER_API_KEY) and\nTAVILY_API_KEY. Set RESEARCH_MODEL_PROVIDER=openrouter to use OpenRouter. Provide at least one of description, url,\nimage, or image-url. Every item records where the agent got it from; items with basis\n"guessed" have no retrieved source. Exit: 0 completed/partial, 1 failed, 130 cancelled.\n`;
async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, description: { type: 'string' }, url: { type: 'string' }, image: { type: 'string' }, 'image-url': { type: 'string' }, company: { type: 'string' }, out: { type: 'string' }, 'max-searches': { type: 'string' }, 'max-documents': { type: 'string' }, 'max-items': { type: 'string' }, 'max-seconds': { type: 'string' }, 'max-cost-minor': { type: 'string' } } });
  if (values.help) { process.stdout.write(help); return; }
  const request: Record<string, unknown> = {};
  if (values.description) request.description = values.description;
  if (values.url) request.url = values.url;
  if (values['image-url']) request.image_url = values['image-url'];
  if (values.company) request.company = values.company;
  if (values.image) {
    const buffer = await readFile(resolve(values.image));
    const media = sniffImage(buffer);
    if (!media) throw new Error('--image must be a JPEG, PNG, WebP, or GIF file');
    request.image = { data: buffer.toString('base64'), media_type: media };
  }
  const limits: Record<string, number> = {};
  for (const name of ['max-searches', 'max-documents', 'max-items', 'max-seconds', 'max-cost-minor'] as const) if (values[name] !== undefined) limits[name.replaceAll('-', '_')] = Number(values[name]);
  if (Object.keys(limits).length) request.limits = limits;
  const controller = new AbortController();
  const cancel = () => { process.stderr.write('\nCancelling; keeping the partial estimate…\n'); controller.abort(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const { bom, directory } = await generateBom(request, { root: values.out, signal: controller.signal, onProgress: (stage, detail) => process.stderr.write(`[${stage}] ${JSON.stringify(detail)}\n`) });
    const byBasis: Record<string, number> = {};
    for (const item of bom.items) byBasis[item.basis] = (byBasis[item.basis] ?? 0) + 1;
    process.stdout.write(JSON.stringify({ bom_id: bom.id, status: bom.status, stop_reason: bom.stop_reason, product: bom.product.name, items: bom.items.length, by_basis: byBasis, sources: bom.sources.length, usage: bom.usage, bom: `${directory}/bom.json`, history: `${directory}/history.jsonl`, open_questions: bom.open_questions }, null, 2) + '\n');
    process.exitCode = bom.status === 'failed' ? 1 : bom.status === 'cancelled' ? 130 : 0;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(error => { process.stderr.write(`BOM estimate failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
