import { Budget } from './budget';
import { annotateEdge } from './edge-metadata';
import { dataLayers, dependencyPredicates, entityKey, id, normalize, validPredicate, type Candidate, type Claim, type Document, type Evidence, type Graph, type Input, type Mode, type Node, type Scope, type Verdict } from './schema';

export type Rejection = { reason: string; detail: string };
export function preflight(c: Candidate, doc: Document, input: Input): Rejection | null {
  const start = doc.text.indexOf(c.quote);
  if (start < 0) return { reason: 'span_not_found', detail: 'Exact quote is absent from the stored source representation.' };
  if (doc.text.indexOf(c.quote, start + 1) >= 0) return { reason: 'span_not_found', detail: 'Quote occurs more than once; a unique longer span is needed.' };
  if (!validPredicate(c) || entityKey(c.subject) === entityKey(c.object)) return { reason: 'predicate_invalid', detail: 'Invalid endpoint kinds, direction, or self-relation.' };
  if (c.scope_type === 'product' && normalize(c.scope_entity ?? '') !== normalize(input.product)) return { reason: 'scope_mismatch', detail: 'Product scope must identify the requested product exactly.' };
  if ([c.subject, c.object].some(e => e.kind === 'product' && normalize(e.label) !== normalize(input.product))) return { reason: 'scope_mismatch', detail: 'Another product cannot be added under the requested product scope.' };
  if (c.scope_type === 'company' && (!c.scope_entity || ![input.company, c.subject.kind === 'organization' ? c.subject.label : null, c.object.kind === 'organization' ? c.object.label : null].some(v => v && normalize(v) === normalize(c.scope_entity!)))) return { reason: 'scope_mismatch', detail: 'Company scope must resolve to the requested company or an organization endpoint.' };
  if (c.scope_type !== 'product' && [c.subject, c.object].some(e => e.kind === 'product')) return { reason: 'scope_mismatch', detail: 'An actual product relationship requires product evidence; company or generic scope cannot establish it.' };
  if (c.scope_type === 'generic' && c.scope_entity !== null) return { reason: 'scope_mismatch', detail: 'Generic scope cannot carry a specific scope entity.' };
  return null;
}
export function reviewGate(verdict: Verdict | undefined): Rejection | null {
  if (!verdict?.scope_matches) return { reason: 'scope_mismatch', detail: verdict?.explanation ?? 'Verifier omitted this candidate.' };
  if (!verdict.entailed || !verdict.entities_match) return { reason: 'entailment_failed', detail: verdict.explanation };
  return null;
}
function makeNode(entity: { kind: Node['kind']; label: string }, status: Node['status']): Node {
  return { id: id('nd'), ...entity, canonical_name: entity.label, aliases: [], external_ids: {}, tier: null, status, flags: [], data: dataLayers() };
}
const claimKey = (c: Pick<Claim, 'subject_id' | 'predicate' | 'object_id' | 'scope'>) => JSON.stringify([c.subject_id, c.predicate, c.object_id, c.scope]);
export class Ledger {
  readonly graph: Graph;
  readonly distance = new Map<string, number>();
  constructor(readonly input: Input, runId: string, mode: Mode) {
    const now = new Date().toISOString();
    const root = makeNode({ kind: 'product', label: input.product }, 'user_asserted'); root.tier = 0;
    const nodes = [root]; this.distance.set(root.id, 0);
    if (input.company && input.limits.max_nodes > 1) { const company = makeNode({ kind: 'organization', label: input.company }, 'user_asserted'); nodes.push(company); this.distance.set(company.id, 0); }
    this.graph = { id: id('gph'), name: `${input.product} supply evidence`, revision: 0, run_id: runId, root_node_id: root.id, mode, created_at: now, updated_at: now, exported_at: now, nodes, edges: [], claims: [], evidence: [], sources: [], stats: { node_count: nodes.length, edge_count: 0, max_tier: 0, by_support_label: {} } };
  }
  find(entity: { kind: Node['kind']; label: string }) { return this.graph.nodes.find(n => entityKey(n) === entityKey(entity)); }
  addSource(doc: Document) { if (!this.graph.sources.some(s => s.id === doc.source.id)) this.graph.sources.push(doc.source); }
  commit(c: Candidate, doc: Document, verdict: string, budget: Budget, claimId = id('clm')): { rejection?: Rejection; claim?: Claim; events: { type: string; payload: Record<string, unknown> }[]; added: Node[] } {
    budget.check();
    const fail = (reason: string, detail: string) => ({ rejection: { reason, detail }, events: [], added: [] });
    const invalid = preflight(c, doc, this.input); if (invalid) return fail(invalid.reason, invalid.detail);
    const subject = this.find(c.subject); const object = this.find(c.object);
    if (!subject && !object) return fail('disconnected', 'Neither endpoint is connected to the researched product/company context yet.');
    const depth = Math.min(subject ? this.distance.get(subject.id) ?? Infinity : Infinity, object ? this.distance.get(object.id) ?? Infinity : Infinity);
    if ((!subject || !object) && depth + 1 > this.input.limits.max_hops) return fail('max_hops', 'This new entity is beyond the allowed discovery radius.');
    const newCount = Number(!subject) + Number(!object);
    if (this.graph.nodes.length + newCount > budget.limits.max_nodes) budget.stop('max_nodes');
    if (this.graph.claims.length >= budget.limits.max_claims) budget.stop('max_claims');
    const support = doc.source.kind === 'upload' ? 'user_asserted' : 'directly_supported';
    const a = subject ?? makeNode(c.subject, c.polarity === 'supports' ? support : 'unresolved');
    const b = object ?? makeNode(c.object, c.polarity === 'supports' ? support : 'unresolved');
    const scope: Scope = c.scope_type === 'product' ? { type: 'product', product_node_id: this.graph.root_node_id } : c.scope_type === 'company' ? { type: 'company', organization_node_id: [a, b, ...this.graph.nodes].find(n => n.kind === 'organization' && normalize(n.label) === normalize(c.scope_entity!))?.id } : { type: 'generic' };
    if (scope.type === 'company' && !scope.organization_node_id) return fail('scope_mismatch', 'Scope organization did not resolve.');
    const key = claimKey({ subject_id: a.id, predicate: c.predicate, object_id: b.id, scope });
    const duplicate = this.graph.claims.find(claim => claimKey(claim) === key && claim.evidence.some(e => e.span === c.quote && e.support_type === c.polarity && this.graph.sources.find(s => s.id === e.source_id)?.content_hash === doc.source.content_hash));
    if (duplicate) return fail('duplicate', `Already stored as ${duplicate.id}; copied evidence does not add corroboration.`);
    // All gates precede mutation. The single writer serializes this batch.
    const previousTiers = new Map(this.graph.nodes.map(n => [n.id, n.tier]));
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const added: Node[] = [];
    for (const [node, existing] of [[a, subject], [b, object]] as const) {
      if (!existing) { this.graph.nodes.push(node); this.distance.set(node.id, depth + 1); added.push(node); }
    }
    this.addSource(doc);
    const start = doc.text.indexOf(c.quote);
    const evidence: Evidence = { id: id('ev'), source_id: doc.source.id, span: doc.text.slice(start, start + c.quote.length), locator: `text-utf16:${start}-${start + c.quote.length};sha256=${doc.source.content_hash}`, support_type: c.polarity, extracted_at: new Date().toISOString() };
    const claim: Claim = { id: claimId, subject_id: a.id, predicate: c.predicate, object_id: b.id, scope, status: 'accepted', support_label: support, rationale: c.rationale, evidence: [evidence], contradiction_claim_ids: [], resolution_notes: [verdict, 'Resolver v1: exact normalized name and kind only; no fuzzy merges.', ...(doc.source.kind === 'upload' ? ['User BOM assertion; not independently verified.'] : [])], observed_at: new Date().toISOString() };
    this.graph.claims.push(claim); this.graph.evidence.push(evidence);
    const related = this.graph.claims.filter(x => claimKey(x) === key);
    const positives = related.filter(x => x.evidence.some(e => e.support_type === 'supports'));
    const negatives = related.filter(x => x.evidence.some(e => e.support_type === 'contradicts'));
    // Do not synthesize a positive relationship from a denial alone.
    if (positives.length) {
      const disputed = negatives.length > 0;
      for (const item of related) {
        const isNegative = item.evidence.some(e => e.support_type === 'contradicts');
        item.contradiction_claim_ids = (isNegative ? positives : negatives).map(x => x.id);
        if (disputed) { item.status = 'disputed'; item.support_label = 'disputed'; }
      }
      const existing = this.graph.edges.find(e => e.source_node_id === a.id && e.target_node_id === b.id && e.predicate === c.predicate && JSON.stringify(e.scope) === JSON.stringify(scope));
      const sourceIds = [...new Set(related.flatMap(x => x.evidence.map(e => e.source_id)))];
      const families = new Set(sourceIds.map(sid => this.graph.sources.find(s => s.id === sid)?.source_family_id));
      const edge = existing ?? { id: id('ed'), source_node_id: a.id, target_node_id: b.id, predicate: c.predicate, scope, support_label: support, claim_ids: [], data: dataLayers(), rationale: c.rationale, caveats: [], evidence_summary: { source_count: 0, independent_family_count: 0, latest_published_at: null, has_contradiction: false } };
      edge.claim_ids = related.map(x => x.id);
      edge.support_label = disputed ? 'disputed' : positives.some(x => x.support_label === 'directly_supported') ? 'directly_supported' : 'user_asserted';
      edge.evidence_summary = { source_count: sourceIds.length, independent_family_count: families.size, latest_published_at: sourceIds.map(sid => this.graph.sources.find(s => s.id === sid)?.published_at).filter((s): s is string => !!s).sort().at(-1) ?? null, has_contradiction: disputed };
      edge.caveats = [scope.type === 'company' ? 'Company scope: does not establish use in this product.' : scope.type === 'generic' ? 'Generic relation: does not establish product-specific sourcing.' : 'Evidence concerns the named product; completeness and current validity are unknown.', 'Source independence is conservatively approximated by host; mirrors can remain undetected.', ...(disputed ? ['Explicit contrary evidence exists. Validity intervals are unavailable; review for temporal succession.'] : [])];
      const annotated = annotateEdge(edge, this.graph);
      if (!existing) this.graph.edges.push(annotated);
      events.push({ type: existing ? 'edge.updated' : 'edge.added', payload: { edge: annotated } });
    }
    this.graph.revision++;
    this.refresh();
    events.unshift(...this.graph.nodes.filter(n => previousTiers.has(n.id) && previousTiers.get(n.id) !== n.tier).map(node => ({ type: 'node.updated', payload: { node } })));
    events.unshift(...added.map(node => ({ type: 'node.added', payload: { node } })));
    events.push({ type: 'claim.committed', payload: { claim_id: claim.id, support_label: claim.support_label } });
    return { claim, events, added };
  }
  refresh() {
    const g = this.graph;
    for (const n of g.nodes) n.tier = n.id === g.root_node_id ? 0 : null;
    // Only upstream dependency edges determine tier. Discovery depth also covers context edges.
    for (let i = 0; i < g.nodes.length; i++) {
      let changed = false;
      for (const e of g.edges.filter(e => dependencyPredicates.has(e.predicate))) {
        const from = g.nodes.find(n => n.id === e.source_node_id)!; const to = g.nodes.find(n => n.id === e.target_node_id)!;
        if (to.tier !== null && (from.tier === null || from.tier > to.tier + 1) && from.id !== g.root_node_id) { from.tier = to.tier + 1; changed = true; }
      }
      if (!changed) break;
    }
    g.updated_at = new Date().toISOString(); g.exported_at = g.updated_at;
    g.stats = { node_count: g.nodes.length, edge_count: g.edges.length, max_tier: Math.max(0, ...g.nodes.map(n => n.tier ?? 0)), by_support_label: {} };
    for (const e of g.edges) g.stats.by_support_label[e.support_label] = (g.stats.by_support_label[e.support_label] ?? 0) + 1;
  }
}
