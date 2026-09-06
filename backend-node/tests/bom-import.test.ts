import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResearch, validateRequest } from '../src/research/engine';
import type { Provider } from '../src/research/providers';

function estimate() {
  const item = { id: 'item_chip', name: 'Sensor chip', category: 'component', quantity: 1, unit: 'ea', material: null, manufacturer: 'Example Semi', part_number: 'S1', parent_item_id: null as string | null, notes: null, basis: 'evidenced', confidence: 'high', sources: [{ type: 'web_page', source_id: 'src_1', url: 'https://example.org/spec', title: 'Specs', quote: 'Sensor contains the S1 chip.', locator: 'original-locator' }] };
  return { id: 'bom_test', status: 'completed', product: { name: 'Sensor', brand: 'Maker', summary: 'Original summary' }, items: [item, { ...item, id: 'item_die', name: 'Silicon die', parent_item_id: item.id, basis: 'guessed', confidence: 'low', sources: [] }], sources: [{ id: 'src_1', url: 'https://example.org/spec', publisher: 'Example', content_hash: 'original-hash' }], evidence: [{ original: 'snapshot retained' }], usage: { model_calls: 3 } };
}
test('rich BOM validation rejects mixed inputs, product mismatches, broken provenance and cycles', () => {
  const bom = estimate();
  const request = { product: 'Sensor', bom_estimate: bom };
  assert.deepEqual(validateRequest(request, 'live').bom_estimate, bom);
  assert.deepEqual(validateRequest(request, 'live').seed_urls, ['https://example.org/spec']);
  assert.throws(() => validateRequest({ ...request, bom: [{ component: 'X' }] }, 'live'), /not both/);
  assert.throws(() => validateRequest({ ...request, product: 'Other' }, 'live'), /must match/);
  assert.throws(() => validateRequest({ ...request, bom_estimate: { ...bom, sources: [] } }, 'live'), /missing source/);
  bom.items[0].parent_item_id = 'item_die';
  assert.throws(() => validateRequest(request, 'live'), /without cycles/);
  bom.items[0].parent_item_id = null;
  bom.items[1].id = bom.items[0].id;
  assert.throws(() => validateRequest(request, 'live'), /Duplicate BOM/);
  assert.throws(() => validateRequest({ product: 'Sensor', bom_estimate: { ...estimate(), sources: [{ id: 'src_1', url: 'http://localhost/secret' }] } }, 'live'), /local|public|unsafe/i);
});
test('rich BOM survives import, reaches the planner, and never promotes imported citations into verified evidence', async () => {
  const bom = estimate(); let planned: any;
  const provider: Provider = {
    mode: 'live',
    async search() { return []; },
    async fetch() { throw new Error('Synthetic source unavailable'); },
    async model(stage, schema, input) { planned = input; assert.equal(stage, 'plan'); return schema.parse({ tasks: [] }); },
  };
  const result = await runResearch({ product: 'Sensor', bom_estimate: bom }, { root: await mkdtemp(join(tmpdir(), 'bom-import-')), providerFactory: () => provider });
  assert.equal(result.graph.edges.length, 2);
  for (const edge of result.graph.edges) {
    assert.equal(edge.support_label, 'user_asserted'); assert.equal(edge.confidence, 0.25);
    assert.ok(edge.source.every(s => s.kind === 'upload'));
  }
  const imported = (result.graph.edges[0].data.custom as any).bom_estimate;
  assert.equal(imported.part_number, 'S1'); assert.equal(imported.confidence, 'high');
  assert.equal(imported.sources[0].locator, 'original-locator');
  assert.equal(imported.cited_source_metadata[0].content_hash, 'original-hash');
  assert.equal(planned.bom_estimate.items[1].parent_item_id, 'item_chip');
  assert.equal(planned.bom_estimate.items[0].manufacturer, 'Example Semi');
  const saved = JSON.parse(await readFile(join(result.directory, 'input.json'), 'utf8'));
  assert.deepEqual(saved.bom_estimate, bom);
  const events = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(e => e.type === 'edge.added').payload.edge.data.custom.bom_estimate.estimate_id, bom.id);
});
