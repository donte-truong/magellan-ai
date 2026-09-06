# Deeper graphs plan (Option 2: one context-carrying research loop)

Status: revision 2 after review, 2026-09-06; phases 1 to 4 implemented the same day, phase 5 (limit increases) pending evaluation. Sequenced as: baseline fixtures and diagnostics → harvesting, document reuse, and resolution → contextual planning and fair scheduling → model-role experiments → measured limit increases.

## Summary

Keep one run, one graph, and one worker loop, and make the loop stateful and planned. The existing BOM integration stays as it is: imported rows seed the graph as user-asserted edges with preserved provenance, cited pages are re-read as seeds, imported manufacturer and part-number hints sharpen search queries, and an assembly row matching the product root is kept as metadata rather than a self-edge. The new work is (1) letting extraction harvest any relationship a page supports, (2) reusing documents and resolving entities deterministically, (3) giving a planner broad graph context and scheduling branches fairly, (4) a consistent model-role mechanism for both providers, and (5) durable, private debugging so the above can be measured before limits rise. Evidence rules do not change: verbatim spans in a stored source, independent verification, and product, company, and generic scope.

| Decision | Choice | Why |
| --- | --- | --- |
| Unit of work | One run, one graph, planned tasks | Context, deduplication, and budgets only work inside one loop; per-node runs cannot see siblings or parents. |
| Harvesting | Change the provider and commit contracts to arbitrary subject/object relations | Today `Finding` describes one entity attached to the task target; pages naming several parts are mostly discarded. This is a contract change across `Finding`, `analyze()`, `commit_document()`, and the fixture provider, not a prompt tweak. |
| Resolution | Deterministic: normalized label within kind, evidence-backed aliases, part number only with manufacturer identity and compatible kind | Wrong merges create false supply links that the confidence score then corroborates. Imported hints guide searches and never authorize a merge. |
| Scheduling | Fair opportunity per branch with explicit redistribution, including seed work | First-come breadth-first lets the widest tier exhaust the budget. Percentages without a rule would be arbitrary. |
| Planning | Initial plan per run, replan on poor yield or new evidence, context bounded by a token budget | Per-task planning is the alternative to compare experimentally; neither is assumed better in advance. |
| Model roles | One role-selection mechanism (extraction, verifier, planner) for OpenAI and OpenRouter | OpenRouter already has a verifier model; direct OpenAI uses one model. Roles come before any planner setting. |
| Depth cap | Stay at `max_hops` 4 until harvesting and planning are measured | Deeper hops on the current loop mostly yield generic-scope edges. |

## Current state, stated precisely

- Tiers: the product root is tier 0 and `refresh()` computes upstream distance through the dependency predicates (INPUT_TO, PART_OF, MANUFACTURES, PRODUCES, PROCESSED_BY, SUPPLIES). This convention is kept throughout.
- Loop: `process_run` ingests an upload or estimate, re-reads seed pages against the root, then walks nodes breadth-first. Per node it runs one templated Tavily search (with imported part-number and maker hints), reads up to five results, and calls `analyze()`, which extracts relationships *into* the target and verifies them. `commit_document()` supplies the target as the object of every finding and rejects company-scope findings because no organization anchor is resolved.
- Text: the live adapter analyzes at most the first 20,000 characters of a page.
- Matching: exact case-folded label within a kind. No aliases, no identifiers.
- Completion: the normal path ends `partial` with `research_exhausted`; queue exhaustion does not claim complete coverage.
- Limits: `RunLimits` enforces hops, nodes, claims, searches, documents, input and output tokens, and seconds. Per-task limits, model-call limits, and a total monetary ceiling do not exist and would be new API features.
- Recovery: runs, graph revisions, events, ownership, and leases are in the database; the frontier and visited set live in `process_run()`; an interrupted run is finalized as `partial`, never resumed. That policy is preserved.
- Debugging: the BOM estimator keeps a bounded history of validated outputs; graph research keeps none.

## Design

### 1. Baseline fixtures and diagnostics

- Fixture: add a second tier to the Raspberry Pi 5 example (parts of the BCM2712 named by the same official page) so multi-hop chains, order-independent candidate processing, and harvesting are covered without keys. Keep every existing fixture test.
- Private model-call history for research: a bounded per-run `trace` resource (last 200 entries, each truncated) recording stage, target, request identifiers, token usage, and verbatim model text *before* validation, plus the classified failure when validation fails. Exposed only through an authenticated `GET /v1/runs/{run_id}/history`, never in events or graph exports.
- Failure classes: `model_output_invalid` (malformed, refused, or schema-invalid output) fails the current task visibly (a `task.finished` outcome and an open question) and the loop continues; `provider_timeout` and `source_unavailable` (network, HTTP, quota) end the run as today; `BudgetExceeded`, cancellation, and lease loss propagate unchanged.
- Diagnostics in the run: `frontier` as a new top-level `Run` field (`dict[str, int]` of pending tasks per tier) rather than nesting inside `progress`, which the contract types as `dict[str, int]`. Update the generated OpenAPI and the frontend `Run` type.

### 2. Harvesting, document reuse, and resolution

Provider contract. `Finding` gains an explicit object: `object_label` and `object_kind` (null means the task target). The extraction schema asks for subject and object with kinds, a part number and manufacturer for the subject when the page states them, and a verbatim span. The fixture provider yields the same shape.

Commit contract, in code, order-independent per document (repeat passes until no candidate can be placed):

