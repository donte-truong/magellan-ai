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
  mode: "live" | "replay";
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
  mode: "live" | "replay";
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
  mode: "live" | "replay";
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
