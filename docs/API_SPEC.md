# Supply Chain OSINT AI — API Contract v1

**Status:** Draft for frontend/backend coordination · **Base URL:** `/v1` · **Companion file:** `openapi.yaml` (machine-readable, authoritative for field names and types)

This document explains the resource model, the flows the demo site needs, the SSE event schemas, and the agent protocol. Where this document and `openapi.yaml` disagree, the YAML wins for shapes and this document wins for semantics.

---

## 0. Conventions

| Topic | Rule |
|---|---|
| Format | JSON request/response, UTF-8. Timestamps ISO 8601 UTC (`2026-09-05T14:03:00Z`). Money in minor units with `currency`. Shares in `[0,1]`. |
| IDs | Opaque strings with a type prefix: `run_`, `gph_`, `nd_`, `ed_`, `clm_`, `ev_`, `src_`, `pf_`, `bt_`, `scn_`, `enr_`, `ag_`, `msg_`, `prop_`, `inst_`, `up_`. Never parse the suffix. |
| Auth | `Authorization: Bearer <token>`. Hackathon: one workspace per token. Every resource is scoped to the caller's workspace; cross-workspace IDs return `404`, not `403`. |
| Idempotency | All `POST` that create resources accept `Idempotency-Key`. Same key + same body → same resource, `200`. Same key + different body → `409 idempotency_conflict`. |
| Async | Long work (runs, enrichments, backtests, scenarios, agent turns) returns `202` with a job-like resource containing `status` and, where applicable, an `events_url` for SSE. Poll `GET` or subscribe. |
| Pagination | `?cursor=&limit=` (default 50, max 200). Responses include `next_cursor` (null when done). |
| Versioned reads | Graph reads accept `?revision=N`. Omit for latest. Every graph response echoes `revision`. |
| Errors | `{ "error": { "code", "message", "details": {}, "request_id" } }`. Codes are stable strings; messages are not. |
| Numbers with methods | Any computed figure (volatility, HHI, exposure, scenario impact) is returned inside an object that also carries `method` and `data_quality`. The frontend must label the figure using `method.name`; never render a bare number as fact. |
| Rate limits | `429` with `Retry-After`. Run creation is limited to 3 concurrent runs per workspace. |

### Error codes
`invalid_input` · `not_found` · `idempotency_conflict` · `revision_conflict` · `budget_exhausted` · `source_unavailable` · `provider_timeout` · `market_data_unavailable` · `unmapped_exposure` · `approval_required` · `rate_limited` · `internal`

---

## 1. Resource model

```
Upload ──▶ Run ──produces──▶ Graph (rev 0) ──fork/mutate──▶ Graph (rev N)
                              │  ├─ Nodes (product, component, material, organization, facility, geography)
                              │  ├─ Edges (typed predicates, support labels, claim refs, data layers)
                              │  ├─ Claims ─▶ Evidence ─▶ Sources
                              │  └─ Enrichments (geography, concentration, market_exposure)
                              ├─ Scenarios (forward simulation against a graph revision)
                              └─ member of ─▶ Portfolio ─▶ Volatility series, Backtests
Agent Session ─ attaches to ─▶ Graph and/or Portfolio; emits Proposals that require approval
Market: Instruments ─▶ Prices; Materials ─▶ Production shares by country
```

**Run vs Graph.** A run is the research job; a graph is its output and is the thing users look at, fork, edit, simulate, and put in portfolios. A run always yields exactly one graph (`run.graph_id`), even when partial. Graphs can also be created by forking (`POST /graphs/{id}/fork`) or by agent-proposed mutations that a user approves.

**Revisions.** A graph has an integer `revision` starting at 0. Any accepted mutation batch increments it. Reads default to latest; scenarios, backtests, and portfolio membership pin a specific revision so results stay reproducible. This is the minimal versioning needed to let the agent modify graphs safely; full immutable history is out of scope for v1.

