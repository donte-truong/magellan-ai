# Frontend/backend handoff

Model backend selection is server-side: `RESEARCH_MODEL_PROVIDER=openai|openrouter` applies to graph research and BOM estimation through the same adapter. OpenRouter requires `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and explicit input/output tariffs; its optional reviewer is `OPENROUTER_VERIFIER_MODEL`. Tavily credentials remain required. Existing HTTP request/response contracts do not change, and callers cannot supply API keys, provider base URLs, or arbitrary routing options in request bodies. See the README for configuration.

This is a working subset of `API_SPEC.md`/`openapi.yaml`, not a complete implementation of either. It uses Next.js Node route handlers per the updated implementation request. No frontend files were changed.

## Implemented routes

Base: `http://127.0.0.1:3001/v1`. Every route below requires the configured bearer token. The root page is a non-sensitive static instruction page.

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/runs` | `{product, company?, seed_urls?, bom?, limits?, mode?}` → 202 run; idempotent with header |
| GET | `/runs` | `{runs, next_cursor:null}`, newest first; optional status filter; no actual pagination yet |
| GET | `/runs/:id` | Latest status, usage, stop reason, graph ID, questions |
| POST | `/runs/:id/cancel` | Cooperative cancellation; `cancellation_requested` extension; terminal runs unchanged |
| GET | `/runs/:id/events` | SSE with integer `id`, event type, envelope, and Last-Event-ID replay |
| GET | `/runs/:id/history` | Authenticated private NDJSON debugging trace; do not display wholesale to normal users |
| GET | `/graphs/:id` | Current graph export shape, including full ledger/evidence/source metadata |
| GET | `/graphs/:id/export` | Downloadable JSON |
| GET | `/graphs/:id/view` | HTML debug inspector, also available as a standalone CLI artifact |
| GET | `/graphs/:id/edges/:edge` | Edge + full claims, attached evidence sources, contrary claims |
| GET | `/graphs/:id/nodes/:node` | Node + incoming/outgoing edge IDs and claims |
| GET | `/claims/:id` | Full claim; source metadata is available through `/sources` or edge details |
| GET | `/sources/:id` | Source metadata; no document body |
| POST | `/bom/decompose` | Frontend entry point: `{product, company?}` + `Idempotency-Key` → 202 run (same as `/runs`). Live when provider keys are configured; otherwise only Raspberry Pi 5 is served, from the curated replay, and other products get a 503 naming the example. |
| GET | `/runs/:id/bom` | Frontend BOM view derived from the latest graph: one row per upstream dependency edge whose source node has a tier (`method.name: graph_dependency_edges_v1`); `?revision=` is echoed only when it matches. |
| POST | `/bom` | `{description?, url?, image?, image_url?, company?, limits?}` as JSON, or `multipart/form-data` with an `image` file → **200 with the finished BOM** (synchronous; one to three minutes). Not in the draft contract. |
| GET | `/bom/:id` | Persisted `bom.json` for an earlier estimate |
| GET | `/bom/:id/history` | Private NDJSON trace of provider calls for that estimate |

Use authenticated `fetch` for SSE, or proxy it through the frontend backend. Native `EventSource` cannot attach the required header. There is no permissive CORS configuration. No token is accepted in a query parameter.

## Shapes retained

Node kinds, predicates, support-label values, opaque ID prefixes, scope fields, fixed null data layers, evidence spans/locators, source hashes, graph revision, claim references, and the common event envelope match the draft names. The graph export is flattened as in `GraphExport`, with `nodes`, `edges`, `claims`, `evidence`, `sources`, and `exported_at` at the top level.

An edge direction is literal: `component PART_OF product`, `facility MANUFACTURES product`, `facility LOCATED_IN geography`. Every edge has top-level `source` (an array of cited Source metadata with polarity), UTC `date` and `time`, numeric `confidence`, and `confidence_details` (method, factors, data quality). Confidence is a deterministic 0–1 evidence score, not a calibrated probability or model self-rating. Date/time records the latest evidence observation; publication dates remain on the sources. This addition is reflected in `docs/openapi.yaml` as optional edge properties, since the primary FastAPI backend does not emit them. See [EDGE_METADATA.md](EDGE_METADATA.md) for semantics, formula, and legacy read compatibility. Company input is context, and its node may be isolated if no relation is evidenced.

## Explicit extensions and differences

- Input adds `seed_urls` and a structured `bom` array. It does not accept `upload_id`; CSV ingestion is deferred.
- Input `mode: "replay"` selects the curated Raspberry Pi fixture. `replay_of_run_id` is **not** supported; this is not arbitrary recorded-run replay.
- Limits add `max_cost_minor`, `max_tasks`, and `max_model_calls`; defaults are intentionally smaller than the draft (see README). Currency is currently fixed to USD.
- Usage adds `model_calls`, conservative reserved token counters, and `cost_method`. `cost_minor` is a reservation estimate, not a final invoice. `documents` counts fetch attempts, including failed attempts.
- Events add `payload.mode` on every event. Standard event types carry the draft's envelope. Deterministic rejections also use `disconnected` and `max_hops` in addition to the documented rejection reasons. `claim.proposed` scope uses a textual `entity` until resolution; `claim.committed` keeps that proposal's claim ID.
- Graph revision increments per accepted research claim. Only the latest graph snapshot is available. `GET /graphs/:id?revision=N` with another revision returns 409; child reads (`/edges`, `/nodes`, `/export`, `/view`) pinned to an *earlier* revision are served from the latest graph because the frontend pins the revision it last displayed while research is still running. A revision above the current one is still a 409.
- Frontend compatibility: every run response carries `provider` (`curated_fixture` for replay, otherwise the configured model provider), and `GET /runs` returns `items` alongside `runs` and honours `?limit=`. `pending_questions` is always empty, so the frontend's clarification card never appears.
- `pending_questions` is empty. Product/company ambiguity pauses are deferred; supply the exact version. `open_questions` carries unresolved research needs and budget boundaries.
- `completed` means the bounded frontier completed. It does not certify complete coverage. `partial` includes budget stops, interruption, or no verified findings. Provider errors preserve earlier claims.
- Explicit positive/negative evidence with the same triple and scope is marked disputed. Validity periods are not extracted yet, so the inspector flags temporal uncertainty rather than treating a later source as automatically superseding an older one.
- `source_family_id` groups by hostname. `independent_family_count` is therefore a heuristic, not a confirmed independence measurement. Live publisher is the source hostname; dates remain null unless actually provided (BOM dates also unknown).
- Live source retrieval runs through Tavily at a fixed API destination. The app does not directly fetch arbitrary source hosts. The public URL check rejects credentials, IP literals, custom ports, and obvious local names; it is not a full DNS/redirect SSRF defense for a future direct fetch adapter.
- `/bom` is an MVP estimate route outside the draft contract. It does not create a run or a graph. Its `items[]` carry `basis` (`evidenced` | `inferred` | `guessed`), a `confidence` label, and `sources[]` describing where the agent got each item (`web_page` with a verbatim quote and locator, `web_page_unverified`, `search_snippet`, `image_analysis`, `user_input`, `model_knowledge`). `manufacturer` is the part maker, not provenance. `parent_item_id` gives a one-level hierarchy. `evidence[]` lists every candidate the composer could cite; `sources[]` reuses the `Source` shape (`kind: upload` for a supplied photo). Photos are accepted inline as base64 or as a multipart file; bytes are never echoed in responses or histories. A `bom_…` directory is written beside `run_…` directories. Renders of the BOM should show `basis` next to every row and surface `disclaimer` and `open_questions`.

## Client update rules

1. POST a run and retain `run.id` and `graph_id`.
2. Consume SSE in `seq` order; upsert nodes and edges by opaque ID. Revision tracks accepted claim batches, while seq orders individual events.
3. On `snapshot.required`, refetch `/graphs/:id`. On `run.completed`, fetch the final graph and run state even if every prior event arrived; this also refreshes any changed tiers or disputed claims.
4. Fetch the edge detail endpoint to inspect quotes and source metadata. Render support and scope together.
5. Display replay status conspicuously and show open questions even for completed runs.

Initial graph writes and log appends are serialized but not in a multi-file transaction. A worker crash can leave event delivery behind the checkpoint. SSE is disk-backed best-effort replay, not an exactly-once transport. The API reports orphaned running workers as partial; the on-disk run file may still show its last pre-crash state.

## Deferred API areas

Graph listing/fork/mutations/diffs/history, human claim review, ambiguity answers, uploads, enrichments, geography datasets, market data, portfolios, scenarios, and agent chat/proposals are not implemented. Unsupported paths return 404; unsupported input fields return 400. Do not generate a client assuming the entire original OpenAPI contract is available.

## Storage handoff

`runResearch()` accepts a provider factory for tests; providers expose `search`, `fetch`, and `model`. `RunStore` owns persistence, `Ledger` owns graph acceptance/projection, and `Budget` owns reservations. Replace `RunStore`/ledger commit with a PostgreSQL transaction and event outbox before adding multiple worker processes. Move job scheduling and cancellation into a durable worker service before serverless hosting. Keep the CLI entry point as a regression/debug harness.

Next.js may emit a non-fatal broad file-tracing warning for the dynamic filesystem API. Local production builds and the HTTP smoke test pass; standalone deployment packaging is not validated. Default run data, tests, docs, and environment files are excluded from output tracing. Keep custom run directories outside deployment artifacts.
