import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Document, Graph, Run, RunEvent } from './schema';
import { renderHtml, renderMarkdown } from './view';

export async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export class RunStore {
  readonly dir: string;
  private eventSeq = 0;
  private traceSeq = 0;
  private traceQueue: Promise<void> = Promise.resolve();
  constructor(root: string, readonly runId: string) { this.dir = join(/* turbopackIgnore: true */ root, runId); }
  async init(input: unknown, config: unknown) {
    await mkdir(join(this.dir, 'sources'), { recursive: true, mode: 0o700 });
    await atomicJson(join(this.dir, 'input.json'), input);
    await atomicJson(join(this.dir, 'config.json'), config);
    await writeFile(join(this.dir, 'events.jsonl'), '', { mode: 0o600 });
    await writeFile(join(this.dir, 'history.jsonl'), '', { mode: 0o600 });
  }
  trace(stage: string, event: string, detail: unknown): Promise<void> {
    // Appends are serialized so concurrent provider calls (parallel BOM extraction) never interleave lines.
    const line = JSON.stringify({ seq: ++this.traceSeq, at: new Date().toISOString(), stage, event, detail }) + '\n';
    const next = this.traceQueue.then(() => appendFile(join(this.dir, 'history.jsonl'), line));
    this.traceQueue = next.catch(() => undefined);
    return next;
  }
  async event(run: Run, graph: Graph, type: string, payload: Record<string, unknown>) {
    const event: RunEvent = { type, seq: ++this.eventSeq, run_id: run.id, graph_id: graph.id, revision: graph.revision, at: new Date().toISOString(), payload: { ...payload, mode: run.mode } };
    await appendFile(join(this.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    return event;
  }
  async document(doc: Document) {
    await writeFile(join(this.dir, 'sources', `${doc.source.id}.txt`), doc.text, { mode: 0o600 });
    await atomicJson(join(this.dir, 'sources', `${doc.source.id}.json`), doc.source);
  }
  async checkpoint(run: Run, graph: Graph, frontier: unknown) {
    await atomicJson(join(this.dir, 'graph.json'), graph);
    await atomicJson(join(this.dir, 'run.json'), run);
    await atomicJson(join(this.dir, 'frontier.json'), frontier);
  }
  async render(run: Run, graph: Graph) {
    await writeFile(join(this.dir, 'graph.html'), renderHtml(run, graph), { mode: 0o600 });
    await writeFile(join(this.dir, 'graph.md'), renderMarkdown(run, graph), { mode: 0o600 });
  }
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(/* turbopackIgnore: true */ path, 'utf8')) as T; }
