import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeMetadata, ensureGraphEdgeMetadata } from '../src/research/edge-metadata';
import { dataLayers, type Claim, type Edge, type EdgeMetadata, type Graph, type Source } from '../src/research/schema';

function fixture(label: Edge['support_label'] = 'directly_supported') {
  const at = '2026-09-05T14:23:45.678Z';
  const edge: Omit<Edge, keyof EdgeMetadata> = { id: 'ed_test', source_node_id: 'nd_part', target_node_id: 'nd_product', predicate: 'PART_OF', scope: { type: 'product', product_node_id: 'nd_product' }, support_label: label, claim_ids: ['clm_1'], data: dataLayers(), rationale: 'test', caveats: [], evidence_summary: { source_count: 1, independent_family_count: 1, latest_published_at: null, has_contradiction: false } };
  const source: Source = { id: 'src_1', url: 'https://maker.org/spec', title: 'Specification', publisher: 'Maker', published_at: '2026-01-01T00:00:00Z', retrieved_at: at, content_hash: 'hash-1', source_family_id: 'family-1', kind: 'other', license_notes: null };
  const claim: Claim = { id: 'clm_1', subject_id: 'nd_part', object_id: 'nd_product', predicate: 'PART_OF', scope: edge.scope, status: 'accepted', support_label: label, rationale: 'Verified quote', observed_at: at, contradiction_claim_ids: [], resolution_notes: [], evidence: [{ id: 'ev_1', source_id: 'src_1', span: 'This part is in the product.', locator: 'text-utf16:0-28', support_type: 'supports', extracted_at: at }] };
  const graph = { claims: [claim], sources: [source], created_at: at, mode: 'live' as const };
  function add(n: number, family = `family-${n}`, content = `hash-${n}`, polarity: 'supports' | 'contradicts' = 'supports') {
    graph.sources.push({ ...source, id: `src_${n}`, url: `https://source${n}.org/spec`, source_family_id: family, content_hash: content });
    graph.claims.push({ ...claim, id: `clm_${n}`, evidence: [{ ...claim.evidence[0], id: `ev_${n}`, source_id: `src_${n}`, support_type: polarity }] });
    edge.claim_ids.push(`clm_${n}`);
  }
  return { edge, graph, source, claim, add };
}
test('edge metadata carries all provenance and stable UTC evidence timestamps, not publication time', () => {
  const f = fixture();
  f.claim.observed_at = '2026-09-05T12:23:45.678-04:00';
  const result = edgeMetadata(f.edge, f.graph);
  assert.equal(result.date, '2026-09-05'); assert.equal(result.time, '16:23:45.678Z');
  assert.equal(result.source[0].published_at, '2026-01-01T00:00:00Z');
  assert.deepEqual(result.source[0].support_types, ['supports']);
  assert.equal(result.confidence, 0.7); assert.equal(result.confidence_details.data_quality.calibrated, false);
  assert.deepEqual(edgeMetadata(f.edge, f.graph), result);
});
test('only distinct supporting families/content earn corroboration; contributions saturate', () => {
  const f = fixture();
  f.add(2, 'family-1'); assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.7);
  f.add(3, 'different-host', 'hash-1'); assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.7);
  f.add(4); assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.8);
  f.add(5); assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.9);
  f.add(6); assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.9);
  // A bridge between groups also deduplicates their transitive family/content links.
  f.add(7, 'family-4', 'hash-1');
  assert.equal(edgeMetadata(f.edge, f.graph).confidence_details.data_quality.supporting_families, 3);
});
test('unknown, future, and older publication dates reduce freshness without treating retrieval as publication', () => {
  const f = fixture();
  f.source.published_at = null; assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.65);
  f.source.published_at = '2030-01-01T00:00:00Z'; assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.65);
  f.source.published_at = '2023-01-01T00:00:00Z'; assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.6);
  f.source.published_at = '2019-01-01T00:00:00Z'; assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.5);
});
test('contradictions stay in source metadata and cap confidence even with corroboration', () => {
  const f = fixture(); f.add(2); f.add(3); f.add(4, 'contrary-family', 'contrary-content', 'contradicts');
  const scored = edgeMetadata(f.edge, f.graph);
  assert.equal(scored.confidence, 0.25); assert.equal(scored.source.length, 4);
  assert.deepEqual(scored.source.find(s => s.id === 'src_4')!.support_types, ['contradicts']);
  assert.equal(scored.confidence_details.factors.contradiction, -0.45);
  assert.equal(scored.confidence_details.data_quality.supporting_families, 3);
});
test('user assertions get a modest score and broken evidence lineage cannot earn confidence', () => {
  const f = fixture('user_asserted'); f.source.kind = 'upload'; f.source.published_at = null;
  assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0.25);
  f.edge.claim_ids.push('clm_missing');
  assert.equal(edgeMetadata(f.edge, f.graph).confidence, 0);
  f.edge.claim_ids.pop(); f.graph.sources.length = 0;
  const result = edgeMetadata(f.edge, f.graph);
  assert.equal(result.confidence, 0); assert.deepEqual(result.source, []);
  assert.deepEqual(result.confidence_details.data_quality.missing_source_ids, ['src_1']);
});
test('replay is flagged and legacy annotation is idempotent with all four fields always present', () => {
  const f = fixture();
  const graph = { ...f.graph, mode: 'replay', edges: [f.edge] } as Graph;
  ensureGraphEdgeMetadata(graph);
  assert.equal(graph.edges[0].confidence_details.data_quality.replay, true);
  const first = JSON.stringify(graph); ensureGraphEdgeMetadata(graph); assert.equal(JSON.stringify(graph), first);
  const empty = edgeMetadata({ ...f.edge, claim_ids: [] }, { claims: [], sources: [], mode: 'live', created_at: 'invalid' });
  assert.equal(empty.date, null); assert.equal(empty.time, null); assert.deepEqual(empty.source, []); assert.equal(empty.confidence, 0);
});
