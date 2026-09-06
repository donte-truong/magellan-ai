# Graph research from a full BOM estimate

`POST /v1/runs` now accepts a completed or partial `/v1/bom` response as `bom_estimate`:

```js
const response = await fetch('/v1/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    mode: 'live',
    product: bom.product.name,
    ...(bom.product.brand ? { company: bom.product.brand } : {}),
    bom_estimate: bom,
    limits: { max_documents: 8, max_seconds: 240, max_cost_minor: 100 }
  })
});
const run = await response.json(); // 202; poll GET /v1/runs/{id}
```

The CLI's `--input` accepts the same shape without `mode` (use `--mode live`). The legacy `bom: [{component, kind, quantity, unit}]` contract still works. Supplying both a nonempty simple BOM and an estimate is rejected. The product must match the estimate's name after case/whitespace normalization; this prevents accidentally researching a different product under the imported citations.

## Preserved information and research behavior

- `input.json` retains the complete parsed estimate: product, items, evidence snapshot, source registry, inputs, usage, timestamps and other snapshot fields.
- Imported `INPUT_TO` edges carry the original item fields under `data.custom.bom_estimate`, including item ID, parent item ID, part number, manufacturer, material, notes, basis, confidence, references, quote locators, and associated source metadata. Their evidence document also contains this information. The HTML inspector has an expandable provenance section.
- Component/material nodes expose a `data.custom.bom_items` array, preserving multiple imported item records if exact-name resolution merges nodes. The original item IDs let clients resolve `parent_item_id` across these records.
- Hierarchy is retained as estimate metadata; it is not automatically turned into verified `PART_OF` edges. The assembly row, if present, is retained rather than silently removed. This can create a board-as-component node alongside the graph's product root; inspect and improve entity resolution later.
- Every imported relation starts as `user_asserted` with graph confidence 0.25. Its top-level `source` refers to the import document. Original web citations are preserved in the nested provenance, explicitly marked `imported_not_independently_verified`. A BOM `evidenced/high` label never grants graph `directly_supported` status.
- Up to ten unique HTTP(S) URLs from the estimate's source registry become research seeds, after explicit seeds. These pages are retrieved and checked afresh. Imported content hashes, quotes, and dates are not evidence that this run fetched or verified those pages.
- Planning receives item IDs, names, categories, parent IDs, manufacturer and part-number hints, and original basis/confidence, labeled as an unverified estimate. This lets the planner prioritize component-level research. Full original metadata remains in the persisted input and graph; it is not all copied into every prompt.

## Validation and limits

The POST body is bounded to 2 MB. The import contract allows at most 200 items and 100 registered sources; normal graph node/claim/task/time/cost limits still apply and can yield a partial graph. Duplicate item/source IDs, dangling source/parent IDs, and cyclic parent links are rejected. Citation/seed URLs pass the existing public-URL checks before any retrieval. The existing API authentication boundary applies.

The structural JSON Schema is [bom-estimate.schema.json](bom-estimate.schema.json), generated from `src/research/bom-import.ts`; root `openapi.yaml` references it. Cross-record constraints (cycles, ID uniqueness, references, product agreement and mutually exclusive BOM forms) are runtime validations. Tests in `tests/bom-import.test.ts` cover preservation, planning context, validation, and separation of imported confidence from verified graph support.

## Reproduce the live test

From `backend/` with provider settings in `.env.local`:

```sh
node scripts/test-graph-http.mjs runs/bom_8d670889dbbb4acba697a3a243af4bd7/bom.json
```

The script submits the full BOM without flattening, starts a temporary localhost server on port 3139, polls the run, exports graph JSON/HTML and SSE, saves agent histories and verbatim model final responses, and stops the server. Files are under `runs/http-graph-…/`, with durable run artifacts under `runs/run_…/`. The selected model is used for both extraction and review; separate calls are not independent models, and their agreement is not a factual guarantee.

## Live test observations

The older flattened-input run (`run_138be025b5124d41ba5cc67dc8dad256`) completed before the full-import change: 19 nodes, 26 edges (15 assertions and 11 directly supported), stopping at its 8-document budget after 74 seconds. It is retained only as a baseline and does not exercise the new contract.

The first full-import run (`run_80642fd1920247c2ae164179ab9d3069`) accepted the request (HTTP 202), preserved all 15 original item records and a deeply equal BOM snapshot, and exposed the provenance in graph JSON and HTML. The model then misspelled verifier field `entailed` as `entained`. Local validation rejected that response, ending the run as partial with 17 nodes and 15 imported edges. Original output is in `runs/http-graph-1788656887961/model-responses/1788656901273-68d92225-29fa-4bdb-a6d6-26ba2532ccf9.choice-0.final.txt`. No automatic repair or retry was added.

Validation: 33 automated tests, TypeScript check, and production build passed; the pre-existing nonfatal Next.js tracing warning remains.

A single manual retry with the same input/model and unchanged validation (`run_b1826c505d6148ca9da60ed4b01c7588`) produced 18 nodes and 24 edges: 15 imported assertions and 9 directly supported relations. It stopped as **partial / max_documents** at the configured 8-document limit after 98.572 seconds (3 searches, 13 model calls, 22 USD cents reserved for retrieval). One large RP2350 datasheet extraction exceeded the provider response's 2 MB limit; that source remained unavailable rather than being silently truncated. Exact-name resolution also created a second board node and some candidates exceeded the two-hop radius; both are iteration targets recorded in open questions. The result is a research snapshot, not a complete supply chain.

The successful retry's full input is deeply equal to the original BOM snapshot. All 15 imported edges carry their original provenance; every edge has source/date/time/confidence. HTTP export matches the persisted graph and SSE contains a terminal event. Artifacts:
- `runs/run_b1826c505d6148ca9da60ed4b01c7588/graph.html`: interactive links within the static graph inspector.
- `runs/run_b1826c505d6148ca9da60ed4b01c7588/graph.json`: graph and enriched metadata.
- `runs/run_b1826c505d6148ca9da60ed4b01c7588/history.jsonl`: full research history.
- `runs/http-graph-1788656989373/`: HTTP request, exports, SSE, and per-call verbatim `model-responses/*.final.txt`.
