/** The subset of docs/openapi.yaml used by the MVP. No confidence probabilities. */
export type SupportLabel =
  | "directly_supported"
  | "strongly_inferred"
  | "weakly_inferred"
  | "disputed"
  | "user_asserted"
  | "unresolved";
export type NodeKind =
  "product" | "component" | "material" | "organization" | "facility" | "geography";
export type RunStatus =
  "queued" | "awaiting_input" | "running" | "completed" | "partial" | "failed" | "cancelled";
export interface Scope {
  type: "product" | "company" | "generic";
  product_node_id?: string | null;
  organization_node_id?: string | null;
}
export interface Source {
  id: string;
  url: string;
  title: string | null;
  publisher: string | null;
  retrieved_at: string;
  published_at?: string | null;
  license_notes?: string | null;
}
export interface Evidence {
  id: string;
  source_id: string;
  span: string;
  locator: string;
  support_type: "supports" | "contradicts" | "context";
  source?: Source | null;
}
export interface Claim {
  id: string;
  subject_id: string;
  object_id: string;
  scope: Scope;
  predicate: string;
  status: "proposed" | "accepted" | "rejected" | "disputed" | "under_review";
  support_label: SupportLabel;
  rationale: string;
  evidence: Evidence[];
  resolution_notes: string[];
}
export interface DataLayers {
  geography: {
    country_iso2: string;
    lat?: number | null;
    lon?: number | null;
    address?: string | null;
  } | null;
  concentration: { commodity: string; year: number; hhi: number; method: { name: string } } | null;
  operational: { quantity: number | null; unit: string | null; weight?: number | null } | null;
  market: unknown;
  custom: Record<string, unknown>;
}
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  canonical_name?: string;
  aliases?: string[];
  external_ids?: Record<string, string>;
  flags?: string[];
  tier: number | null;
  status: SupportLabel;
  data: DataLayers;
}
export interface GraphEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  predicate: string;
  scope: Scope;
  support_label: SupportLabel;
  claim_ids: string[];
  data: DataLayers;
}
export interface EdgeDetail extends GraphEdge {
  claims: Claim[];
  contradictions: Claim[];
  rationale: string;
  caveats: string[];
}
export interface Graph {
  id: string;
  name: string;
  revision: number;
  root_node_id: string;
  mode: "live" | "replay" | "scenario";
  /** Scenarios: the base graph they were forked from. */
  parent_graph_id?: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { node_count: number; edge_count: number; max_tier: number };
}
export interface RunQuestion {
  question_id: string;
  kind: "product_ambiguity" | "company_ambiguity";
  prompt: string;
  choices: { id: string; label: string; detail?: string }[];
}
export interface Run {
  id: string;
  status: RunStatus;
  mode: "live" | "replay" | "followup";
  /** Follow-up runs: the natural-language instruction steering planning and extraction. */
  instruction?: string | null;
  product: string;
  company: string | null;
  graph_id: string;
  provider: string;
  created_at: string;
  progress: { tasks_done: number; tasks_total: number };
  /** Pending research tasks per tier (tier 0 is the product root); absent on older runs. */
  frontier?: Record<string, number>;
  usage: { documents: number; searches: number };
  pending_questions: RunQuestion[];
  open_questions: string[];
  stop_reason: string | null;
}
export interface BOMItem {
  node_id: string;
  name: string;
  kind: NodeKind;
  tier: number;
  parent_node_id: string;
  edge_id: string;
  quantity: number | null;
  unit: string | null;
  quantity_support_label: SupportLabel | null;
  support_label: SupportLabel;
  scope: Scope;
  claim_ids: string[];
  evidence: Evidence[];
}
export interface BOM {
  run_id: string;
  graph_id: string;
  revision: number;
  product: string;
  status: RunStatus;
  provider: string;
  mode: "live" | "replay" | "followup";
  items: BOMItem[];
  open_questions: string[];
  method: { name: string; assumptions: string[] };
  data_quality: { coverage_pct: number; notes: string[] };
}

export const isActive = (status?: RunStatus) =>
  status === "queued" || status === "running" || status === "awaiting_input";
export const supportLabels: Record<SupportLabel, string> = {
  directly_supported: "Source supported",
  strongly_inferred: "Strongly inferred",
  weakly_inferred: "Weakly inferred",
  disputed: "Disputed",
  user_asserted: "User provided",
  unresolved: "Unresolved",
};

/** One map pin from GET /graphs/{id}/sites: a located plant or organization office. */
export interface SiteMake {
  node_id: string;
  label: string;
  kind: NodeKind;
  predicate: string;
  scope: "product" | "company" | "generic";
  /** Stated share from a verified claim, or a labelled prior; null when unknown. */
  share: number | null;
  share_basis:
    "stated" | "uniform_prior" | "stated_over_plants" | "uniform_prior_over_plants" | null;
  claim_ids: string[];
  sources: string[];
  via_organization_id?: string;
}

export interface Site {
  node_id: string;
  kind: "facility" | "organization";
  /** A located organization is its office or headquarters, never a plant. */
  role: "plant" | "organization";
  label: string;
  country_iso2: string;
  admin1: string | null;
  city: string | null;
  lat: number;
  lon: number;
  precision: "address" | "city" | "region" | "country";
  geocoding: { method: string; precision: string; note?: string } | null;
  location_claim_ids: string[];
  location_sources: string[];
  operators: { node_id: string; label: string }[];
  makes: SiteMake[];
}

export interface DistributionEntry {
  node_id: string;
  label: string;
  kind: NodeKind;
  predicate: string;
  scope: "product" | "company" | "generic";
  share: number | null;
  share_basis: "stated" | null;
  share_estimate: number | null;
  estimate_basis: "uniform_prior" | null;
  claim_ids: string[];
}

/** Who makes or supplies a node, as a distribution that may sum to less than one. */
export interface Distribution {
  target_node_id: string;
  target_label: string;
  family: "makers" | "suppliers";
  entries: DistributionEntry[];
  stated_total: number;
  unassigned: number;
}

export interface Sites {
  sites: Site[];
  distributions: Distribution[];
}

export interface RunLimits {
  max_hops: number;
  max_nodes: number;
  max_claims: number;
  max_searches: number;
  max_documents: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_seconds: number;
  max_searches_per_task: number;
  max_documents_per_task: number;
}

/** A graph without its nodes and edges; scenarios carry their fork point and edits. */
export interface GraphMeta {
  id: string;
  revision: number;
  name: string;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  parent_graph_id: string | null;
  root_node_id: string | null;
  mode: "live" | "replay" | "scenario";
  forked_from_revision?: number | null;
  scenario_edits?: {
    edit_id: string;
    instruction: string;
    applied: Record<string, unknown>[];
    at: string;
  }[];
  stats: Record<string, unknown>;
}

export interface EditResult {
  edit_id: string;
  graph_id: string;
  revision: number;
  applied: Record<string, unknown>[];
  skipped: Record<string, unknown>[];
}
