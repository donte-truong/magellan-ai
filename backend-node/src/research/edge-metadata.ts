import type { Edge, EdgeMetadata, EdgeSource, Graph, Support } from './schema';

type EdgeCore = Omit<Edge, keyof EdgeMetadata>;
type LedgerData = Pick<Graph, 'claims' | 'sources' | 'created_at' | 'mode'>;
const BASE: Record<Support, number> = { directly_supported: 0.70, strongly_inferred: 0.50, weakly_inferred: 0.30, disputed: 0.70, user_asserted: 0.25, unresolved: 0 };
const MAX_SCORE = 0.95;
const DISPUTED_CAP = 0.25;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
function latestDate(values: (string | null | undefined)[]): string | null {
  const times = values.filter((v): v is string => !!v).map(v => Date.parse(v)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Pure evidence-derived projection; never asks the model for a confidence percentage.
 * Time is pinned to recorded observations, so reloading an old graph cannot age its score.
 */
export function edgeMetadata(edge: EdgeCore, graph: LedgerData): EdgeMetadata {
  const claimIds = new Set(edge.claim_ids);
  const claims = graph.claims.filter(c => claimIds.has(c.id));
  const evidence = claims.flatMap(c => c.evidence);
  const sourceIds = [...new Set(evidence.map(e => e.source_id))].sort();
  const source: EdgeSource[] = sourceIds.flatMap(sid => {
    const found = graph.sources.find(s => s.id === sid);
    return found ? [{ ...found, support_types: [...new Set(evidence.filter(e => e.source_id === sid).map(e => e.support_type))].sort() }] : [];
  });
  const missing_claim_ids = edge.claim_ids.filter(cid => !claims.some(c => c.id === cid));
  const missing_source_ids = sourceIds.filter(sid => !source.some(s => s.id === sid));
  const observed = latestDate(claims.flatMap(c => [c.observed_at, ...c.evidence.map(e => e.extracted_at)]))
    ?? latestDate(source.map(s => s.retrieved_at)) ?? latestDate([graph.created_at]);
  const positives = source.filter(s => s.support_types.includes('supports'));
  const web = positives.filter(s => s.kind !== 'upload' && evidence.some(e => e.source_id === s.id && e.support_type === 'supports' && !!e.span.trim()));
  // Connected components of shared family OR shared document hash: copied pages
  // across different hosts must not earn extra corroboration, even transitively.
  const groups: { families: Set<string>; hashes: Set<string> }[] = [];
  for (const s of web) {
    const family = s.source_family_id || 'unknown_family';
    const content = s.content_hash || 'unknown_content';
    const matches = groups.filter(g => g.families.has(family) || g.hashes.has(content));
    const merged = { families: new Set([family]), hashes: new Set([content]) };
    for (const g of matches) { g.families.forEach(f => merged.families.add(f)); g.hashes.forEach(h => merged.hashes.add(h)); groups.splice(groups.indexOf(g), 1); }
    groups.push(merged);
  }
  const notes = ['Heuristic evidence score, not a calibrated probability or a measure of supply-chain completeness.', 'Family independence uses stored source-family IDs and content hashes; edited syndication may remain undetected.'];
  const hasSupport = evidence.some(e => e.support_type === 'supports' && !!e.span.trim() && positives.some(s => s.id === e.source_id));
  const disputed = edge.support_label === 'disputed' || evidence.some(e => e.support_type === 'contradicts');
  let base = hasSupport ? BASE[edge.support_label] : 0;
  if (!web.length) base = Math.min(base, BASE.user_asserted);
  const corroboration = Math.min(2, Math.max(0, groups.length - 1)) * 0.10;
  let freshness = 0;
  if (web.length) {
    const published = latestDate(web.map(s => s.published_at).filter(d => d && observed && Date.parse(d) <= Date.parse(observed)));
    if (!published || !observed) { freshness = -0.05; notes.push('Supporting publication date unknown or in the future; retrieval time is not publication time.'); }
    else {
      const age = (Date.parse(observed) - Date.parse(published)) / YEAR_MS;
      freshness = age > 5 ? -0.20 : age > 2 ? -0.10 : 0;
      if (freshness) notes.push('Older supporting publication reduces freshness; historical evidence may still be correct.');
    }
  } else notes.push('User assertion or missing web support; not independently corroborated.');
  const contradiction = disputed ? -0.45 : 0;
  if (disputed) notes.push('Contrary evidence caps confidence at 0.25; this does not estimate a probability that either side is true.');
  if (graph.mode === 'replay') notes.push('Replay uses curated verdicts; the score does not imply a live model review.');
  const incomplete = !hasSupport || missing_claim_ids.length > 0 || missing_source_ids.length > 0;
  if (incomplete) notes.push('Missing evidence lineage forces the score to zero.');
  const confidence = incomplete ? 0 : Math.round(Math.max(0, Math.min(disputed ? DISPUTED_CAP : MAX_SCORE, base + corroboration + freshness + contradiction)) * 1000) / 1000;
  return {
    source, date: observed?.slice(0, 10) ?? null, time: observed?.slice(11) ?? null, confidence,
    confidence_details: {
      method: { name: 'edge_evidence_v1', params: { scope: 'evidence_for_stated_relation', scale: '0-1', max_score: MAX_SCORE, disputed_cap: DISPUTED_CAP } },
      factors: { base, corroboration, freshness, contradiction },
      data_quality: { calibrated: false, replay: graph.mode === 'replay', supporting_families: groups.length, missing_claim_ids, missing_source_ids, notes },
      evaluated_at: observed,
    },
  };
}
export function annotateEdge<T extends EdgeCore>(edge: T, graph: LedgerData): T & EdgeMetadata { return Object.assign(edge, edgeMetadata(edge, graph)); }
export function hasEdgeMetadata(edge: EdgeCore): edge is Edge {
  const value = edge as Partial<Edge>;
  return Array.isArray(value.source) && value.date !== undefined && value.time !== undefined && typeof value.confidence === 'number' && !!value.confidence_details;
}
/** Upgrade pre-metadata files on read without rewriting their original audit records. */
export function ensureGraphEdgeMetadata(graph: Graph): Graph {
  for (const edge of graph.edges) if (!hasEdgeMetadata(edge)) annotateEdge(edge, graph);
  return graph;
}
