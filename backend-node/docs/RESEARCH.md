# Research notes — 2026-09-05

The implementation was preceded by two **gpt-5.6-sol** research subagents, as requested. One examined deep research orchestration, stopping, persistence, and prompt-injection defenses. The other examined provider APIs, evidence verification, entity resolution, and a concrete Raspberry Pi source path. Both used primary sources and supplied recommendations; all implementation remained in the main task.

## Techniques adapted

| Research finding | Adaptation in this prototype | Limit or follow-up |
| --- | --- | --- |
| Explicit task objectives prevent duplicated work and unclear delegation. Research should explore broadly, then follow discovered leads. [Anthropic research engineering](https://www.anthropic.com/engineering/multi-agent-research-system) | Model plans at most three question/query/reason objects; verified entities become bounded follow-up tasks. Plan, active task, and remaining frontier are persisted. | One sequential worker; no recursive agent spawning. Follow-up searches use fixed templates. |
| Known stages and clear evaluation criteria suit explicit workflows and code gates. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Code owns plan → search → fetch → extract → verify → resolve → commit. Extractor and reviewer have separate contexts, schemas, and no tools. | Same model by default; separate verifier model configurable. Correlated model errors remain possible. |
| Long-running workflows benefit from checkpoints and durable task results. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Save documents, events, model outputs, frontier, and graph checkpoints throughout execution. New runs get distinct directories. | File snapshots support inspection, not transparent continuation. Database transactions, leases, and an outbox are deferred. |
| Exact quotes and positional selectors serve different purposes. [W3C Web Annotation](https://www.w3.org/TR/annotation-model/#text-quote-selector) | Store quote, exact-text SHA-256, and half-open UTF-16 offsets. Verifier sees a short surrounding context. | No offset-preserving normalization fallback yet; ambiguous or changed quotes fail closed. |
| Citation presence and actual evidential support are separate evaluation targets. [ALCE, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.398/) | Deterministic exact-span check followed by semantic entailment, scope, entity, and polarity review. | A model reviewer is fallible; human audits and labeled live eval cases remain necessary. |
| Separating untrusted data from control flow reduces prompt-injection risk. [CaMeL](https://arxiv.org/abs/2503.18813) | Extractor sees a single source, has no tools, and emits schema-restricted claims. Code owns provider URLs, budgets, search templates, and commits. Source text cannot select tool names or read credentials. | This borrows capability separation, not CaMeL's complete information-flow proof or policy engine. |

We did not adopt broad parallel worker spawning initially. Source identity, shared budgets, and commit ordering matter here, while the first deliverable is a small inspectable backend. Parallel workers are a useful next experiment after atomic storage is available. Anthropic's post reports that multi-agent systems can be substantially more expensive, reinforcing the need to measure marginal findings per request before increasing concurrency.

## Retrieval and structured output

[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) provides discovery results. We request basic search, four results, no generated answer, and no raw content. Ranking and snippets are hints; neither becomes evidence.

[Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) provides full selected-page text. We deliberately omit a retrieval `query`, which would request selected fragments, and store the full returned representation before choosing bounded passages for the model. Basic extraction may miss tables; an explicit advanced-extraction fallback should be evaluated against failures rather than silently added to every run. Requests and usage are recorded through the REST adapter.

[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) supplies schema-constrained extraction and verification. All model-output fields are required, optional concepts are nullable, and code validates responses again with Zod. Incomplete, refused, malformed, or omitted results never become partially accepted claims. Schemas guarantee shape, not truth. The [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create) supplies request status and token usage; only visible structured text and operational metadata are retained.

The initial runtime model is [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), whose documented input/output prices were $0.75/$4.50 per million tokens when checked. This runtime default is separate from the explicitly requested Sol research subagents used during implementation.

## Evidence boundaries specific to supply chains

- A branded component does not establish which organization physically fabricated it. A design relationship must not silently turn into `MANUFACTURES`.
- Company supplier evidence stays company scope. A product-specific supplier relationship needs product-specific evidence.
- A facility and its corporate owner are different node kinds. A named organization cannot be automatically merged with its factory.
- Omission is not a negative claim. Only explicit source negations enter contradiction handling.
- Multiple suppliers are not automatically contradictory. This implementation only disputes the same normalized triple and scope with explicit opposite polarity. Dates are unknown in most live extractions, so temporal succession requires review.
- More URLs do not necessarily mean independent evidence. Same-content duplicates are suppressed; host-based source families are a conservative heuristic, not a verified syndication graph.

## Curated replay sources

The short verbatim excerpts live in `src/research/replay.ts` (each webpage contributes fewer than 25 quoted words). The subagent checked them against these official pages on 2026-09-05:

1. [Raspberry Pi 5 product page](https://www.raspberrypi.com/products/raspberry-pi-5/): BCM2712 inclusion; no publication date supplied.
2. [Introducing Raspberry Pi 5](https://www.raspberrypi.com/news/introducing-raspberry-pi-5/): Sony UK Technology Centre manufactures the product; published 2023-09-28.
3. [Factory floor in Wales](https://www.raspberrypi.com/news/explore-the-raspberry-pi-factory-floor-in-wales-uk/): facility location; published 2023-08-01.

The replay is not presented as a current complete supply chain, and its verifier outputs are explicitly hand-authored. It is a repeatable integration specimen for artifact layout and ledger behavior, not a live-model accuracy evaluation.

## Next evaluation batch

Use five precise products with known primary documents, plus adversarial synthetic pages. Label expected relations, exact evidence spans, and forbidden scope/identity upgrades. Track: valid citation fraction; verified relation recall against that small reference; inappropriate scope upgrades; fabricated manufacturer identities; duplicate-source inflation; accepted findings per request; and reason for each early stop. Compare extraction/verifier prompts on the same snapshots before changing retrieval or budgets.
