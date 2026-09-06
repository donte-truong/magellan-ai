# Decision log — 2026-09-05

These are explicit iteration points, not permanent architecture commitments.

## Edge metadata and numeric evidence confidence

**Decision:** Per the updated user request, add top-level `source`, `date`, `time`, and numeric `confidence` to every edge, plus `confidence_details` explaining the method. Use an array for `source` so corroboration and contradictions are not flattened into one arbitrary URL. Use the latest recorded evidence observation in UTC for date/time, preserving unknown publication dates on individual sources. Keep the score in an isolated deterministic function, starting with support strength, adding distinct family/content corroboration, discounting old/undated evidence, and sharply capping disputed edges. The complete versioned formula lives in EDGE_METADATA.md.

**Why:** The team needs useful edge metadata without joining the full claim ledger, and an initial sortable confidence score that can be inspected and improved. This updates the overview's prior labels-only direction while retaining its ban on unsupported probabilities. Numeric confidence supplements the evidence labels, never replaces acceptance checks.

**Tradeoff:** The weights are judgment calls, not calibrated probabilities. Independence uses family IDs plus document hashes; publication recency is a limited proxy for current relevance, not proof of truth. The score is pinned to recorded timestamps for reproducible replay. Legacy graphs/events are enriched on read from their claim IDs; their original audit files and revisions are preserved. Existing rendered files are snapshots and need regeneration to show the new metadata. No changes to BOM estimate item confidence labels.

## Full BOM import into graph research

Accept the complete generated BOM in a new `bom_estimate` field while preserving the simple `bom` API. Preserve item hierarchy and original evidence/confidence as explicitly unverified metadata on nodes and edges, with the entire snapshot in `input.json`. Re-fetch source URLs and run normal quote/entailment checks before adding verified relations. This avoids trusting a prior model's citations as if this graph had checked them. Manufacturer/part-number hints now inform planning. Keep assembly rows and original item IDs intact; do not silently infer an assembly-to-root merge. See [GRAPH_BOM_IMPORT.md](GRAPH_BOM_IMPORT.md) for contract, limits, and tradeoffs.

## OpenRouter JSON-mode compatibility

