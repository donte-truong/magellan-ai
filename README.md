# dnhacks-26

Project repository for DNHacks 2026.

See [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for the product and [backend/README.md](backend/README.md) for the runnable Next.js research backend.

Quick offline graph: `cd backend && npm ci && npm run demo`. Live research, evidence inspection, API integration, run histories, and decision notes are documented in the backend README.

Bill-of-materials estimate: `POST /v1/bom` (or `npm run bom`) takes a product description, link, and/or photo and returns a JSON BOM where every item is labelled with where the agent got it from. See the backend README section "Bill-of-materials estimate (MVP)".
