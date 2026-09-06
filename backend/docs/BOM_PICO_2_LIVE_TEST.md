# Pico 2 live endpoint exercise

Run: `bom_0308ea3164164b76947d3da401f9eb31` (2026-09-06 UTC).

Input: `examples/bom-pico-2.json`. The non-wireless Pico 2 has official product documentation and a published schematic, making variant confusion and unsupported component guesses relatively easy to inspect:

- https://www.raspberrypi.com/products/raspberry-pi-pico-2/
- https://datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf

Repeat from `backend/` with configured provider keys:

```sh
node scripts/test-bom-http.mjs examples/bom-pico-2.json
```

This makes live provider calls. It starts a temporary Next.js development server on localhost:3138 with an ephemeral API token, POSTs the request, checks the saved BOM and history GET routes, saves HTTP artifacts under `runs/http-bom-…`, and stops the server. The request caps reservations at 100 USD cents and 180 seconds. The configured free model uses zero input/output tariffs; Tavily retrieval still has a separate cost reservation.

## Observed result

The model and tariff entries in `.env.local` had values but were commented out. Enabled the selected `minimax/minimax-m3:free` model and set model tariffs to zero. No keys are recorded here.

- HTTP POST: 200, with body status `partial` and stop reason `provider_or_workflow_error`.
- Tavily product-page extraction succeeded: one source document.
- First OpenRouter model call (`bom.identify`) returned HTTP 404.
- No model output or BOM items; no web searches started.
- Persisted BOM GET and history GET both returned 200.
- Reservation accounting: 2 USD cents for retrieval, not an invoice.
- Original artifacts: `runs/bom_0308ea3164164b76947d3da401f9eb31/`.
- HTTP artifacts: `runs/http-bom-1788655298189/`.

The OpenRouter model listing exists and describes `response_format` JSON output **without JSON-schema enforcement**: https://openrouter.ai/minimax/minimax-m3:free . Our adapter requests `json_schema` and `provider.require_parameters: true`. This mismatch is a plausible routing explanation for the 404; the stored error contains only the HTTP status, so it does not establish the precise provider reason. This run cannot assess model quality.

Next iteration: explicitly support JSON-object mode with the schema supplied in the prompt and the same local Zod validation, or select a free provider that supports schema enforcement. No automatic fallback or model substitution was performed in this test.

## Retry with verbatim response capture

Run `bom_aa510be23b9545b7ba26982099c451a0` repeated the same request and model. OpenRouter again returned 404 before generation. Its verbatim error was saved under `runs/http-bom-1788655747391/model-responses/`; it reports `No endpoints found that can handle the requested parameters` with `failed_routing_step: Filter by Parameters`. This confirms a parameter-routing failure, although it does not identify the individual unsupported parameter. There was no model final response and no BOM items.

The HTTP test now preloads `scripts/capture-model-response.mjs`. For each OpenRouter call, it saves final `message.content` verbatim to `*.final.txt` before application parsing/validation. Provider errors are saved separately as `*.provider-error.txt`; status and finish reasons go into `*.metadata.json`. Hidden reasoning, request headers, and credentials are excluded. This capture is opt-in to the local test, not enabled on the regular server.

## Compatibility fix and successful run

Setting `OPENROUTER_OUTPUT_MODE=json_object` resolved the 404 with the same model and zero-price ceilings. The schema is supplied in the prompt and validated locally. The first model response then failed the existing 800-character summary bound (`bom_23d390652a814de4bdc0f0794c919fde`); its verbatim output remains in `runs/http-bom-1788655892575/model-responses/`. BOM prompt v2 asks for two short sentences targeting under 300 characters, without weakening validation.

Run `bom_8d670889dbbb4acba697a3a243af4bd7` completed in 30.212 seconds with 15 items, 4 fetched documents, 3 searches, and 6 model calls. The reservation total was 14 USD cents for retrieval, not an invoice; model tariffs stayed zero. The persisted BOM and history GET routes returned 200. One page extraction was rejected for a quote shorter than 10 characters, and another page was judged irrelevant. These gaps remain in `open_questions` even though final synthesis completed.

Artifacts:
- `runs/bom_8d670889dbbb4acba697a3a243af4bd7/bom.json`: full persisted result.
- `runs/bom_8d670889dbbb4acba697a3a243af4bd7/bom.md`: readable item table.
- `runs/bom_8d670889dbbb4acba697a3a243af4bd7/history.jsonl`: prompts, outputs, validation and retrieval history.
- `runs/http-bom-1788655939294/model-responses/1788655970449-3a0631ed-b01d-4897-9482-6f695a6d8eb4.choice-0.final.txt`: verbatim final composition.

The result includes RP2350, W25Q32RV flash, ABM8-272-T3 crystal, RT6150 regulator, and a micro-USB connector. This is an operational success, not a factual evaluation. All 15 items received the pipeline's `evidenced` basis, but that means citation availability and matching, not that every attribute was independently checked. Inspect the debug-header item for fitted-header versus bare-pad confusion, and check quantities and manufacturer assignments against their quotes. The earlier failed identity response incorrectly described USB Type-C; keeping raw output makes such issues visible.

Validation: 31 tests, TypeScript check, and Next.js production build passed; the existing nonfatal tracing warning remains.
