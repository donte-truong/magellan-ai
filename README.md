# Magellan AI

Evidence-backed supply chain research: start with a product name and build a sourced graph and research bill of materials. Built at DNHacks 2026.

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [API specification](docs/API_SPEC.md) and [OpenAPI contract](docs/openapi.yaml)
- [Backend setup, configuration, and tests](backend/README.md) (FastAPI, the backend we build on)
- [Frontend setup, user flow, and tests](frontend/README.md)
- [Reference Next.js backend](backend-node/README.md) (kept for reference; not the primary backend)

The **FastAPI backend** (`backend/`) implements API sections 2.1–2.6 plus `POST /v1/bom/decompose`. Run locally with SQLite or use `docker compose up --build` for PostgreSQL and a separate worker. The development default uses a curated Raspberry Pi 5 fixture and makes no external calls.

The **Next.js frontend** (`frontend/`) provides the MVP flow: **enter a product → review its sourced bill of materials → explore the supply network**. Start the backend on port 8000, then run `bun install` and `bun run dev` in `frontend/`. Open http://127.0.0.1:3000 and try the Raspberry Pi 5 example.

The **Next.js backend** (`backend-node/`) is an earlier implementation of research runs, the evidence graph, a standalone photo/link/description `POST /v1/bom` estimate, OpenRouter support, and BOM import. It still serves the frontend's routes on port 3001 (`MAGELLAN_API_URL=http://127.0.0.1:3001`) and is kept for reference and for porting ideas into the FastAPI backend.