The live MiniMax M3 free endpoint rejected `json_schema` with a parameter-routing 404. An explicit `OPENROUTER_OUTPUT_MODE=json_object` sends JSON mode plus the full schema in the system prompt; the default stays `json_schema`. Local Zod validation, evidence checks, budget reservations, required-parameter filtering, and price ceilings still apply. No automatic mode or model fallback occurs. See [OpenRouter's response-format documentation](https://github.com/OpenRouterTeam/docs/blob/main/api_reference/parameters.mdx).

The first successful model response exceeded the identity summary length limit, so BOM prompt v2 asks for two short sentences targeting under 300 characters. We retained the existing 800-character validation limit and original output rather than truncating it. The local HTTP exercise captures final content verbatim before validation; hidden reasoning is excluded. Detailed outcomes are in [BOM_PICO_2_LIVE_TEST.md](BOM_PICO_2_LIVE_TEST.md).

## OpenRouter integration — explicit shared model backend

**Decision:** Add `RESEARCH_MODEL_PROVIDER=openrouter` to the shared `LiveProvider.respond()` path used by graph research and BOM/vision. Keep direct OpenAI as the default. Use OpenRouter's documented Chat Completions JSON Schema interface, translating images and normalizing usage at the transport boundary. Require a separate OpenRouter key, explicit vendor/model IDs, and conservative tariffs covering the extractor and reviewer. Tavily remains the retrieval adapter.

**Why:** This allows changing model vendors without changing pipeline, evidence, budget, or API contracts. Configured token tariffs also become OpenRouter's prompt/completion routing price ceilings. `require_parameters:true` prevents silent routing to endpoints that ignore requested parameters, and `allow_fallbacks:false` preserves the harness's no-implicit-retry policy. Local schema and semantic gates remain mandatory. These choices follow [structured-output guidance](https://openrouter.ai/docs/guides/features/structured-outputs) and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

**Tradeoff:** Both model roles use the selected backend, though their model IDs may differ. Unsupported schemas, missing compatible endpoints, refusals, and truncated results fail closed; there is no healing or cross-backend fallback. OpenRouter's returned model/provider/cost are stored as diagnostic metadata, while monetary reservations remain conservative. Models billed through additional per-image/per-request fees require separate operational accounting. Input retention depends on OpenRouter/upstream policies, not direct OpenAI's Responses `store` flag. Mocked transport tests cover text, images, credentials, schema routing, usage, and failures; no paid OpenRouter call was made during implementation.

## D01 — Next.js in a separate backend directory

**Decision:** Follow the user's updated Next.js direction rather than the overview's original FastAPI sketch. Put the app in `backend/` so the frontend team can work without colliding with root app scaffolding. Share the workflow between a CLI and Node-runtime route handlers.

**Tradeoff:** There are two app roots until integration. The frontend can call this backend through a trusted proxy or move the small route handler into a common Next.js app later. The original OpenAPI files remain untouched; differences are explicit in INTEGRATION.md.

## D02 — The agent produces atomic claims; code owns the graph

**Decision:** Separate planner, extractor, and verifier calls. Use a code-managed frontier and serial commits, with no general-purpose agent framework. All model-facing schemas are narrow. Newly verified entities generate bounded follow-up searches.

**Why:** The problem has strong semantic invariants; a free-form researcher should not decide whether to waive evidence or scope. A separate reviewer gets the proposition and cited context without the extractor's persuasive rationale.

**Tradeoff:** More calls per document, less flexible search replanning, and slower single-worker execution. The reviewer is an independent call, not independent ground truth. Next experiment: evaluate another reviewer model on fixed source snapshots.

## D03 — Source spans are verified against an immutable text representation

**Decision:** Store the full Tavily extraction privately and hash it. Send bounded relevant passages to the extractor. A proposed quote must match exactly once in the stored representation; save the actual substring and UTF-16 offsets. Never use search snippets as evidence.

**Why:** Debuggers need to reproduce why a specific edge exists. A plausible citation URL is insufficient.

**Tradeoff:** Whitespace/Unicode variations can reject legitimate evidence. Long documents use the first window plus two target-keyword windows; tables or later sections may be missed. Add normalization with an offset map or section-aware retrieval only after observed failures.

## D04 — Conservative relation and entity projection

**Decision:** Resolve only exact NFKC/case/whitespace-normalized name plus node kind. Do not drop punctuation, merge corporate suffixes, or assume aliases. Model output cannot assign confidence probabilities. Verified positive evidence yields `directly_supported`; BOMs yield `user_asserted`; explicit contrary evidence for the same triple/scope yields `disputed` when positive evidence also exists. Negative-only evidence remains in the claim ledger without an edge.

**Why:** False entity merges and false manufacturing links are worse than visible gaps. Product scope names the exact root product. Company scope resolves to an organization; generic/company claims cannot silently include a product endpoint.

**Tradeoff:** Aliases may become duplicates or be rejected as disconnected. There are no materialized inferred edges in this version, although contract enum values are preserved. Add stable identifiers and a human merge review queue before fuzzy merging.

## D05 — Edges remain informative when research stops

**Decision:** Each edge carries claim IDs, rationale, scope, support label, source counts, and caveats. Unknown branches produce open questions, not invented supplier nodes. Upstream dependency tier is computed from supported directed predicates; a separate undirected discovery radius bounds contextual exploration from product/company seeds.

**Why:** A geography or corporate context relation should not be counted as a physical input tier. A completed research job means its allowed frontier finished, not that the real supply chain is complete.

**Tradeoff:** The task radius and dependency tier are distinct. The two-hop default is smaller than the draft API default to make first runs reviewable. Missing source dates remain null; validity intervals and sophisticated contradiction chronology are future work.

## D06 — Local files and append-only histories first

**Decision:** Write ordered JSONL events, detailed operational history, source snapshots, latest graph/run/frontier JSON, and HTML/Markdown views. Use atomic replacement for individual JSON snapshots and a single writer per run. Record model/prompt versions, IDs, structured outputs, review explanations, input/output usage, failed calls, and rejection reasons. Do not store hidden reasoning or auth headers.

**Why:** Files make the first backend runnable without PostgreSQL, and `tail -f` gives immediate visibility when a call stalls.

**Tradeoff:** These files are not a transaction across ledger plus events. A process crash can leave the event log behind the latest graph, or graph/run snapshots at slightly different points. Finalization also cannot survive disk failure. SSE asks clients to refetch when it detects a terminal gap; an interrupted worker is reported as partial. No automatic resume. Next storage milestone: transactional claim ledger plus event outbox, then task leases and replayable external-call results.

## D07 — Reserve budgets before calls, favor predictable stopping

**Decision:** Cap hops, nodes, claims, searches, document attempts, model calls, tasks, input/output tokens, seconds, and estimated cost. Token reservations use UTF-8 request bytes plus protocol allowance, then reconcile successful responses to observed usage. Monetary reservations remain conservatively spent even after success/failure. Abort in-flight HTTP on cancellation/deadline. No blind retries.

**Why:** Discovery must not run indefinitely or quietly incur more provider calls after the user-set ceiling. Reserving the maximum response allowance prevents beginning an unaffordable call.

**Tradeoff:** Cost is only as reliable as configured tariffs and may overstate the bill considerably. Byte-based input estimates are conservative for ordinary text, not a provider tokenizer guarantee; an observed overrun terminates acceptance. If an API fails before usage is known, the upper reservation is retained. A different model requires explicit tariffs. We have not implemented a provider invoice reconciliation service or dedicated verification sub-budget.

## D08 — Curated replay is visibly different from live research

**Decision:** Provide an offline Raspberry Pi fixture using short real public-source excerpts and hand-authored model outputs. Mark the run, graph, every event, trace, and view as replay. Reject other products and arbitrary BOMs in this mode. No implicit fallback when live credentials fail.

**Why:** Everyone can debug the graph contract, persistence, and HTML without paid keys. A deterministic fixture must not masquerade as newly discovered evidence or validation of model quality.

**Tradeoff:** Only live mode is open-ended. Real-run provider recordings can be converted into regression fixtures later, with provenance and replay labels preserved.

## D09 — Explicit run creation authorizes this new graph

**Decision:** Starting the CLI or POSTing a run is the user's authorization to research the named product and commit verified findings to that run's new graph within its limits. The harness cannot edit existing graphs or launch unrelated jobs.

**Why:** The project's proposal/approval rule applies to later agent-proposed changes and additional research. Requiring a second approval for every finding inside an explicitly requested run would prevent the requested workflow.

**Tradeoff:** Existing graph mutations, agent chat, proposals, and approval endpoints are intentionally outside this first implementation. They must retain their approval semantics when added.

## D10 — Small local HTTP surface with bearer authentication

**Decision:** One workspace token, three active jobs, disk-backed idempotency records, authenticated SSE/JSON reads, latest revision only, localhost binding. Keep tokens out of URLs, HTML, and browser-visible source.

**Tradeoff:** No multi-tenant identity system, distributed locks, serverless durability, public deployment, CORS policy, or native EventSource token workaround. Use a trusted same-origin frontend proxy; add production identity and a durable worker before deployment.

## D11 — Debug inspection is a self-contained artifact

**Decision:** Emit JSON plus a no-script HTML directed graph/evidence inspector and a plain Markdown report. Numbered arrows link to evidence cards. Quotes, labels, metadata, and URLs are escaped, and the HTML has a restrictive CSP.

**Why:** The deliverable should be inspectable without waiting for the main frontend or loading a visualization dependency.

**Tradeoff:** This is a rudimentary layout; dense graphs can overlap. The table and evidence cards remain the reliable debugging surface. The browser automation tool rejected local-file navigation during implementation, so automated visual inspection was not completed; HTML content/escaping and generated artifacts were checked in tests.

## D12 — The BOM estimate is a separate, labelled "guesses allowed" workflow

**Decision:** `POST /v1/bom` reuses the provider adapter, budget, store, URL boundary, and passage selection, but not the claim ledger. The model may add items the evidence does not mention. Code, not the model, assigns provenance: a `web_page` source requires the quote to be found verbatim in the stored page; a quote that cannot be located is downgraded to `web_page_unverified`; the composer may only cite evidence IDs the code issued; uncited items are `guessed` with a `model_knowledge` source and can never be `high` confidence. The same OpenAI Responses and Tavily adapters are used, with image input added to the Responses call (inline base64 or a public URL) and a flat per-image token reservation.

**Why:** The requested v1 wants a usable list quickly, with honest labelling rather than no list. Keeping this outside the evidence graph preserves principle 1 (no edge without evidence) for the graph while giving the frontend a provenance-labelled estimate it can render immediately and later promote row by row into `user_asserted` BOM input for a research run.

**Tradeoff:** `inferred` and `guessed` rows are model output and can be wrong; the disclaimer and `open_questions` travel with every response. Extraction runs three documents in parallel, so history lines are serialized in the store but stage order in `history.jsonl` interleaves. The route is synchronous (one to three minutes) rather than a 202 job; convert it to a run-style job with SSE before it moves behind a browser without a proxy timeout. No curated replay exists yet, and no live request was executed during implementation because credentials were not configured; the first live runs should compare `evidenced` counts and `web_page_unverified` rates across a handful of products before touching prompts or limits.
