# Magellan backend

FastAPI + Pydantic implementation of the resource model and API sections **2.1–2.6**, plus product-name BOM decomposition. Routes use `/v1`. Interactive docs: `/docs`; implemented OpenAPI: `/openapi.json`; database health: `/healthz`.

## Run locally

Requires Python 3.12 or newer. From the repository root:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.lock
.venv/bin/pip install --no-deps -e .
cp .env.example .env
.venv/bin/uvicorn app.main:app --reload
```

The development default uses persistent SQLite (`backend/magellan.db`), an embedded worker, and a curated evidence provider. It makes no external API calls. Authenticate with `Authorization: Bearer dev-token`. Configure `WORKSPACE_TOKENS` as a JSON object mapping provisioned tokens to workspace names; arbitrary tokens are rejected and cross-workspace resources return 404. The frontend origin defaults to `http://localhost:5173`.

## Decompose a bill of materials

```bash
curl -X POST http://localhost:8000/v1/bom/decompose \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pi5-demo' \
  -d '{"product":"Raspberry Pi 5","limits":{"max_hops":3,"max_nodes":50}}'
```

The response is `202 Run`, with `graph_id`, `events_url`, and `bom_url`. Poll the returned `bom_url` for rows containing the component/material, parent, quantity, unit, support label, scope, claim IDs and exact evidence spans. A known quantity also has `quantity_support_label`, so a user-supplied amount is not presented as publicly verified when other evidence corroborates the relationship. Subscribe to `events_url` for graph growth. The same flow is available through `POST /v1/runs`. Requests support optional `company`, `upload_id`, `limits`, and `replay_of_run_id`.

The included Raspberry Pi 5 example contains three manufacturer-evidenced components. It reports `provider: curated_fixture`, `status: partial`, and explicit research gaps. An unknown product produces an unresolved root and open questions. Quantities, factories and suppliers are never filled from plausibility. Generic/company-scope relationships stay in the graph and are excluded from the product BOM view. BOM coverage measures the supported fraction of **returned rows**, not physical product completeness.

## Estimate a bill of materials from text, a link, or a photo

`POST /v1/bom` is a separate, deliberately looser estimator: the model may fill gaps with informed guesses, but code, not the model, assigns provenance. It runs synchronously (one to three minutes with live providers) and returns the persisted estimate, which is also readable at `GET /v1/bom/{bom_id}`.

```bash
curl -X POST http://localhost:8000/v1/bom \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"description":"Raspberry Pi 5 8GB","url":"https://www.raspberrypi.com/documentation/computers/processors.html"}'

# Photo upload (multipart). Fields: description, url, image_url, company, limits (JSON string), image (file)
curl -X POST http://localhost:8000/v1/bom -H 'Authorization: Bearer dev-token' \
  -F description="board found in a drawer" -F image=@photo.jpg
```

JSON bodies may carry the photo inline as `{"image":{"data":"<base64>","media_type":"image/jpeg"}}` (JPEG, PNG, WebP, or GIF; at most 5 MB; bytes must match the declared type) or as a public `image_url`. At least one of `description`, `url`, `image`, `image_url` is required. Optional `limits`: `max_searches` 5, `max_documents` 6, `max_items` 60, `max_seconds` 180, plus token ceilings. At most three estimates run at once; there is no idempotency key on this route.

Pipeline: fetch the product link (Tavily extract) → vision pass on the photo → identify the product and plan searches → Tavily search → read the best pages (at most two per host) → per-page extraction with verbatim quote checks → final composition. Every item carries a `basis`:

