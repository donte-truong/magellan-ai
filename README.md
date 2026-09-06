# Magellan AI

Evidence-backed supply chain research: start with a product name and build a sourced graph and research bill of materials.

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [API specification](docs/API_SPEC.md) and [OpenAPI contract](docs/openapi.yaml)
- [Backend setup, configuration, and tests](backend/README.md)
- [Frontend setup, user flow, and tests](frontend/README.md)

The FastAPI backend implements API sections 2.1–2.6 plus `POST /v1/bom/decompose`. Run locally with SQLite or use `docker compose up --build` for PostgreSQL and a separate worker.

The Next.js frontend provides the MVP flow: **enter a product → review its sourced bill of materials → explore the supply network**. Start the backend, then run `bun install` and `bun run dev` in `frontend/`. Open http://127.0.0.1:3000 and try the Raspberry Pi 5 example. TypeScript, Zustand, React Flow, Vite/Vitest, and Playwright support the application.
