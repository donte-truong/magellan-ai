# Supply-chain research backend

An initial Next.js backend and standalone TypeScript command for **product → public evidence → supply graph**. The CLI and HTTP routes call the same workflow. No frontend is needed.

## Run an example now

Requires Node.js 22.6+ (verified with Node 24.13). From the repository root:

```sh
cd backend
npm ci
npm run demo
```

The command prints the absolute paths to `graph.html`, `graph.json`, `graph.md`, and run histories. Open `graph.html` in your browser, or read the Markdown. The HTML contains a directed graph, numbered relationships, quotes, scope, support labels, source metadata, and open questions. It is self-contained, has no network dependencies or scripts, and is regenerated after commits; refresh to inspect progress.

**The demo is an explicitly labeled curated replay.** It uses short official Raspberry Pi excerpts plus hand-authored extraction/verifier outputs, not a cached real model run. Expected output: five nodes (including the user-specified company context), three edges, three exact source spans. It demonstrates BCM2712 → Raspberry Pi 5, Sony UK Technology Centre → Raspberry Pi 5, and facility → Wales. Other products are rejected in replay mode.

## Run live research

Copy `.env.example` to `.env.local` and fill in `OPENAI_API_KEY` and `TAVILY_API_KEY` locally for the default direct-OpenAI backend, or use the OpenRouter configuration below. Neither file nor generated runs is committed. The CLI reads `.env.local` from its working directory; Next.js loads the same file.

```sh
npm run research -- --product "Raspberry Pi 5" --company "Raspberry Pi"
npm run research -- --input examples/raspberry-pi-5.json --mode live
npm run research -- --product "Framework Laptop 13 AMD Ryzen 7040 Series" --company "Framework" --max-hops 2 --max-seconds 300 --max-cost-minor 150
```

Supply a precise product/version. The command searches dynamically; only the replay adapter contains Raspberry Pi-specific findings. No keys are needed to build, run tests, or run the demo. Missing keys in live mode produce a clear configuration error and never trigger a replay fallback. Paid live calls were **not** executed during implementation because credentials were not configured; live REST behavior is tested with mocked provider responses.

Use `npm run research -- --help` for flags. `--out /absolute/directory` sets the parent of a newly generated `run_…` directory, never an existing run directory. Ctrl-C requests cooperative cancellation and keeps committed findings. Exit code is 0 for completed or partial graphs, 1 for failure/configuration errors, and 130 for cancellation. Always inspect `status` and `stop_reason` in stdout or `run.json`.

## Inputs

Use `--input project.json` for more control:

```json
{
  "product": "Your exact product/model",
  "company": "Optional organization context",
  "seed_urls": ["https://manufacturer.org/product-datasheet"],
  "bom": [{ "component": "Aluminum enclosure", "kind": "material", "quantity": 1, "unit": "ea" }],
  "limits": {
    "max_hops": 2,
    "max_nodes": 40,
    "max_claims": 60,
    "max_searches": 10,
    "max_documents": 12,
    "max_input_tokens": 250000,
    "max_output_tokens": 30000,
    "max_model_calls": 30,
    "max_tasks": 10,
    "max_seconds": 300,
    "max_cost_minor": 200
  }
}
```

Those are the defaults. `bom.kind` is `component` or `material`; the default is `component`. BOM entries create `INPUT_TO` edges labeled **user_asserted**, with the exact row stored as their evidence. An optional company creates a context node, not an assumed manufacturer edge. CSV uploads and product ambiguity questions are not implemented yet. Unknown fields are rejected instead of ignored.

Live mode supports direct OpenAI Responses or OpenRouter Chat Completions with structured outputs. Tavily handles search/full extraction for both. Direct OpenAI remains the default (`gpt-5.4-mini`); `OPENAI_VERIFIER_MODEL` selects its reviewer. A different direct model or any OpenRouter model requires explicit input/output tariffs covering **both** selected models. Direct default tariffs are 75/450 USD cents per million input/output tokens; search/extract each reserve 2 cents. See `.env.example` and [decision D07](docs/DECISIONS.md).

### OpenRouter