- Predicate and kind compatibility and direction, from the Node ledger table: INPUT_TO and PART_OF go component or material → product, component, or material; MANUFACTURES and PRODUCES go organization or facility → product, component, or material; SUPPLIES goes organization or facility → organization or facility; PROCESSED_BY goes material or component → organization or facility; OPERATES organization → facility; LOCATED_IN facility or organization → geography; OWNED_BY organization or facility → organization.
- Connection: at least one endpoint must resolve to an existing node; the other is created only if the resolved endpoint's tier plus one is within `max_hops` (or the endpoint is a non-dependency node such as an organization at any depth).
- Scope anchors: product scope anchors to the root and requires the exact product; company scope resolves to an organization node among the endpoints or the run's company, and is rejected otherwise (today it is always rejected; this is the extension); generic scope may not carry a product endpoint.
- Existing gates stay: verbatim span in the stored source, verification verdict per candidate, duplicate-span suppression, node and claim budgets checked before mutation.
- Corroborating an imported relationship and independently supporting its quantity remain distinct: a public claim on an imported edge raises the support label, while `quantity_support_label` stays `user_asserted` unless the public claim itself carries a verified quantity.

Document reuse. Sources are keyed by content hash; a page seen again attaches to the existing source record instead of a new one, and the run tracks which (target, relation) questions each document has already been analyzed for so the same page is not re-extracted for the same question. Passage selection replaces the flat 20,000-character cut: the first 8,000 characters plus up to two 6,000-character windows chosen by target label and hint keyword density, joined with omission markers, with the full page (up to 60,000 characters) stored as the source body so spans remain verifiable.

Resolution. Match, in order: normalized label (NFKC, case-fold, collapsed whitespace) within the same kind; an evidence-backed alias recorded on a node from a verified finding; a part number in `external_ids.mpn` only when the manufacturer also matches and the kinds are compatible. Two candidate nodes matching the same finding, or one node matching with a conflicting identifier, is ambiguous: emit `entity.review_needed`, create no merge, and attach the claim to a new node. Imported `custom.bom_items` values are never consulted for matching. Tests cover identifier conflicts, ambiguous matches, and package or revision suffix differences ("BCM2712" versus "BCM2712C1" stay distinct).

### 3. Contextual planning and fair scheduling

Planner input (bounded to a character budget, oldest material dropped first): product and company; the target with tier, kind, identifiers, aliases, and imported hints; compact relationship triples already in the graph with scope and support label; previous queries for this target and queries that yielded nothing; the open questions; which relation types are still unanswered for the target (composition known does not mean manufacturer known); remaining searches, documents, and seconds. Planner output: relation sought, up to three queries each with expected source types and a reason, a skip flag with reason, and a priority. Queries are data inside a fixed search request; the planner cannot select tools, write to the graph, or waive verification. A planner failure falls back to tier and kind templates.

Planning cadence: plan when a task is first scheduled; replan once for the same target when its first query yields no verified finding and budget remains, listing the failed query. Per-task planning versus this cadence is an experiment in phase 4, measured on the evaluation set.

Scheduling: a branch is a tier-1 subtree, with seed work charged to the root branch. Pick the next task from the branch that has consumed the fewest documents relative to its opportunities; ties go to the lower tier, then to the higher planner priority, then to targets with more unanswered relation types. When a branch's frontier empties, its remaining opportunity is available to the others. New per-task caps, `max_searches_per_task` (3) and `max_documents_per_task` (4), are new `RunLimits` fields; all global caps remain.

Events: `task.planned` with target, relation sought, queries, and skip reason; `task.started` and `task.finished` unchanged in shape, with `relation_sought` now the planner's value.

### 4. Model roles

One mechanism for both providers: `structured(..., role=extraction|verifier|planner)`. Settings `OPENAI_VERIFIER_MODEL`, `OPENAI_PLANNER_MODEL`, `OPENROUTER_VERIFIER_MODEL` (exists), and `OPENROUTER_PLANNER_MODEL`; a missing planner model falls back to the verifier model, which falls back to the extraction model. Routing price ceilings (OpenRouter `max_price`, derived from the billing rates) stay distinct from `cost_minor`, which estimates a whole run's spend from usage. A total monetary ceiling per run is a possible new limit, not an existing one.

### 5. Measured limit increases

Only after the evaluation set shows more supported upstream paths at similar citation validity: raise default `max_documents` and `max_searches`, then consider hops beyond 4.

## Evaluation

- Keep all existing fixture tests. Add: multi-hop chains through the fixture's second tier; order-independent candidate processing (a child relation listed before its parent); scope mistakes (company scope without an anchor, generic scope with a product endpoint); identifier collisions and ambiguity; repeated documents across tasks; malformed verifier responses producing a visible task failure while other tasks proceed.
- Metrics: supported upstream paths (counted through dependency predicates only, separately from contextual geography or designer relations), verified edges per tier, citation validity on a sample, duplicate-entity and review-needed rates, documents per verified edge, planner skip and replan rates, cost.
- Live evaluation set: five precise products with known primary documents and a labelled list of expected tier-2 entities; runs recorded so later comparisons need no new paid calls.

## Risks and mitigations

- Cost: per-task caps, fair scheduling, and global ceilings bound it; planner skips release budget; defaults rise only in phase 5.
- Drift: planner queries are data; no tool selection, no graph writes, no verification bypass.
- Bad merges: deterministic matching; ambiguity goes to `entity.review_needed`, never to a merge.
- Longer runs: leases, SSE, and polling already handle multi-minute runs; fair scheduling bounds the tail.
- Fixture divergence: every stage keeps a fixture implementation.

## Follow-ups and stretch goals

Contradiction extraction feeding the disputed cap; a per-node "deepen" action that enqueues a planned task into the existing run; hops beyond 4; parallel branches within one run on the worker slots behind the single-writer commit path; multi-agent only if per-branch tool use or mid-run human steering becomes a requirement; recorded live runs as replay fixtures; source credibility and temporal validity as confidence factors once analyst-labelled data exists; run resumability, only if added deliberately with a persisted frontier.
