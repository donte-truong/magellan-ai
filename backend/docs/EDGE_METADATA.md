# Edge metadata and confidence v1

Every newly committed edge carries these fields at its top level, alongside `support_label`, `scope`, and `claim_ids`. The same shape is used by JSON exports, edge detail responses, and `edge.added`/`edge.updated` SSE events. The HTML and Markdown inspectors display it too.

```json
{
  "source": [
    {
      "id": "src_example",
      "url": "https://manufacturer.org/specification",
      "title": "Product specification",
      "publisher": "manufacturer.org",
      "published_at": null,
      "retrieved_at": "2026-09-05T14:23:40.000Z",
      "content_hash": "sha256-of-the-stored-document",
      "source_family_id": "family_host_manufacturer.org",
      "kind": "other",
      "license_notes": null,
      "support_types": ["supports"]
    }
  ],
  "date": "2026-09-05",
  "time": "14:23:45.678Z",
  "confidence": 0.65,
  "confidence_details": {
    "method": {
      "name": "edge_evidence_v1",
      "params": {
        "scope": "evidence_for_stated_relation",
        "scale": "0-1",
        "max_score": 0.95,
        "disputed_cap": 0.25
      }
    },
    "factors": { "base": 0.70, "corroboration": 0, "freshness": -0.05, "contradiction": 0 },
    "data_quality": {
      "calibrated": false,
      "replay": false,
      "supporting_families": 1,
      "missing_claim_ids": [],
      "missing_source_ids": [],
      "notes": ["Heuristic evidence score, not a calibrated probability."]
    },
    "evaluated_at": "2026-09-05T14:23:45.678Z"
  }
}
```

## Source and timestamp semantics

`source` is an **array**, despite the singular field name requested for the edge. This preserves all supporting, contradicting, and contextual sources instead of arbitrarily selecting one. Entries are deduplicated by source ID, sorted by ID, and include `support_types` so a contrary source is never mistaken for corroboration. BOM provenance uses the same structure with `kind: "upload"` and its `urn:bom:…` URL. Exact quotes and locators remain in the claim/evidence ledger; they are not replaced by this shortcut.

`date` and `time` are the UTC date and time of the **latest recorded evidence observation** for the edge, taken from claim `observed_at` and evidence `extracted_at`. For older records missing those timestamps, the fallback is the latest source retrieval timestamp, then graph creation. If every timestamp is absent/invalid, both fields are null. A source's publication date is separate and can be unknown. We do not invent publication dates or treat retrieval as publication.

The combined timestamp is also `confidence_details.evaluated_at`. The scoring clock is pinned to it rather than the current wall clock, so repeated reads/replay do not change a saved score just because time passed. New accepted evidence recomputes metadata for that edge.

## Scoring rule

The score describes evidence for the **stated relation and scope**. A high company-scope score does not establish product-specific supply. This is an engineering heuristic requested for iteration, not a model self-rating or an empirically calibrated probability.

Start from the support-label base:

| Support label | Base |
| --- | ---: |
| directly_supported | 0.70 |
| strongly_inferred | 0.50 |
| weakly_inferred | 0.30 |
| user_asserted | 0.25 |
| unresolved | 0.00 |
| disputed | 0.70 before the contradiction penalty/cap |

Then add these recorded factors:

| Factor | Adjustment |
| --- | ---: |
| Each additional distinct supporting web-source group after the first | +0.10, at most +0.20 total |
| Latest usable supporting publication is at most two years old | 0 |
| Supporting publication date unknown/invalid/future | −0.05 |
| Latest supporting publication is more than two years old | −0.10 |
| Latest supporting publication is more than five years old | −0.20 |
| Any explicit contradictory evidence or disputed support label | −0.45 and final cap 0.25 |

Supporting web sources are grouped by shared `source_family_id` **or** identical `content_hash`, including transitive matches. Several pages from one family, or copies of the same document across different families, cannot increase the corroboration bonus. This is still a heuristic: edited syndication and incorrect family attribution can remain undetected. Context-only/contradicting sources and user uploads do not earn corroboration or freshness credit.

Upload-only evidence receives at most the user-assertion base (0.25), with no freshness adjustment. Missing claim/source references or no usable supporting span force confidence to 0. Otherwise sum the factors, clamp to `[0, 0.95]` (and 0.25 when disputed), then round to three decimals. Scores retain support labels and never authorize a previously rejected edge. The replay uses the same arithmetic, but `data_quality.replay` and its notes disclose the curated verification.

Examples: a single recent directly supported source scores 0.70; the same evidence with an unknown publication date scores 0.65; two independent recent sources score 0.80; three or more score 0.90; a user BOM assertion scores 0.25. Explicit contradiction can never score above 0.25. Older evidence may still be historically correct; freshness is a modest current-relevance adjustment rather than a declaration that the source is wrong.

## Compatibility and iteration

Implementation: `src/research/edge-metadata.ts`; contract: root `openapi.yaml` (`Edge`, `EdgeSource`, `EdgeConfidenceDetails`); tests: `tests/edge-metadata.test.ts` plus ledger/API coverage.

Existing graph files and old SSE edge events are enriched **on read** if metadata is missing. Each historical event uses only its own claim IDs, so later contradictions do not leak backward into an earlier event's score. Existing audit files and revisions are not rewritten. Already generated HTML/Markdown files remain snapshots; rerun `npm run demo` for new files or use the API view/export for an older saved graph.

To tune weights or replace the heuristic, change the isolated scorer and update its method version, docs, and tests. Evaluate against analyst-labeled edges before interpreting scores as probabilities. Source credibility, verified independence, actual product/version matching, and temporal validity are useful next features; this version does not infer publisher authority from a hostname or multiply model-generated confidences together. BOM **estimate item** confidence (`high`/`medium`/`low`) is a separate contract and is unchanged.
