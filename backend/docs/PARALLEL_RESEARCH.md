# Parallel research: getting more graph per token and per minute

Written 2026-09-06 after the first GPT-5.6 Sol runs. Those runs stopped at 26 and 33 nodes not because the model ran out of ability but because the run's caps bound (search cap, then output-token cap) and because each task ran alone, so a 600-second run could finish only nine to thirteen tasks. This note records what was changed, what was deliberately not built, and what is left.

## What limits graph size

| Limit | What binds it | Lever |
| --- | --- | --- |
| Wall clock (`max_seconds`, contract max 900) | one task at a time, each with 1 planner call, 1 to 4 extraction calls, 1 verification call | task-level parallelism |
| Tokens (`max_input_tokens`, `max_output_tokens`) | input is dominated by page passages sent to extraction; output by planner and rationale text | cheaper extraction model, tighter passages, fewer wasted documents |
| Searches (`max_searches`) | three queries per task, many of them for targets that can have no public answer | planner skips, stagnation pauses, relevance gate |
| Coherence | duplicates consume node budget and split evidence | deterministic rules, then bounded model resolution |

The caps are run parameters, not properties of the loop; a run that wants 150 nodes has to ask for them. What the loop owes the caller is a good ratio of verified, non-duplicate nodes per token and per second.

## Built

1. **A fair task pool** (`TASK_CONCURRENCY`, default 3). The scheduler picks the next target from a branch with no task in flight, then by the existing fairness key. Document analyses across all running tasks share one `RESEARCH_CONCURRENCY` semaphore. Every graph commit and budget charge is a synchronous step on the event loop, so the ordering and budget rules are exactly those of the sequential loop; the first budget stop or provider failure cancels the other tasks and the run ends as before.
2. **Model roles with independent reasoning settings.** Extraction is volume and quoting; verification, planning, and resolution are judgment. `OPENROUTER_*_MODEL` and `OPENROUTER_REASONING_*` per role allow a non-reasoning extraction model beside a reasoning judgment model, which is where most of the cost saving is.
3. **Bounded model resolution** (`MODEL_RESOLUTION`). One call per document at most, with a candidate list of at most twelve nodes (token near-duplicates plus siblings under the same anchor). The model never sees the graph. `same` merges with an `entity.merged` event and rationale; `unsure` flags; deterministic identifier conflicts win.

## Considered and not built

- **Recursive endpoint calls per node.** Loses the shared graph, the reuse memory, and fair scheduling; every child run would re-read the same product pages.
- **A graph-traversal tool for the model.** The planner needs the target, its unanswered relation types, recent triples, and failed queries; that already fits in 6,000 characters. A tool loop would add calls without adding decisions.
- **Multi-agent debate or a separate critic per claim.** Verification already is an independent second call over the quote window. A third opinion on the same window costs as much as the second and catches little; the evidence rules (verbatim span, scope, independent verification) are the guarantee, not agent count.
- **Sharding the graph across worker processes.** The single-writer ledger is the correctness boundary. In-process concurrency reaches the same overlap without cross-process merges.

## Built since, from the live runs

- **Cross-target reuse of stored analyses.** Harvested findings are target-independent, so a page analyzed once is committed for any later target from its stored, materialized findings (rejected findings dropped) without another model call. In a pooled Pi run 28 of 51 analyses had been repeats; iPhone runs reused 17 to 32 analyses each.
- **Static gates before verification**, a four-source cap per relation, one edge per relation across scopes, and orphan retry for claims whose whole is not yet connected.
- **Tolerant span location**: quotes that differ from the page only in whitespace, citation markers, or typographic punctuation resolve to the page's own verbatim text (span misses fell from 80 to 24 in one run).
- **Adaptive allowances**: the product task gets twice the per-task allowance and a replan when thin; tier-2 and deeper tasks get one search fewer.

## Left to do

- **A whole-graph audit at the end of a run:** one judgment call over the final triple list asking for edges that look reversed, mis-kinded, or not supply-chain relations, emitting review flags. Cheap, and the only place a model sees the graph as a whole.
- **Per-branch planner memory** (what a branch has already learned) so that deep tasks do not re-ask the product-level questions.
- **Priority-aware caps:** fewer queries for targets the planner marks low priority, and none for targets it would skip at the current budget.
- **Quote quality from tables:** DeepSeek's quotes from specification tables still fail exact location; a table-aware passage selector (rows as lines) would help the extraction model quote verbatim.
