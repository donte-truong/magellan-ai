import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { bomEstimateSchema } from './bom-import';

export const kinds = ['product', 'component', 'material', 'organization', 'facility', 'geography'] as const;
export const predicates = ['INPUT_TO', 'PART_OF', 'MANUFACTURES', 'PRODUCES', 'OPERATES', 'LOCATED_IN', 'SUPPLIES', 'OWNED_BY', 'PROCESSED_BY'] as const;
export const labels = ['directly_supported', 'strongly_inferred', 'weakly_inferred', 'disputed', 'user_asserted', 'unresolved'] as const;
export type Kind = typeof kinds[number];
export type Predicate = typeof predicates[number];
export type Support = typeof labels[number];
const cap = (d: number, max: number, min = 1) => z.number().int().min(min).max(max).default(d);
export const limitsSchema = z.object({
  max_hops: cap(2, 4), max_nodes: cap(40, 150), max_claims: cap(60, 300),
  max_searches: cap(10, 60, 0), max_documents: cap(12, 100, 0),
  max_input_tokens: cap(250_000, 2_000_000), max_output_tokens: cap(30_000, 200_000),
  max_seconds: cap(300, 900), max_cost_minor: cap(200, 10_000, 0),
  max_tasks: cap(10, 60), max_model_calls: cap(30, 200),
}).strict();
export const inputSchema = z.object({
  product: z.string().trim().min(1).max(200), company: z.string().trim().min(1).max(200).optional(),
  seed_urls: z.array(z.url().max(2000)).max(10).default([]),
  bom: z.array(z.object({
    component: z.string().trim().min(1).max(200),
    kind: z.enum(['component', 'material']).default('component'),
    quantity: z.number().positive().optional(), unit: z.string().max(40).optional(),
  }).strict()).max(100).default([]),
  bom_estimate: bomEstimateSchema.optional(),
  limits: limitsSchema.prefault({}),
}).strict();
export type Input = z.infer<typeof inputSchema>;
export type Limits = z.infer<typeof limitsSchema>;
export type Mode = 'live' | 'replay';
export type Status = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type Scope = { type: 'product' | 'company' | 'generic'; product_node_id?: string; organization_node_id?: string };
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
export const entityKey = (e: { kind: Kind; label: string }) => `${e.kind}:${normalize(e.label)}`;
export const dataLayers = () => ({ geography: null, concentration: null, market: null, operational: null as null | { quantity?: number; unit?: string }, custom: {} });
export interface Node { id: string; kind: Kind; label: string; canonical_name: string; aliases: string[]; external_ids: Record<string, string>; tier: number | null; status: Support; flags: string[]; data: ReturnType<typeof dataLayers> }
export interface Source {
  id: string; url: string; title: string | null; publisher: string | null; published_at: string | null;
  retrieved_at: string; content_hash: string; source_family_id: string; kind: 'other' | 'upload'; license_notes: string | null;
}
export interface Document { source: Source; text: string }
export interface Evidence { id: string; source_id: string; span: string; locator: string; support_type: 'supports' | 'contradicts' | 'context'; extracted_at: string }
export interface Claim {
  id: string; subject_id: string; predicate: Predicate; object_id: string; scope: Scope;
  status: 'accepted' | 'disputed'; support_label: Support; rationale: string; evidence: Evidence[];
  contradiction_claim_ids: string[]; resolution_notes: string[]; observed_at: string;
}
export interface EdgeSource extends Source { support_types: Evidence['support_type'][] }
export interface EdgeMetadata {
  source: EdgeSource[];
  date: string | null; time: string | null;
  confidence: number;
  confidence_details: {
    method: { name: 'edge_evidence_v1'; params: { scope: 'evidence_for_stated_relation'; scale: '0-1'; max_score: number; disputed_cap: number } };
    factors: { base: number; corroboration: number; freshness: number; contradiction: number };
    data_quality: { calibrated: false; replay: boolean; supporting_families: number; missing_claim_ids: string[]; missing_source_ids: string[]; notes: string[] };
    evaluated_at: string | null;
  };
}
export interface Edge extends EdgeMetadata {
  id: string; source_node_id: string; target_node_id: string; predicate: Predicate; scope: Scope;
  support_label: Support; claim_ids: string[]; data: ReturnType<typeof dataLayers>; rationale: string; caveats: string[];
  evidence_summary: { source_count: number; independent_family_count: number; latest_published_at: string | null; has_contradiction: boolean };
}
export interface Graph {
  id: string; name: string; revision: number; run_id: string; root_node_id: string; mode: Mode;
  created_at: string; updated_at: string; exported_at: string;
  nodes: Node[]; edges: Edge[]; claims: Claim[]; evidence: Evidence[]; sources: Source[];
  stats: { node_count: number; edge_count: number; max_tier: number; by_support_label: Record<string, number> };
}
export interface Usage {
  searches: number; documents: number; input_tokens: number; output_tokens: number; model_calls: number;
  cost_minor: number; currency: 'USD'; elapsed_seconds: number; binding_limit: string | null;
  cost_method: string; reserved_input_tokens: number; reserved_output_tokens: number;
}
export interface Run {
  id: string; status: Status; mode: Mode; product: string; company: string | null; graph_id: string;
  limits: Limits; usage: Usage; progress: { tasks_done: number; tasks_total: number };
  pending_questions: never[]; open_questions: string[]; stop_reason: string | null; events_url: string;
  created_at: string; completed_at: string | null;
}
export interface Task { id: string; target_node_id: string; target_label: string; depth: number; question: string; query: string; reason: string }
export interface RunEvent { type: string; seq: number; run_id: string; graph_id: string; revision: number; at: string; payload: Record<string, unknown> }
export interface SearchHit { url: string; title: string; snippet: string }
const entitySchema = z.object({ kind: z.enum(kinds), label: z.string().min(1).max(200) }).strict();
export const candidateSchema = z.object({
  subject: entitySchema, predicate: z.enum(predicates), object: entitySchema,
  scope_type: z.enum(['product', 'company', 'generic']), scope_entity: z.string().max(200).nullable(),
  quote: z.string().min(10).max(600), rationale: z.string().min(1).max(1000),
  polarity: z.enum(['supports', 'contradicts']),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const extractionSchema = z.object({ candidates: z.array(candidateSchema).max(12), gaps: z.array(z.string().max(500)).max(6) }).strict();
export const planSchema = z.object({ tasks: z.array(z.object({ question: z.string().min(1).max(500), query: z.string().min(1).max(350), reason: z.string().min(1).max(500) }).strict()).max(3) }).strict();
export const verificationSchema = z.object({ verdicts: z.array(z.object({
  index: z.number().int().min(0), entailed: z.boolean(), scope_matches: z.boolean(), entities_match: z.boolean(),
  explanation: z.string().min(1).max(1000),
}).strict()).max(12) }).strict();
export type Verdict = z.infer<typeof verificationSchema>['verdicts'][number];

// Role constraints catch reversed edges before the model verifier can bless them.
const allowed: Record<Predicate, [Kind[], Kind[]]> = {
  INPUT_TO: [['component', 'material'], ['product', 'component', 'material']],
  PART_OF: [['component', 'material', 'facility'], ['product', 'component', 'facility']],
  MANUFACTURES: [['organization', 'facility'], ['product', 'component']],
  PRODUCES: [['organization', 'facility'], ['product', 'component', 'material']],
  OPERATES: [['organization'], ['facility']],
  LOCATED_IN: [['facility', 'organization'], ['geography']],
  SUPPLIES: [['organization', 'facility'], ['organization', 'facility']],
  OWNED_BY: [['organization', 'facility'], ['organization']],
  PROCESSED_BY: [['material', 'component'], ['organization', 'facility']],
};
export function validPredicate(c: Candidate) { return allowed[c.predicate][0].includes(c.subject.kind) && allowed[c.predicate][1].includes(c.object.kind); }
export const dependencyPredicates = new Set<Predicate>(['INPUT_TO', 'PART_OF', 'MANUFACTURES', 'PRODUCES', 'PROCESSED_BY', 'SUPPLIES']);
