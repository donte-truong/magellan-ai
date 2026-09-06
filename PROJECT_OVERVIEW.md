# Supply Chain OSINT AI — Project Overview

**One line:** Type a product, get a sourced map of its supply chain. Then watch it, stress it, and ask it questions.

## What this is

An AI research workspace that takes a product name (plus an optional company and bill of materials) and builds an explorable graph of what the product is made of, who makes those parts, where, and from which raw materials — using only public evidence. Research agents search filings, supplier lists, teardowns, datasheets, and government datasets; extract specific claims; verify that the cited sentence actually exists and says what the claim says; resolve company and facility identities; and commit edges to a graph that grows live on screen.

Every edge carries its evidence. Click any relationship and you see the exact source span, publisher, date, scope, and a support label (directly supported, inferred, disputed, user-asserted, unresolved). Gaps are shown as open questions, not hidden.

## Why it exists

Existing supply-chain platforms (Altana, Everstream, Sourcemap, Prewave) are excellent but require the customer's own supplier data or licensed shipment records before they show anything. Nobody lets an analyst, journalist, policy researcher, or hardware founder start cold from a product name. Public evidence is thinner than proprietary data, so the product's value is in how carefully it handles that: provenance on everything, explicit uncertainty, and no invented suppliers.

## What it does (v1 scope)

| Capability | Summary |
|---|---|
| **Research runs** | Bounded agent workflow: plan → search → fetch → extract → verify → resolve → commit. Hard caps on hops, nodes, documents, tokens, time, and cost. |
| **Evidence graph** | Typed nodes (product, component, material, organization, facility, geography) and predicates; claim ledger underneath; JSON export. |
| **Geography** | Facilities with evidenced locations on a map; material nodes annotated with country production shares (USGS, UN Comtrade) and a concentration index. |
| **Market layer** | Nodes mapped to instruments (commodity futures, supplier equities, FX, freight indices); per-instrument moves and volatility flags. |
| **Portfolios** | Weighted sets of saved graphs; exposure-weighted volatility over time with component decomposition; backtests against historical shock events, including an early-warning evaluation (did markets move before the shock?). |
| **Scenarios** | Forward simulation of outages, price shocks, export restrictions, and route disruptions; affected paths with the weakest link and stated assumptions. Never mutates the graph. |
| **Agent** | Chat over a graph or portfolio. Can query, explain paths, pull evidence, run scenarios, and compute volatility. Can *propose* graph edits, further research, or portfolio changes — a human approves before anything is written. Every factual statement cites a claim, source, or computation; uncited statements are visibly flagged. |

## Principles everyone should follow

1. **No edge without evidence.** A claim needs a stored source span (or a BOM row, labelled user-asserted). Search snippets are hints, not evidence.
2. **Scope is part of the claim.** A company-level supplier list does not prove a specific product uses a specific factory. Label it company scope.
3. **Explain confidence.** Support labels say what sources state. Edges also carry a deterministic 0–1 evidence confidence score with its method and factors; this is a heuristic, not a model-generated percentage or calibrated probability.
4. **Every number ships with its method.** Volatility, concentration, exposure, and scenario impact are returned with `method` and `data_quality`; the UI labels them accordingly.
5. **Agents propose; people approve.** Writes to graphs and new research go through proposals. Scenarios are the only thing an agent may run unprompted, because they don't change the graph.
6. **Untrusted text stays data.** Web pages and uploads never become instructions to the system.
7. **Missing means unknown, not absent.** A branch with no evidence is a research task, not proof of a clean or simple supply chain.

## Architecture in one breath

React + TypeScript + Cytoscape.js frontend · FastAPI + Pydantic API · PostgreSQL claim ledger with JSONB · one worker process running asyncio research slots · server-sent events for live graph growth and agent streaming · one pluggable search adapter (Tavily) · market data from a fixture provider first, live feed later.

## What it is not

Not a compliance determination, a forecast, or investment advice. Not an exhaustive map of the physical economy. Not a system that fabricates a plausible-looking supply chain when the evidence runs out. Restricted-entity and labor-risk matches are research flags for human review.

## Where to look

- `Supply_Chain_OSINT_AI_Design_v2.docx` — full design: rationale, workflow, data model, evaluation, schedule, security.
- `API_SPEC.md` — resource model, flows, SSE events, agent protocol, open decisions.
- `openapi.yaml` — authoritative field names and types; generate clients from this.

**Demo product:** current iPhone model (Apple supplier list + SEC Form SD + teardowns give a first-party three-hop path). Backup: Raspberry Pi 5.
**Team:** four people, 36 hours. A: API/storage · B: retrieval/agents · C: graph UX/map · D: evaluation, market data, demo.
