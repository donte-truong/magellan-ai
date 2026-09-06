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

Live arbitrary-product research requires these `.env` settings:

```dotenv
RESEARCH_PROVIDER=live
TAVILY_API_KEY=your-key
OPENAI_API_KEY=your-key
OPENAI_MODEL=your-available-structured-output-model
```

Live research searches Tavily with fetched `raw_content`, extracts structured relationships, checks exact quoted spans locally, and separately verifies entailment and scope. Search snippets are never evidence. Extraction has no tools or graph-write capability. Only the worker commits validated findings. Geography searches named facilities and verifies their country/address; coordinates stay null unless quoted explicitly. No address-to-coordinate inference is performed. Model verification is fallible: claims remain inspectable and subject to human review.

Each run enforces hops, nodes, claims, searches, documents, input/output tokens and elapsed time. A timeout, cancellation or exhausted budget preserves committed findings. Unfinished branches are returned as open questions. Live cost is omitted when unknown; optional operator billing rates produce a rounded-up minor-unit estimate. The API contract does not define a monetary budget field. Token reservations use conservative UTF-8 byte bounds before calls, then reconcile provider usage; interrupted calls can retain conservative reservations.

Provider contracts: [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Model selection is explicit configuration; no provider credentials are required for tests.

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

From the repository root, `docker compose up --build` starts PostgreSQL, runs Alembic migrations, then starts the API and a separate worker. The Compose defaults are for local development; the API is bound to loopback. Runtime and test dependency versions are locked separately.

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