| `basis` | Meaning |
| --- | --- |
| `evidenced` | At least one source is a fetched page whose quote was found verbatim in the stored copy (`web_page`, with a character locator and the page's content hash). |
| `inferred` | Supported only by weaker provenance: a page quote that could not be located (`web_page_unverified`), a search snippet, the photo (`image_analysis`), or the user's own text (`user_input`). |
| `guessed` | No retrieved source; the model added it from general knowledge (`model_knowledge`). Confidence is capped at `medium`. |

`manufacturer` on an item is who makes the part; `sources` is where the agent found it. `confidence` is a label, never a percentage. The composer can only cite evidence IDs the code issued; unknown IDs are dropped and logged. `evidence[]` lists every candidate it could cite and `sources[]` reuses the graph's `Source` shape (page bodies stay private; a photo is stored only as a hash). With the fixture provider only the curated Raspberry Pi 5 pages are known, photos are not analyzed, and unknown products return an honest empty list with open questions.

To turn an estimate into graph research, post it back as `bom_estimate`:

```bash
curl -X POST http://localhost:8000/v1/runs -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -d "{\"product\":\"Raspberry Pi 5\",\"bom_estimate\":$(curl -s http://localhost:8000/v1/bom/BOM_ID -H 'Authorization: Bearer dev-token')}"
```

The product must match the estimate's product name; `upload_id` and `bom_estimate` are mutually exclusive; duplicate item or source IDs, parent cycles, dangling citations, and non-public citation URLs are rejected. Each item becomes a `user_asserted` `PART_OF` row (materials: `INPUT_TO`) whose evidence is the canonical imported row, with the original basis, confidence, part number, maker, hierarchy, and citations kept under `data.custom.bom_estimate` on the edge and `data.custom.bom_items` on the node, marked `imported_not_independently_verified`. An imported `evidenced/high` label never grants graph `directly_supported` status: up to ten cited pages are re-read as seeds and verified afresh, corroborating claims land on the same edge, and imported part numbers and makers sharpen later live search queries. Extra snapshot fields on the estimate are preserved as metadata, never treated as facts.

Live arbitrary-product research uses Tavily plus your choice of model provider. For OpenAI, configure `backend/.env`:

```dotenv
RESEARCH_PROVIDER=live
TAVILY_API_KEY=your-key
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_MODEL=your-available-structured-output-model
```

For OpenRouter free models, use the following instead. An OpenAI key is unnecessary:

```dotenv
RESEARCH_PROVIDER=live
TAVILY_API_KEY=your-key
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=openrouter/free
OPENROUTER_VERIFIER_MODEL=
OPENROUTER_RESPONSE_FORMAT=json_schema
```

`OPENROUTER_MODEL` accepts `openrouter/free` or a specific `:free` model ID. `OPENROUTER_VERIFIER_MODEL` optionally selects a separate free model for the independent relationship and geography verification passes; an empty value uses the extraction model. The [free-model router](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground) selects an available compatible model. All requests require supported parameters and set zero prompt, completion, and per-request price ceilings using [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection#max-price). There is no fallback to paid models or OpenAI. Tavily search remains a separate service with its own usage limits.

Paid OpenRouter models are allowed only when both operator billing rates are configured: set `INPUT_TOKEN_COST_PER_MILLION_MINOR` and `OUTPUT_TOKEN_COST_PER_MILLION_MINOR` (USD cents per million tokens) to conservative ceilings covering both selected models, then use explicit `vendor/model` IDs such as `openai/gpt-4o-mini`. The rates become the router's prompt and completion `max_price` (USD per million tokens), so a route above your ceiling fails rather than silently costing more. Automatic `openrouter/*` routers remain free-only. Photo inputs for the BOM estimate additionally require a vision-capable model on either provider; images are sent as inline data URLs and reserved at a flat 4,000 input tokens each before the provider's reported usage replaces the reservation.

The default `json_schema` mode uses [strict structured output](https://openrouter.ai/docs/guides/features/structured-outputs). For a free model that supports JSON mode but not JSON-schema enforcement, set `OPENROUTER_RESPONSE_FORMAT=json_object`; the schema is included in the instructions and Pydantic validates the complete response locally. Malformed, refused, truncated, or schema-invalid output is rejected. The configured `minimax/minimax-m3:free` model was verified with JSON-object mode during implementation. Model availability and [free-tier limits](https://openrouter.ai/docs/faq) can change; rate limits and unavailable routes end research with visible gaps rather than switching providers.

To run the complete MVP using `backend/.env`, from the repository root:

```bash
docker compose --env-file backend/.env up --build -d
```

Open http://localhost:3000 for the frontend and http://localhost:8000/docs for the API. `Run.provider` identifies `tavily_openrouter` or `tavily_openai`. Restart the API and worker after changing model configuration.

Live research searches Tavily with fetched `raw_content`, extracts structured relationships, checks exact quoted spans locally, and separately verifies entailment and scope. Search snippets are never evidence. Extraction has no tools or graph-write capability. Only the worker commits validated findings. Geography searches named facilities and verifies their country/address; coordinates stay null unless quoted explicitly. No address-to-coordinate inference is performed. Model verification is fallible: claims remain inspectable and subject to human review.

Each run enforces hops, nodes, claims, searches, documents, input/output tokens and elapsed time. A timeout, cancellation or exhausted budget preserves committed findings. Unfinished branches are returned as open questions. Live cost is omitted when unknown; optional operator billing rates produce a rounded-up minor-unit estimate. The API contract does not define a monetary budget field. Token reservations use conservative UTF-8 byte bounds before calls, then reconcile provider usage; interrupted calls can retain conservative reservations.

Provider contracts: [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Model selection is explicit configuration; no provider credentials are required for tests.

## Deeper graphs: the planned research loop

Research is one run, one graph, one worker loop, made stateful ([plan and rationale](docs/DEEPER_GRAPHS_PLAN.md)). The product root is tier 0; `refresh()` computes upstream distance through the dependency predicates. For each target the worker:

1. **Plans** one bounded task. The planner (a `plan` provider call, or tier and kind templates when a provider has none or returns invalid output) receives the product, the target with its identifiers, aliases, and imported BOM hints, the relationship triples already evidenced (newest first, bounded to a character budget), which relation types are still unanswered for the target, previous and failed queries, open questions, and the remaining budget. It returns a relation sought, up to three literal queries with expected source types, a skip flag, and a priority. Queries are data inside a fixed search request; the planner cannot select tools, write to the graph, or waive verification. A task that yields nothing from its first query is replanned once with the failed query on record. Emitted as `task.planned`.
2. **Searches and reuses.** Pages are keyed by content hash; a page already analyzed for the same (target, relation) question is skipped, and a page seen again attaches to its existing source record. Per-task caps `max_searches_per_task` (3) and `max_documents_per_task` (4) are new `RunLimits` fields; every global cap still applies. Extraction reads the first 8,000 characters plus up to two 6,000-character keyword windows; the stored source keeps up to 60,000 characters so spans stay verifiable.
3. **Harvests.** A finding names a subject and, optionally, an object other than the target, plus a part number and maker when the page states them. Commits are order-independent per document: a relation is placed once at least one endpoint resolves to an existing node, the other endpoint is created within `max_hops` (organizations, facilities, and geographies at any depth), predicate direction and kinds must satisfy the relation table in `app/resolution.py`, product scope requires the exact product, company scope needs an organization endpoint as its anchor, and generic scope never carries a product endpoint. Unplaceable findings are rejected as `disconnected`; the verbatim-span and independent-verification gates are unchanged.
4. **Resolves conservatively.** Entities match by normalized label within a kind, by an evidence-backed alias, by a recorded part number, or by the same text with a recorded or stated manufacturer prefix removed. Two matches, or a name with a conflicting identifier, emit `entity.review_needed` and never merge. Name variants that share a part-number-like token or contain one another within a kind are flagged as `near_duplicate` without merging. Paraphrases the rules cannot see ("8-channel DMA controller" versus "eight-channel direct memory access (DMA) controller") go to one bounded model call per document (`MODEL_RESOLUTION`, default `merge`): the new label, its quote, and at most twelve candidates (token near-duplicates plus siblings under the same anchor), never the graph. A `same` verdict merges with a model-resolved alias and an `entity.merged` event carrying the rationale; `unsure` emits `entity.review_needed`; `flag` mode only flags; identifier conflicts are never overridden. Long descriptive labels yield to a short identifier-bearing one once both are evidenced. Firmware, drivers, software, accessories, and interfaces (ports, slots, headers, protocol versions without a named part) are rejected as parts. A material is always INPUT_TO and a component PART_OF; a new part or material is created only as the subject of a relation, so every dependency stays on a tiered path from the root, and a claim whose whole is not yet connected is kept as an orphan, retried after each task that adds nodes, and rejected as `disconnected` only when the run ends. A relation stops collecting claims after four distinct sources (`duplicate`). Imported `bom_items` hints sharpen queries but are never used for matching.
5. **Schedules fairly.** A branch is a tier-1 subtree; seed re-reads charge the root branch. The next task comes from the branch that has consumed the fewest documents per completed task, then the lower tier, then the target with more unanswered relation types. `Run.frontier` (pending tasks per tier) and `progress` are updated after every task.

Failures are classified: `model_output_invalid` (malformed, refused, or schema-invalid model text) fails that task visibly (`task.finished` outcome `failed:model_output_invalid` and an open question) while other branches continue; `provider_timeout` and `source_unavailable` end the run; budget exhaustion, cancellation, and lease loss propagate as before. Every model call is recorded in a bounded private history (verbatim text before validation, usage, and the failure class), readable only at `GET /v1/runs/{run_id}/history`. The fixture provider supports `FIXTURE_DEPTH=2`, which adds the BCM2712's parts so chains, alias resolution, and reversed-direction rejection run in tests without keys.

Places and shares, for the map: organizations and facilities are research targets for a `location` relation (an organization's plants and where they are; a facility's city and country), scheduled after the parts at the same depth and capped at two searches. A place named in evidence becomes a geography node with an ISO code and coordinates from a deterministic gazetteer (countries, key regions, recurring manufacturing cities) with its precision and method recorded; no model geocodes, and a country centre is never presented as a plant's address. A facility or organization takes the place's layer through its LOCATED_IN claim, which is what `GET /graphs/{id}/geography` and `GET /graphs/{id}/sites` read. The extractor may state a share (the fraction of an object's assembly, production, or supply a subject accounts for) when the span says so and the verifier confirms it; it lands on the edge's operational weight with a stated basis. The sites view turns makers and suppliers into distributions: stated shares from claims, an `unassigned` remainder when information is missing, and a labelled uniform prior over unstated sources and over an operator's located plants, because which plant a given unit comes from is not knowable from public text. Runs queue a geography follow-up job for facilities still without a location (`enrichment_ids`).

Efficiency controls for deeper graphs: research tasks run as a fair bounded pool (`TASK_CONCURRENCY`, default 3; branches with no task in flight are chosen first) and document analyses across those tasks share one `RESEARCH_CONCURRENCY` semaphore (default 4), while every commit and budget charge stays a synchronous step so ordering rules are unchanged and the first budget stop cancels the other tasks; verification sends each claim only its quote and a 400-character window on either side, not the whole page; a task's document allowance is shared across its planned queries (the product task gets twice the allowance and replans once when it yields fewer than three entities), a long page that never names the product, the target, or its part number is skipped before any model call, a page analyzed for one target is committed for any later target from its stored findings without another model call, and deterministic gates run before verification so the verifier is not paid for claims that can never commit; a tier-1 branch is paused after `BRANCH_STAGNATION_TASKS` (default 2) consecutive tasks without a verified finding, releasing its budget to other branches; search results are re-ranked by the planner's expected source types (datasheets, teardowns, filings, supplier lists, government datasets), first-party hosts, and product mentions, with video and social hosts excluded server-side; and every provider call has a hard `PROVIDER_CALL_DEADLINE_SECONDS` (default 180) so a hung route ends the run as `provider_timeout` instead of stalling it. Reasoning models are controlled with `OPENROUTER_REASONING` (`off` or an effort level) or a token budget `OPENROUTER_REASONING_MAX_TOKENS`, with per-role overrides for the planner, verifier, and extraction (`OPENROUTER_REASONING_PLANNER` and friends for effort, `OPENROUTER_REASONING_MAX_TOKENS_PLANNER` and friends for budgets), so a mixed run can pair a reasoning judgment model with a non-reasoning extraction model; hidden reasoning otherwise competes with the JSON for `max_tokens`, which on several models produced empty or truncated output.

Model roles are consistent across providers: `OPENAI_MODEL` / `OPENROUTER_MODEL` extract, `*_VERIFIER_MODEL` verifies, and `*_PLANNER_MODEL` plans, each falling back to the previous. Routing price ceilings (OpenRouter `max_price` from the billing rates) remain distinct from `cost_minor`, which estimates a whole run's spend. Default limits have not been raised; that waits on the evaluation set described in the plan.

## Edge provenance and confidence

Every edge carries `source` (all cited sources with their `support_types`), the UTC `date` and `time` of its latest recorded evidence observation, a numeric `confidence` in `[0, 0.95]`, and `confidence_details` naming the method (`edge_evidence_v1`), the factors, and data-quality notes. The score is a deterministic projection of the claim ledger, never a model self-rating: a support-label base (directly supported 0.70, user asserted 0.25), up to +0.20 for additional independent supporting source groups (deduplicated by source family and content hash), a freshness adjustment when the supporting publication date is unknown or old, and a −0.45 penalty with a 0.25 cap whenever contradictory or disputed evidence exists. Rejected claims stop counting; missing claim or source lineage forces zero. It is recomputed on every graph refresh, so each saved revision carries the score as of that revision, and snapshots saved before this feature are enriched on read. Details and worked examples: [docs/EDGE_METADATA.md](docs/EDGE_METADATA.md). Support labels remain the primary signal; the frontend does not yet render the number.

## Uploads and graph edits

`POST /v1/uploads` accepts UTF-8 CSV, at most 1 MiB and 100 data rows. A component column is required: `component`, `part`, `part_name`, `name`, `material`, or `description`. Optional columns are `quantity` (or `qty`), `unit`, and `kind` (`component` or `material`). Headers are normalized to lowercase with underscores. Extra columns are retained in the upload. Malformed rows are rejected; invalid quantities generate warnings and stay unknown. Preview is limited to ten rows, but every valid row is ingested. Upload rows are stored as `user_asserted` evidence, never as verified public evidence.

```csv
material,quantity,unit
tin,0.5,g
copper,2,g
```

Mutation batches require `If-Match: <revision>` (quoted ETags also work) and accept `Idempotency-Key`. Temporary node IDs resolve within a batch, including scope anchors. The entire batch rolls back on error. Relationship identity and evidence support labels are immutable. User edits support identity fields on unevidenced nodes, operational layers, and custom annotations; evidence/computed layers are reserved for enrichments. Annotations explicitly carry `user_asserted`. Remove referencing edges before removing a node; the root cannot be removed. Evidence-backed identities cannot be relabeled into different entities.

Human claim reviews are recorded in the ledger and graph mutation audit log. They change claim status without rewriting its original evidence label. Affected current graphs get a new revision and disputed/unresolved edge labels. Historical graph inspectors and exports retain their prior claim state. Forks preserve entity IDs and evidence; reviewing a shared claim updates all current graphs containing it, with separate new revisions.

## Geography and enrichment

All three enrichment kinds are implemented: `geography`, `concentration`, `market_exposure`. Jobs return a result for every requested node/kind, including skipped and unresolved outcomes. The enrichment event URL supports SSE. Reads at earlier revisions preserve earlier layers.

The packaged production catalogue contains **tin, mine stage, 2024 estimates**, transcribed from the original [USGS Mineral Commodity Summaries 2025](https://pubs.usgs.gov/periodicals/mcs2025/mcs2025_ver.1.0.pdf). Shares use the sum of the reported country estimates plus the unallocated “Other countries” estimate. HHI sums identified country shares squared; it is a lower bound because the remainder cannot be assigned to countries. `method` and `data_quality` report this. Production shares are global context and do not establish this product's sourcing countries. Unsupported materials, stages or years return `source_unavailable`; there is no silent year fallback.

Extend the catalogue using `PRODUCTION_DATA_PATH` and the validated JSON format in `app/data/production.json`. `/reference/commodities` reflects only configured data. GeoJSON contains points for facilities with accepted matching location claims and explicit coordinates; country features have null geometry and ISO2 keys for the frontend basemap. Country-only facility evidence can fill the geography layer without inventing a map point.

Market enrichment provides explicit **fixture** commodity mappings for tin and copper. Unmapped nodes are reported. Exposure weights remain unknown. Market prices, portfolios, scenarios, and agent endpoints beyond section 2.6 are outside this implementation.

## PostgreSQL and separate worker

From the repository root, `docker compose up --build -d` starts PostgreSQL, runs Alembic migrations, then starts the API, a separate worker, and the Next.js frontend. This default uses fixture research. Add `--env-file backend/.env` before `up` to use your live provider settings. Frontend and API ports are bound to loopback, and the database stays internal. Set `MAGELLAN_API_TOKEN` to a provisioned token if you change `WORKSPACE_TOKENS`. Runtime and test dependency versions are locked separately.

For a managed PostgreSQL deployment, set `DATABASE_URL=postgresql+psycopg://...`, provision `WORKSPACE_TOKENS`, set `AUTO_CREATE_SCHEMA=false` and `EMBEDDED_WORKER=false`, then run from `backend`:

```bash
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
# In a separate process with the same configuration:
.venv/bin/python -m app.worker
```

`ENVIRONMENT=production` rejects the development token and requires explicit migrations and a separate worker. Run one worker process with configurable asyncio slots (default three). API processes may scale independently. Configure TLS and secrets through the deployment environment.

Storage uses a workspace-scoped JSONB resource/claim ledger, immutable graph snapshots, persisted SSE events and idempotency records. PostgreSQL transaction-scoped advisory locks serialize writes per workspace; SQLite uses `BEGIN IMMEDIATE`. The same transaction protects idempotency, revision checks, job claiming, event ordering, and the three-concurrent-runs limit. Provider calls occur outside transactions. Expired worker leases end jobs as partial after a crash rather than repeating potentially billed requests. Queued jobs survive restarts. Idempotency keys are scoped to a workspace across POST routes, and currently have no expiry.

SSE event IDs increase within each stream. `Last-Event-ID` resumes retained events; a gap emits `snapshot.required`. Heartbeats are sent every 15 seconds and terminal streams close. Browsers need an authenticated fetch-based SSE client because native `EventSource` cannot set the required Bearer header. The default retained log is 5,000 events per stream. Graph revisions and source/claim records are retained; a storage retention policy is a future operational addition.

## Verification

```bash
cd backend
.venv/bin/pytest -q
.venv/bin/ruff check app tests migrations
.venv/bin/ruff format --check app tests migrations
```

Tests exercise the HTTP API, persistent SQLite transactions, concurrent idempotency and revision checks, workspace isolation, uploads, real worker execution with curated evidence, claim review history, enrichment, BOMs, replay, SSE resume/gaps, job recovery, provider failures, and mocked live extraction. Contract tests validate responses against `docs/openapi.yaml` and check that every route through section 2.6 is present. Live paid APIs are mocked, so deployment should verify provider credentials and model access separately.

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the same suite against JSONB storage and advisory locks. Each test creates an isolated schema and removes it afterward. Both SQLite and PostgreSQL 18 have been exercised during implementation, including `alembic upgrade head` and `alembic check`.

Modules: `api.py` handles HTTP/auth; `schemas.py` validates public models; `db.py` owns transactions and persistence; `graphs.py` owns graph/evidence invariants; `jobs.py` handles job commands and BOM views; `worker.py` runs bounded workflows; `providers.py` handles external retrieval and extraction; `geography.py` computes production context.
