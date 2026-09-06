import type { BOM, DataLayers, Graph, Run } from "@/lib/types";

const data: DataLayers = {
  geography: null,
  concentration: null,
  operational: null,
  market: null,
  custom: {},
};
export const run: Run = {
  id: "run_first",
  status: "partial",
  mode: "live",
  product: "Test product",
  company: null,
  graph_id: "g_first",
  provider: "curated_fixture",
  created_at: "2026-01-01T00:00:00Z",
  progress: { tasks_done: 1, tasks_total: 1 },
  usage: { documents: 1, searches: 0 },
  pending_questions: [],
  open_questions: ["Manufacturing quantities are unknown."],
  stop_reason: null,
};
export const graph: Graph = {
  id: run.graph_id,
  name: run.product,
  root_node_id: "n_product",
  revision: 3,
  mode: "live",
  nodes: [
    { id: "n_product", label: run.product, kind: "product", tier: 0, status: "unresolved", data },
    {
      id: "n_component",
      label: "Test chip",
      kind: "component",
      tier: 1,
      status: "directly_supported",
      data,
    },
  ],
  edges: [
    {
      id: "e_chip",
      source_node_id: "n_component",
      target_node_id: "n_product",
      predicate: "INPUT_TO",
      scope: { type: "product", product_node_id: "n_product" },
      support_label: "directly_supported",
      claim_ids: ["clm_chip"],
      data,
    },
  ],
  stats: { node_count: 2, edge_count: 1, max_tier: 1 },
};
export const bom: BOM = {
  run_id: run.id,
  graph_id: graph.id,
  revision: graph.revision,
  product: run.product,
  status: run.status,
  provider: run.provider,
  mode: run.mode,
  items: [
    {
      node_id: "n_component",
      name: "Test chip",
      kind: "component",
      tier: 1,
      parent_node_id: "n_product",
      edge_id: "e_chip",
      quantity: null,
      unit: null,
      quantity_support_label: null,
      support_label: "directly_supported",
      scope: { type: "product", product_node_id: "n_product" },
      claim_ids: ["clm_chip"],
      evidence: [],
    },
  ],
  open_questions: run.open_questions,
  method: { name: "evidence_backed_bom", assumptions: [] },
  data_quality: { coverage_pct: 100, notes: [] },
};