**Data layers on nodes and edges.** Both carry a `data` object with fixed named layers so the frontend can render each independently and the backend can fill them in asynchronously:

```jsonc
"data": {
  "geography":     { "country_iso2": "ID", "lat": -6.2, "lon": 106.8, "address": "…", "claim_ids": ["clm_…"] },
  "concentration": { "commodity": "tin", "year": 2025, "hhi": 0.21, "top_share": 0.33,
                     "shares": [{ "country_iso2": "CN", "share": 0.33 }, …], "source_id": "src_…",
                     "method": { "name": "usgs_mine_production_share", "params": { "stage": "mine" } } },
  "market":        { "instruments": [{ "instrument_id": "inst_…", "role": "commodity_price", "mapping_confidence": "strong" }] },
  "operational":   { "lead_time_days": null, "quantity": 2, "unit": "ea", "weight": null },
  "custom":        { }                                   // agent or user annotations, free-form, always labelled user_asserted
}
```
Layers are `null` until an enrichment fills them. The frontend must handle any layer being null.

**Support labels** (edges and claims): `directly_supported` · `strongly_inferred` · `weakly_inferred` · `disputed` · `user_asserted` · `unresolved`. Render solid/dashed/dimmed per the design doc; never as a percentage.

**Top-level edge metadata:** `source` is a deduplicated array of all cited Source objects plus `support_types` (`supports`, `contradicts`, `context`). `date` (`YYYY-MM-DD`) and `time` (`HH:mm:ss.sssZ`) split the latest recorded evidence observation into UTC fields; they are not publication dates. `confidence` is a numeric 0–1 heuristic evidence score, with version, factors, and data quality in `confidence_details`. It supplements support labels and is not a calibrated probability. See `backend/docs/EDGE_METADATA.md` for the initial scoring rule. Metadata updates on accepted evidence, is included in edge SSE events and exports, and is derived on read for older saved graphs.

**Predicates:** `INPUT_TO`, `PART_OF`, `MANUFACTURES`, `PRODUCES`, `OPERATES`, `LOCATED_IN`, `SUPPLIES`, `OWNED_BY`, `PROCESSED_BY`. Dependency traversal (tiers, scenarios) uses only `INPUT_TO`, `PART_OF`, `MANUFACTURES`, `PRODUCES`, `PROCESSED_BY`, `SUPPLIES`.

**Scope** on edges/claims: `{ "type": "product" | "company" | "generic", "product_node_id"?: "nd_…", "organization_node_id"?: "nd_…" }`.

---

## 2. Endpoints by area

### 2.1 Uploads
| Method | Path | Purpose |
|---|---|---|
| POST | `/uploads` | `multipart/form-data` with `file` (CSV ≤ 1 MB, ≤ 100 rows). Returns `up_…`, parsed row preview, validation warnings. |
| GET | `/uploads/{upload_id}` | Metadata and row preview. |

### 2.2 Runs (research jobs)
| Method | Path | Purpose |
|---|---|---|
| POST | `/runs` | Body: `product` (required), `company?`, `upload_id?`, `limits?`, `replay_of_run_id?` (demo fallback: replays cached events, response is flagged `mode: "replay"`). Returns `202` with run incl. `graph_id`, `events_url`. |
| GET | `/runs` | List, newest first. Filter `?status=`. |
| GET | `/runs/{run_id}` | Status, progress, usage (tokens, searches, docs, cost), stop reason, `pending_questions[]` (e.g. product ambiguity), `graph_id`. |
| POST | `/runs/{run_id}/answers` | Answer a pending question (`question_id`, `choice`). Unblocks the run. |
| POST | `/runs/{run_id}/cancel` | Cooperative; committed findings kept. Idempotent. |
| GET | `/runs/{run_id}/events` | SSE. See §3. Supports `Last-Event-ID` best-effort; on gap the server sends `snapshot.required` and the client refetches the graph. |

Run states: `queued → awaiting_input → running → completed | partial | failed | cancelled`.

