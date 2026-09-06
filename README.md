# Magellan AI

Evidence-backed supply chain research: start with a product name and build a sourced graph and research bill of materials. Built at DNHacks 2026.

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [API specification](docs/API_SPEC.md) and [OpenAPI contract](docs/openapi.yaml)
- [Backend setup, configuration, and tests](backend/README.md)
- [Frontend setup, user flow, and tests](frontend/README.md)

The **Next.js backend** (`backend/`) implements research runs, the evidence graph, SSE events, the standalone `POST /v1/bom` estimate, and the frontend-facing `POST /v1/bom/decompose` and `GET /v1/runs/{id}/bom` routes. Quick offline graph: `cd backend && npm ci && npm run demo`. Live research needs `OPENAI_API_KEY` (or OpenRouter settings) and `TAVILY_API_KEY`; see the backend README.

The **Next.js frontend** (`frontend/`) provides the MVP flow: **enter a product → review its sourced bill of materials → explore the supply network**. Start the backend on port 3001 with `RESEARCH_API_TOKEN` set, then run `bun install` and `bun run dev` in `frontend/` with the same token in `MAGELLAN_API_TOKEN`. Open http://127.0.0.1:3000 and try the Raspberry Pi 5 example, which uses the backend's curated replay when no provider keys are configured.