Set these in `.env.local` to use OpenRouter for graph research **and** BOM estimation, including photo inputs:

```dotenv
RESEARCH_MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=openai/gpt-4o-mini
# Optional; defaults to OPENROUTER_MODEL:
OPENROUTER_VERIFIER_MODEL=openai/gpt-4o-mini
TAVILY_API_KEY=your-tavily-key
# Conservative ceilings in USD cents per million tokens, covering both models:
RESEARCH_INPUT_CENTS_PER_MILLION=75
RESEARCH_OUTPUT_CENTS_PER_MILLION=450
```

Then use the same commands and API routes:

```sh
npm run research -- --product "Raspberry Pi 5" --company "Raspberry Pi"
npm run bom -- --description "Raspberry Pi 5 8GB"
```

No `OPENAI_API_KEY` is required in OpenRouter mode, and `OPENAI_MODEL`/`OPENAI_VERIFIER_MODEL` are ignored. Provider selection is explicit; there is no automatic switch based on whichever key exists. Restart the Next.js server after changing environment settings. Use explicit `vendor/model` IDs with structured-output support; photo inputs also need vision support. Automatic `openrouter/*` model routers are not supported because the budget is configured for specific models.

For providers supporting JSON output but not JSON Schema enforcement, set `OPENROUTER_OUTPUT_MODE=json_object` (default: `json_schema`). The schema is then included in the system prompt, and the same local Zod validation rejects invalid responses. This fixes parameter-routing errors for `minimax/minimax-m3:free`; it does not guarantee valid or accurate model output. Set both model tariffs to `0` for that free endpoint. Routing retains required-parameter checks and price ceilings. The mode applies to both selected models and is recorded in each run's configuration.

To exercise the actual BOM HTTP endpoint and retain verbatim model final responses, run `node scripts/test-bom-http.mjs examples/bom-pico-2.json` from this directory. It starts and stops a temporary localhost server, makes bounded live calls, and saves responses under `runs/http-bom-…/model-responses/`. Final content is stored before parsing as `*.final.txt`; provider errors are separate files, with hidden reasoning excluded.

To send a complete saved BOM through the graph endpoint, run `node scripts/test-graph-http.mjs runs/<bom_id>/bom.json`. It POSTs the entire response as `bom_estimate`, polls the run, and exports the graph, view, SSE, histories, and verbatim model responses. Item citations, hierarchy, part numbers and original confidence remain available as imported provenance; research verifies source documents afresh. See [GRAPH_BOM_IMPORT.md](docs/GRAPH_BOM_IMPORT.md) for the API contract and limits.

Requests use the configured JSON Schema or JSON-object mode, `provider.require_parameters: true`, no provider fallback, and prompt/completion `max_price` derived from the configured tariffs. No matching endpoint means a failure rather than a switch to unconstrained text. Local Zod validation still applies; refusals, truncation, missing usage, malformed JSON, and error envelopes never become accepted results. See [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs) and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

`config.json` records `modelProvider`; model histories include requested/returned model, upstream provider when supplied, response/request IDs, normalized token usage, and `reported_cost_usd` when supplied. Reported cost is diagnostic and does not replace the conservative reservation ledger. Token-price ceilings do not cover arbitrary per-image/per-request fees; select token-priced models and account for service charges in your operational budget. Keys, inline image bytes, and hidden reasoning are excluded from histories. OpenRouter and its chosen upstream provider process the model inputs; direct OpenAI's `store:false` setting is not a guarantee about OpenRouter retention.

`max_cost_minor` caps conservative request reservations at configured tariffs; it is not an authoritative provider invoice. Request/token ceilings and a wall-clock abort are also enforced. Tariffs must remain accurate for the selected services. Actual token usage and reserved usage are both recorded. Source/model failures keep their reservation; there are no implicit retries.

## Debug a running agent

Every graph edge now has top-level `source` (all cited source metadata), UTC `date`/`time` (latest recorded evidence observation), and numeric `confidence` (0–1). `confidence_details` records the deterministic scoring method, factor contributions, and data-quality notes. The score rewards distinct corroboration and discounts old/undated evidence and contradictions; it is not a calibrated probability. These fields appear in JSON, SSE, and both inspectors. See [EDGE_METADATA.md](docs/EDGE_METADATA.md) for the formula and legacy-read behavior. BOM estimate item confidence labels are unchanged.

