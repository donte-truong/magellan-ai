import { z } from 'zod';
import { Budget } from './budget';
import { hash, id, type Candidate, type Document } from './schema';
import { instructions, type Provider } from './providers';
import type { RunStore } from './store';

// Curated excerpts and hand-authored model outputs; NOT a recorded live run.
// Each source contributes fewer than 25 quoted words. Checked 2026-09-05.
const entries = [
  { url: 'https://www.raspberrypi.com/products/raspberry-pi-5/', title: 'Raspberry Pi 5', date: null,
    text: 'Raspberry Pi 5 features the Broadcom BCM2712 quad-core Arm Cortex A76 processor @ 2.4GHz',
    subject: { kind: 'component', label: 'Broadcom BCM2712' }, predicate: 'PART_OF', object: { kind: 'product', label: 'Raspberry Pi 5' }, scope_type: 'product', scope_entity: 'Raspberry Pi 5' },
  { url: 'https://www.raspberrypi.com/news/introducing-raspberry-pi-5/', title: 'Introducing: Raspberry Pi 5', date: '2023-09-28T00:00:00Z',
    text: 'Raspberry Pi 5 is built at the Sony UK Technology Centre',
    subject: { kind: 'facility', label: 'Sony UK Technology Centre' }, predicate: 'MANUFACTURES', object: { kind: 'product', label: 'Raspberry Pi 5' }, scope_type: 'product', scope_entity: 'Raspberry Pi 5' },
  { url: 'https://www.raspberrypi.com/news/explore-the-raspberry-pi-factory-floor-in-wales-uk/', title: 'Explore the Raspberry Pi factory floor in Wales, UK', date: '2023-08-01T00:00:00Z',
    text: 'We’re at the Sony UK Technology Centre in Wales.',
    subject: { kind: 'facility', label: 'Sony UK Technology Centre' }, predicate: 'LOCATED_IN', object: { kind: 'geography', label: 'Wales' }, scope_type: 'generic', scope_entity: null },
] as const;
export class ReplayProvider implements Provider {
  readonly mode = 'replay' as const;
  constructor(private budget: Budget, private store: RunStore) {}
  async search(query: string, context: { task_id: string }) {
    this.budget.retrieval('searches', false);
    const results = entries.map(e => ({ url: e.url, title: e.title, snippet: '[Curated replay discovery hint; never used as evidence]' }));
    await this.store.trace('search', 'replay_result', { ...context, query, results });
    return results;
  }
  async fetch(url: string, context: { task_id: string }): Promise<Document> {
    this.budget.retrieval('documents', false);
    const e = entries.find(x => x.url === url); if (!e) throw new Error('URL is not present in the curated replay fixture');
    const document: Document = { text: e.text, source: { id: id('src'), url, title: e.title, publisher: 'Raspberry Pi', published_at: e.date, retrieved_at: '2026-09-05T00:00:00Z', content_hash: hash(e.text), source_family_id: 'family_host_raspberrypi.com', kind: 'other', license_notes: 'Curated short excerpt, checked 2026-09-05. Replay verification is hand-authored; not a fresh model review or live fetch.' } };
    await this.store.trace('fetch', 'replay_result', { ...context, document });
    return document;
  }
  async model<T>(stage: keyof typeof instructions, schema: z.ZodType<T>, input: unknown, context: { task_id: string }): Promise<T> {
    this.budget.reserveModel(input, 1000, false);
    let result: unknown;
    if (stage === 'plan') result = { tasks: [{ question: 'Which components and manufacturing facilities are explicitly tied to Raspberry Pi 5?', query: 'Raspberry Pi 5 BCM2712 Sony UK Technology Centre primary sources', reason: 'Curated fixture demonstrates a component, manufacturing facility, and facility geography.' }] };
    else if (stage === 'extract') {
      const data = input as { document: { text: string } };
      const e = entries.find(e => data.document.text.includes(e.text));
      const candidates: Candidate[] = e ? [{ subject: e.subject, predicate: e.predicate, object: e.object, scope_type: e.scope_type, scope_entity: e.scope_entity, quote: e.text, polarity: 'supports', rationale: 'The curated official source excerpt explicitly states this relation.' }] : [];
      result = { candidates, gaps: ['Raw-material and semiconductor fabrication identities remain unverified.'] };
    } else {
      const data = input as { candidates: { index: number }[] };
      result = { verdicts: data.candidates.map(c => ({ index: c.index, entailed: true, scope_matches: true, entities_match: true, explanation: 'Hand-authored replay verdict for a curated exact excerpt; not live LLM verification.' })) };
    }
    await this.store.trace(stage, 'replay_result', { ...context, prompt_version: 'supply-evidence-v1', instructions: instructions[stage], input, result, fixture: 'raspberry-pi-5-curated-v1' });
    return schema.parse(result);
  }
}