### 2.3 Graphs
| Method | Path | Purpose |
|---|---|---|
| GET | `/graphs` | List graphs (from runs, forks). |
| GET | `/graphs/{graph_id}` | Metadata + `nodes[]` + `edges[]` + `stats`. `?revision=N`, `?include=claims` to embed claim summaries, `?tier_max=` to truncate. |
| GET | `/graphs/{graph_id}/nodes/{node_id}` | Full node incl. all data layers, inbound/outbound edge IDs, claims. |
| GET | `/graphs/{graph_id}/edges/{edge_id}` | Full edge incl. claims, evidence with spans, contradictions, data layers. **This powers the edge inspector.** |
| POST | `/graphs/{graph_id}/fork` | New graph at same content, `parent_graph_id` set, revision 0. Optional `name`. |
| POST | `/graphs/{graph_id}/mutations` | Apply a batch of ops atomically (see below). Header `If-Match: <revision>` required; mismatch → `409 revision_conflict`. Returns new revision and the applied delta. |
| GET | `/graphs/{graph_id}/mutations` | Audit log of mutation batches: who (`user` / `agent:<session>`), when, ops, resulting revision. |
| GET | `/graphs/{graph_id}/export` | Full JSON export (graph + claims + evidence + sources) at a revision. `Content-Disposition: attachment`. |
| GET | `/graphs/{graph_id}/diff?from=&to=` | Added/removed/changed nodes and edges between two revisions. |

Mutation ops (all user-originated writes are labelled `user_asserted`; ops cannot change support labels of evidence-backed claims):
```jsonc
{ "ops": [
  { "op": "add_node",    "node": { "kind": "organization", "label": "…", "data": {…} }, "temp_id": "t1" },
  { "op": "add_edge",    "edge": { "source_node_id": "t1", "target_node_id": "nd_…", "predicate": "SUPPLIES", "scope": {…}, "rationale": "…" } },
  { "op": "update_node", "node_id": "nd_…", "patch": { "label": "…", "data": { "operational": { "lead_time_days": 45 } } } },
  { "op": "update_edge", "edge_id": "ed_…", "patch": { "data": { "operational": { "weight": 0.6 } } } },
  { "op": "remove_edge", "edge_id": "ed_…", "reason": "…" },
  { "op": "remove_node", "node_id": "nd_…", "reason": "…" },
  { "op": "annotate",    "target_id": "nd_…|ed_…", "key": "…", "value": "…" }
], "message": "why this batch was made" }
```

### 2.4 Claims, evidence, sources
| Method | Path | Purpose |
|---|---|---|
| GET | `/claims/{claim_id}` | Subject/predicate/object, scope, status, label, rationale, dates, `evidence[]` (span, locator, support_type), contradictions, resolution notes. |
| GET | `/sources/{source_id}` | URL, title, publisher, dates, content hash, family, license notes. Never the full document body. |
| POST | `/claims/{claim_id}/review` | Body: `verdict: accept | reject | dispute`, `note`. Human review action; changes `status`, logged. |

### 2.5 Enrichments (fill data layers)
| Method | Path | Purpose |
|---|---|---|
| POST | `/graphs/{graph_id}/enrichments` | Body: `kinds: ["geography","concentration","market_exposure"]`, optional `node_ids[]`. Returns `202` job `enr_…` with `events_url`. |
| GET | `/graphs/{graph_id}/enrichments/{enrichment_id}` | Status, per-node results, unresolved nodes with reasons. |

`market_exposure` maps nodes to instruments (commodity futures for materials, equities for organizations, FX for geographies, freight indices for logistics edges). Each mapping carries `mapping_confidence: strong | plausible | weak` and a `method`. Unmapped nodes are listed, never silently dropped.