The run directory is printed before planning. In a second terminal:

```sh
tail -f runs/run_YOUR_ID/events.jsonl
# Full operational details; potentially large lines:
tail -f runs/run_YOUR_ID/history.jsonl
```

| Artifact | Contents |
| --- | --- |
| `input.json` | Validated product, BOM, seeds, and limits |
| `config.json` | Mode, models, tariffs, harness/prompt/resolver/passage versions; no API keys |
| `run.json` | Latest status, counters, limits, stop reason, open questions |
| `frontier.json` | Active/pending tasks, visited URLs, scheduled target/query keys |
| `events.jsonl` | Ordered frontend-compatible lifecycle, source, rejection, commit, budget events |
| `history.jsonl` | Stage/task/call IDs, before/after tool calls, model request bodies, response/request IDs, structured outputs, verifier explanations, accepted/rejected decisions, durations |
| `sources/src_….txt` | The exact fetched representation used for span verification |
| `sources/src_….json` | Source metadata and SHA-256 of that representation |
| `graph.json` | Graph export, claim ledger, evidence, source metadata; latest revision |
| `graph.html`, `graph.md` | Human-readable inspection views |

Histories capture observable work and concise review explanations. Hidden model reasoning and authorization headers are not saved. Histories **do** include user inputs, source text, and prompts; treat them as private debugging files. They use restrictive local file permissions and are gitignored. Search hits are operational records only and cannot serve as source spans.

For a suspect edge, follow `claim_ids` → `evidence[].source_id` → `sources/*.txt`. The locator is `text-utf16:START-END;sha256=HASH`, with half-open JavaScript string offsets. The exact substring must equal `span`. Search `history.jsonl` for the claim ID and its `task_id` to find the original prompt, extraction, and independent review.

## Next.js API

Set `RESEARCH_API_TOKEN` in `.env.local` to a locally generated token, then:

```sh
npm run dev
# Or: npm run build && npm start
```

This binds to `127.0.0.1:3001`. All `/v1` routes require `Authorization: Bearer TOKEN`. In the following examples, `TOKEN` is a shell variable you set locally to that token:

```sh
curl -sS http://127.0.0.1:3001/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pi5-first-run' \
  -d '{"product":"Raspberry Pi 5","company":"Raspberry Pi","mode":"replay"}'

curl -N http://127.0.0.1:3001/v1/runs/run_YOUR_ID/events \
  -H "Authorization: Bearer $TOKEN" -H 'Last-Event-ID: 0'

curl -sS http://127.0.0.1:3001/v1/graphs/gph_YOUR_ID/export \
  -H "Authorization: Bearer $TOKEN" > graph.json
```

Omit `mode` or use `live` for actual research. Run creation returns 202; the same idempotency key/body returns the prior run with 200; another body conflicts with 409. Up to three runs can be active in this single process. Poll the returned `events_url` with authenticated `fetch`; native browser `EventSource` cannot set an Authorization header. Keep the token in a backend proxy for a separately hosted frontend.

Implemented routes and contract differences are listed in [INTEGRATION.md](docs/INTEGRATION.md). This is a **single long-lived local Node process with writable disk**, not a serverless worker system. Crashed workers are reported as interrupted/partial on API reads; snapshots remain inspectable. Automatic resume and cross-process idempotency/locking are not implemented.

## Bill-of-materials estimate (MVP)

`POST /v1/bom` takes a product description, a product link, and/or a photo and returns a JSON bill of materials synchronously. It is a separate, deliberately looser workflow from the evidence graph: the model may fill gaps with informed guesses, but every item records where the agent got it from (`sources`) and carries a code-assigned `basis`:

| `basis` | Meaning |
| --- | --- |
| `evidenced` | At least one source is a fetched web page whose quote was found verbatim in the stored copy (`web_page`, with a locator into `sources/src_….txt`). |
| `inferred` | Supported only by weaker provenance: a page quote that could not be located verbatim (`web_page_unverified`), a search snippet (`search_snippet`), the photo (`image_analysis`), or the user's own text (`user_input`). |
| `guessed` | No retrieved source; the model added it from general knowledge (`model_knowledge`). Confidence is capped at `medium`. |

