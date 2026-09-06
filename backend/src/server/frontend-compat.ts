import { dependencyPredicates, type Graph, type Run, type Support } from '../research/schema';

// The frontend was written against the draft FastAPI contract. These helpers present the
// Next.js backend's run and graph resources in the shapes it expects.
export const providerName = (run: Run) => run.mode === 'replay' ? 'curated_fixture' : (process.env.RESEARCH_MODEL_PROVIDER?.trim() || 'openai');
export const presentRun = (run: Run) => ({ ...run, provider: providerName(run) });

export interface BomRow {
  node_id: string; name: string; kind: string; tier: number; parent_node_id: string; edge_id: string;
  quantity: number | null; unit: string | null; quantity_support_label: Support | null; support_label: Support;
  scope: Graph['edges'][number]['scope']; claim_ids: string[]; evidence: unknown[];
}
/** One row per upstream dependency edge whose source node has a dependency tier. Derived from the latest graph. */
export function deriveBom(run: Run, graph: Graph) {
  const node = (id: string) => graph.nodes.find(n => n.id === id);
  const items: BomRow[] = graph.edges.filter(e => dependencyPredicates.has(e.predicate)).flatMap(e => {
    const from = node(e.source_node_id); const to = node(e.target_node_id);
    if (!from || !to || from.tier === null) return [];
    const claims = graph.claims.filter(c => e.claim_ids.includes(c.id));
    const evidence = claims.flatMap(c => c.evidence.map(ev => ({ ...ev, source: graph.sources.find(s => s.id === ev.source_id) ?? null })));
    const operational = e.data.operational;
    return [{
      node_id: from.id, name: from.label, kind: from.kind, tier: from.tier, parent_node_id: to.id, edge_id: e.id,
      quantity: operational?.quantity ?? null, unit: operational?.unit ?? null,
      quantity_support_label: operational?.quantity != null ? 'user_asserted' as const : null,
      support_label: e.support_label, scope: e.scope, claim_ids: e.claim_ids, evidence,
    }];
  }).sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  const supported = items.filter(i => i.support_label === 'directly_supported').length;
  return {
    run_id: run.id, graph_id: graph.id, revision: graph.revision, product: run.product, status: run.status,
    provider: providerName(run), mode: run.mode, items, open_questions: run.open_questions,
    method: {
      name: 'graph_dependency_edges_v1',
      assumptions: [
        'One row per upstream dependency edge (INPUT_TO, PART_OF, MANUFACTURES, PRODUCES, PROCESSED_BY, SUPPLIES) whose source node has a dependency tier.',
        'Quantities come only from user-supplied BOM rows; research does not extract quantities yet.',
        'Rows are derived from the latest persisted graph revision; a requested revision is not reconstructed.',
      ],
    },
    data_quality: {
      coverage_pct: items.length ? Math.round((100 * supported) / items.length) : 0,
      notes: [
        'coverage_pct is the share of rows whose relation is directly supported by a verified source span.',
        ...(run.mode === 'replay' ? ['Curated replay: short official excerpts with hand-authored model outputs, not live research.'] : []),
        ...(run.status === 'running' ? ['Research is still running; rows are added as claims are verified.'] : []),
      ],
    },
  };
}