### 2.6 Geography
| Method | Path | Purpose |
|---|---|---|
| GET | `/graphs/{graph_id}/geography` | **GeoJSON FeatureCollection.** Point features for facilities with evidenced locations (`properties.node_id`, `kind`, `support_label`, `claim_ids`). Polygon-free country features (by ISO2) for material production with `properties.shares` for each material node touching that country. Frontend joins ISO2 to its own basemap. |
| GET | `/materials/{material_node_id}/production?year=` | Country production/export shares for the commodity, with `source_id`, `stage`, `method`. Backs the concentration badge. |
| GET | `/reference/commodities` | Canonical commodity list the backend can resolve (`tin`, `tantalum`, `cobalt`, …) with available years and stages. |

#### BOM decomposition extension (implemented)

| Method | Path | Purpose |
|---|---|---|
| POST | `/bom/decompose` | Accepts the same body as `/runs` (`product` required). Starts a bounded, evidence-backed BOM decomposition and returns `202 Run`, including `bom_url` and `events_url`. Supports `Idempotency-Key`. |
| GET | `/runs/{run_id}/bom` | BOM view of the run's graph, with `?revision=N`. Returns product-scoped component/material rows, parent and edge IDs, nullable quantities/units, scope, support labels, claims and evidence, plus `method`, `data_quality`, and open questions. Available while the run is in progress. |
| GET | `/graphs/{graph_id}/enrichments/{enrichment_id}/events` | Implements the enrichment `events_url` described in §3.3, with resumable SSE and heartbeats. |

`Run.provider` identifies `curated_fixture` or `tavily_openai`; this is independent of `mode: live | replay`. A fixture run is explicitly identified as cached public-source research. Replay jobs reconstruct the cached graph's node/edge events into a separate graph and flag every event with `mode: replay`.

BOM output is a **research BOM**, not a complete manufacturing BOM. Generic composition and company-level context remain in the graph; they are not promoted to product-specific BOM rows. Unknown quantities and units remain null. `data_quality.coverage_pct` measures the fraction of returned rows directly supported by public evidence, **not** the fraction of the physical product discovered. Incomplete evidence produces a `partial` run with open questions. When live provider billing rates are not configured, the optional `usage.cost_minor` field is omitted and the run states that cost is unavailable.

Implementation and configuration details, including CSV columns, provider setup, the packaged production dataset, and local/PostgreSQL startup, are in [`../backend/README.md`](../backend/README.md). The runnable API exposes its implemented contract at `/openapi.json` and interactive documentation at `/docs`.