`manufacturer` on an item is who makes the part; `sources` is where the agent found it. `confidence` is a label (`high`/`medium`/`low`), never a percentage. The composer can only cite evidence IDs the code issued; unknown IDs are dropped and logged, and uncited items become guesses.

Same keys and `RESEARCH_API_TOKEN` as above. With the server running:

```sh
curl -sS http://127.0.0.1:3001/v1/bom \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"description":"Raspberry Pi 5 8GB","url":"https://www.raspberrypi.com/products/raspberry-pi-5/"}'

# Photo upload (multipart). Fields: description, url, image_url, company, limits (JSON string), image (file)
curl -sS http://127.0.0.1:3001/v1/bom -H "Authorization: Bearer $TOKEN" \
  -F description="board found in a drawer" -F image=@photo.jpg
```

JSON bodies may carry the photo inline as `{"image":{"data":"<base64>","media_type":"image/jpeg"}}` (JPEG, PNG, WebP, or GIF, at most 5 MB, bytes must match the declared type) or as a public `image_url`. At least one of `description`, `url`, `image`, `image_url` is required; `company` and `limits` are optional. Default limits: `max_searches` 5, `max_documents` 6, `max_items` 60, `max_seconds` 180, `max_model_calls` 16, `max_cost_minor` 300, plus token ceilings. See [examples/bom-request.json](examples/bom-request.json).

The response is the persisted `bom.json`: `product` (what was identified and from which inputs), `items[]`, `evidence[]` (every candidate the composer could cite), `sources[]`, `open_questions[]`, `usage`, and a `disclaimer`. Re-read it at `GET /v1/bom/{bom_id}`; provider calls are in `GET /v1/bom/{bom_id}/history`. Expect roughly one to three minutes per request at default limits. `status` is `completed`, `partial` (budget stop or a mid-run provider failure; items may then be unmerged raw extractions), `failed`, or `cancelled`; always read `open_questions`. Idempotency keys are not supported on this route, and at most three estimates run at once.

From the CLI, without the HTTP server:

```sh
npm run bom -- --description "Raspberry Pi 5 8GB" --url https://www.raspberrypi.com/products/raspberry-pi-5/
npm run bom -- --image ./photo.jpg
```

Pipeline: product link fetch → photo analysis → identify the product and plan searches → Tavily search → fetch the top pages (at most two per host) → per-page extraction with verbatim-quote checks → final composition. Artifacts land in `runs/bom_…/` (`bom.json`, `input.json` without image bytes, `input-image.*`, `sources/`, `history.jsonl`). There is no offline replay for this route yet; tests use a fake provider, and **no live request was executed during implementation** because keys were not configured.

## Validate and iterate

```sh
npm test
npm run typecheck
npm run build
npm run smoke:http
```

Tests cover exact source provenance, hallucinated and ambiguous citations, scope, direction, deduplication, contradictions, user BOMs, budget/cancellation/deadline behavior, mocked live REST payloads, auth, idempotency, SSE replay, and HTML escaping. Passing these tests establishes workflow invariants, not the factual accuracy of a real model on arbitrary products.

`smoke:http` starts the production Next.js server on localhost port 3137 with a temporary random token, runs an authenticated replay through real HTTP and SSE, and shuts it down. It prints the temporary artifact directory. Set `RESEARCH_SMOKE_PORT` if that port is occupied.

- [RESEARCH.md](docs/RESEARCH.md): two Sol research subagents' findings, primary references, adopted techniques.
- [DECISIONS.md](docs/DECISIONS.md): creative/architecture decisions, alternatives, limits, next experiments.
- [INTEGRATION.md](docs/INTEGRATION.md): frontend handoff and implemented contract subset.

Start iteration with a small exact-product live run. Inspect rejected claims and missed evidence before increasing budgets. Add regression cases for real failures; evaluate citation validity separately from how much of the supply chain is discovered.