### 2.7 Market data
| Method | Path | Purpose |
|---|---|---|
| GET | `/market/instruments?q=&kind=` | Search instruments. `kind`: `commodity_future`, `equity`, `fx`, `freight_index`, `credit`. Each has `provider`, `symbol`, `currency`, `coverage: {from, to}`. |
| GET | `/market/instruments/{instrument_id}` | Detail. |
| GET | `/market/instruments/{instrument_id}/prices?from=&to=&interval=` | `interval: 1d | 1w`. Returns `series[] {t, open, high, low, close, volume?}` plus `provider`, `as_of`. Gaps returned as missing points, never interpolated. |
| GET | `/graphs/{graph_id}/market-exposure` | Node → instrument mappings at a revision with `exposure_weight` (how much of the product's dependency the node represents; `null` unless BOM quantities or user weights exist). |
| GET | `/graphs/{graph_id}/market-summary?window_days=` | Per mapped instrument: last price, return over window, realized volatility, z-score vs trailing year; flags instruments moving > 2σ. This is the "market analysis" panel. |

The backend may serve instruments from a fixture/CSV in v1; `provider` will say `fixture`. Frontend shows the provider name in the panel footer.

### 2.8 Portfolios and volatility
A portfolio is a weighted set of graph revisions (pre-saved end-to-end runs).

| Method | Path | Purpose |
|---|---|---|
| POST | `/portfolios` | `name`, `members[] {graph_id, revision?, weight}`. Weights normalized server-side; returned normalized. |
| GET | `/portfolios` · `GET /portfolios/{id}` | List / detail incl. `members[]`, `exposure_summary`. |
| PUT | `/portfolios/{id}/members` | Replace members. |
| GET | `/portfolios/{id}/exposure` | Aggregated instrument exposures across members with per-graph contributions. |
| GET | `/portfolios/{id}/volatility?from=&to=&window_days=&interval=` | Time series of portfolio volatility with component decomposition (`commodity`, `fx`, `equity`, `freight`) and top contributors (graph, node, instrument). See method below. |
| POST | `/portfolios/{id}/backtests` | `202`. Body: `from`, `to`, `model`, `params`, `events[]?` (dated shocks to overlay/evaluate). Returns `bt_…`. |
| GET | `/backtests/{backtest_id}` | Status; on completion: `series[]`, `metrics`, `event_evaluation[]`, `method`, `data_quality`. |
| GET | `/backtests` | List. |

**v1 volatility method (`exposure_weighted_realized_vol`).** For each mapped instrument, compute rolling realized volatility of log returns over `window_days`. Aggregate across the portfolio using exposure weights (member weight × node exposure weight; unweighted nodes get equal share within their graph and are flagged). Report the aggregate, the per-component sums, and coverage. The frontend labels the chart "Exposure-weighted realized volatility (v1 method)" and shows `data_quality.coverage_pct`. Correlated/cov-matrix methods can be added as new `method.name` values without an API change.

**Backtest models in v1:** `exposure_weighted_realized_vol` (default) and `early_warning` (did any mapped instrument breach a z-score threshold in the `lead_days` before each supplied event? Returns hit rate, false-alert rate, median lead time). Both declare their assumptions in `method.params`.

### 2.9 Scenarios (forward simulation)
| Method | Path | Purpose |
|---|---|---|
| POST | `/graphs/{graph_id}/scenarios` | `202`. Body: `revision`, `name`, `shocks[]`, `assumptions`, `include_inferred: bool`. |
| GET | `/scenarios/{scenario_id}` | Result: `affected_paths[]` (each with `edge_ids`, `weakest_support_label`, `assumptions_used`), `affected_nodes[]`, `timeline[]` (day-indexed availability per affected component under stated assumptions), optional `cost_impact` range when market mappings exist, `method`, `data_quality`. |
| GET | `/graphs/{graph_id}/scenarios` | List scenarios for a graph. |
| POST | `/scenarios/compare` | `scenario_ids[]` → side-by-side affected sets and deltas. |

Shock shapes:
```jsonc
{ "kind": "outage",       "target_node_id": "nd_…", "start": "2026-10-01", "duration_days": 30, "severity": 1.0 }
{ "kind": "price_shock",  "instrument_id": "inst_…", "start": "…", "magnitude_pct": 40, "decay_days": 90 }
{ "kind": "export_restriction", "country_iso2": "CN", "commodity": "gallium", "start": "…", "duration_days": 180, "severity": 0.8 }
{ "kind": "route_disruption", "edge_ids": ["ed_…"], "start": "…", "duration_days": 45, "added_lead_time_days": 21 }
```
Assumptions: `{ "inventory_days_default": 10, "substitution_allowed": false, "propagate_through": ["INPUT_TO","PART_OF","MANUFACTURES","PRODUCES","PROCESSED_BY","SUPPLIES"] }`. Scenarios never mutate the graph.

### 2.10 Agent
The agent reads graphs, portfolios, market data, and scenarios through the same backend services, answers with citations to claim IDs, and **proposes** mutations, research tasks, and scenarios rather than executing writes. The frontend renders proposals as approve/reject cards.

| Method | Path | Purpose |
|---|---|---|
| POST | `/agent/sessions` | Body: `graph_id?`, `portfolio_id?`, `context?` (free text). Returns `ag_…`, `capabilities[]` (tool names enabled for this session). |
| GET | `/agent/sessions/{id}` | Session with message history and proposal states. |
| POST | `/agent/sessions/{id}/messages` | Body: `content`, optional `selection: { node_ids[], edge_ids[] }` (what the user has selected in the UI, so "this edge" resolves). Returns `202` with `message_id` and `events_url`. |
| GET | `/agent/sessions/{id}/messages/{message_id}/events` | SSE stream for one turn. See §3.2. |
| GET | `/agent/sessions/{id}/proposals` | Pending and resolved proposals. |
| POST | `/agent/sessions/{id}/proposals/{proposal_id}/decision` | `decision: approve | reject`, `note?`. On approve the backend executes the proposal (mutation batch with `If-Match`, or starts a run/scenario/enrichment) and returns the created resource ref. |

**Agent tools (v1, read-only unless noted):**

| Tool | What it does | Effect |
|---|---|---|
| `graph.query` | Structured questions: neighbors, paths between nodes, filter by tier/kind/label/country, count by predicate | read |
| `graph.evidence` | Fetch claims + evidence spans for an edge/node | read |
| `graph.explain_path` | Narrate a path with the weakest link and scope caveats | read |
| `geography.lookup` | Production shares / concentration for a material | read |
| `market.summary` / `market.prices` | Instrument status, moves, series | read |
| `portfolio.volatility` | Run the volatility calc for a portfolio/window | read (compute) |
| `scenario.run` | Forward-simulate shocks against the current graph revision | creates a Scenario (no graph mutation) |
| `graph.propose_mutations` | Draft a mutation batch with rationale | **proposal** |
| `research.propose_task` | Ask for more OSINT on a node/edge (spawns a bounded run task on approval) | **proposal** |
| `portfolio.propose_change` | Suggest member/weight changes | **proposal** |

Answer contract: every factual statement about the graph carries `citations[] {claim_id | source_id | scenario_id | computation_id}`. Statements the agent cannot cite are marked `unsupported: true` and the frontend styles them differently. The agent never claims a mutation happened until the approval event arrives.

---

## 3. SSE event schemas

All streams: `text/event-stream`, one JSON object per `data:` line, `id:` = monotonic integer per stream, `event:` = the `type` field. Heartbeat comment `: ping` every 15 s.

### 3.1 Run events (`/runs/{id}/events`)
Common envelope: `{ "type", "seq", "run_id", "graph_id", "revision", "at", "payload" }`

| type | payload |
|---|---|
| `run.status` | `{ status, progress: { tasks_done, tasks_total }, usage }` |
| `run.question` | `{ question_id, kind: "product_ambiguity", prompt, choices[] }` — run pauses until `/answers` |
| `task.started` / `task.finished` | `{ task_id, target_node_id, relation_sought, depth, outcome? }` |
| `source.retrieved` | `{ source_id, url, title, publisher, published_at }` |
| `source.failed` | `{ url, reason }` |
| `claim.proposed` | `{ claim_id, subject_label, predicate, object_label, scope }` |
| `claim.rejected` | `{ claim_id, reason: "span_not_found" \| "scope_mismatch" \| "entailment_failed" \| "duplicate" \| "predicate_invalid", detail }` |
| `claim.committed` | `{ claim_id, support_label }` |
| `node.added` / `node.updated` | `{ node }` (full Node object) |
| `edge.added` / `edge.updated` | `{ edge }` (full Edge object) |
| `entity.merged` | `{ kept_node_id, merged_node_id, reason }` |
| `entity.review_needed` | `{ candidate_ids[], reason }` |
| `budget.updated` | `{ searches, documents, input_tokens, output_tokens, cost_minor, currency, binding_limit? }` |
| `snapshot.required` | `{}` — client should `GET /graphs/{id}` and continue |
| `run.completed` | `{ status, stop_reason, coverage_summary, open_questions[] }` |

Frontend should apply `node.added`/`edge.added` incrementally with batched layout, and treat `revision` as the ordering key.

### 3.2 Agent turn events (`/agent/sessions/{id}/messages/{message_id}/events`)
Envelope: `{ "type", "seq", "session_id", "message_id", "at", "payload" }`

| type | payload |
|---|---|
| `message.delta` | `{ text }` — append to the assistant bubble |
| `message.citation` | `{ span_start, span_end, citations[] }` — attach to already-streamed text |
| `tool.call` | `{ call_id, tool, args }` — show as collapsible step |
| `tool.result` | `{ call_id, summary, resource_ref?: { kind, id } }` |
| `proposal.created` | `{ proposal: Proposal }` — render approve/reject card |
| `ui.focus` | `{ node_ids[], edge_ids[] }` — agent asks the UI to highlight/zoom |
| `message.completed` | `{ unsupported_statement_count, tokens }` |
| `error` | `{ code, message }` |

`Proposal`: `{ id, kind: "mutations" | "research_task" | "scenario" | "portfolio_change", title, rationale, preview, status: "pending" | "approved" | "rejected" | "executed" | "failed", created_resource?: { kind, id } }`. `preview` is the exact body that will be sent to the underlying endpoint on approval, so the UI can show a diff.

### 3.3 Enrichment, backtest, scenario job events
`{ type: "job.status", payload: { status, progress } }` and `{ type: "job.completed", payload: { resource: {...} } }`. For enrichments, additionally `node.updated` events as layers fill in.

---

## 4. Frontend flows

**Cold-start run.** `POST /uploads` (if BOM) → `POST /runs` → open `events_url` → build graph from `node.added`/`edge.added` → on `run.question`, show chooser and `POST /answers` → on `run.completed`, optionally `POST /graphs/{id}/enrichments` for `geography`, `concentration`, `market_exposure` and subscribe.

**Edge inspector.** Click edge → `GET /graphs/{g}/edges/{e}` → render label, scope, evidence spans with locators, contradictions, data layers; source titles link to `sources[].url`.

**Map.** `GET /graphs/{g}/geography` → plot points; color countries by `properties.shares` of the selected material.

**Market panel.** `GET /graphs/{g}/market-summary?window_days=90` → table of instruments with 2σ flags; click → `GET /market/instruments/{i}/prices`.

**Portfolio.** Create from saved graphs → `GET /portfolios/{p}/volatility` for the chart with component stack → `POST /backtests` with known events (Suez 2021, Shanghai lockdown 2022, Red Sea 2024, tariff rounds 2025) → poll → render early-warning metrics.

**Scenario.** Select node/region → `POST /graphs/{g}/scenarios` → poll → highlight `affected_paths` with weakest-link styling → `POST /scenarios/compare` for two shocks side by side.

**Agent.** Open session bound to graph + portfolio → send message with current `selection` → stream deltas, render tool steps, render proposals → user approves → refetch graph at new revision (or follow the created run's events).

---

## 5. Open decisions for the two teams

1. **Layout persistence.** Frontend keeps layout locally in v1; if we want shared positions, add `PUT /graphs/{id}/layout` (out of scope unless requested).
2. **Market data provider.** Backend starts with `provider: fixture`; the swap to a live feed changes `coverage` and `as_of` only.
3. **Exposure weights.** Without BOM quantities or user weights, `exposure_weight` is null and volatility falls back to equal weighting per graph; the frontend must show the coverage/weighting caveat from `data_quality`.
4. **Agent write path.** All writes go through proposals in v1. If the demo needs a faster loop, we can add a per-session `auto_approve: ["scenario"]` flag; mutations and research tasks stay approval-gated.
5. **Replay mode.** Runs with `replay_of_run_id` set are flagged `mode: "replay"` in every response and event; the UI must show a replay banner.

### Full BOM import (implemented local backend)

`POST /v1/runs` accepts a complete completed/partial BOM response in `bom_estimate`, with a matching `product`. The existing simple `bom` array remains supported, but the two forms are mutually exclusive. Rich imports preserve item IDs, hierarchy, citations, part numbers, manufacturer hints, and original confidence in `data.custom` and the original input snapshot. Imported edges remain `user_asserted`; original URLs seed new verification. Request limit: 2 MB. See [graph BOM import contract](backend/docs/GRAPH_BOM_IMPORT.md).
