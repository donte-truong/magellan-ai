# Magellan AI

Evidence-backed supply chain research: start with a product name and build a sourced graph and research bill of materials. Built at DNHacks 2026.

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [API specification](docs/API_SPEC.md) and [OpenAPI contract](docs/openapi.yaml)
- [Backend setup, configuration, and tests](backend/README.md) (FastAPI, the backend we build on)
- [Frontend setup, user flow, and tests](frontend/README.md)
- [Reference Next.js backend](backend-node/README.md) (kept for reference; not the primary backend)

The FastAPI backend implements API sections 2.1–2.6 plus `POST /v1/bom/decompose`. Run the entire MVP with PostgreSQL, migrations, API, worker, and frontend:

```bash
docker compose --env-file backend/.env up --build -d
```

Open **http://localhost:3000** to explore products. API docs are at **http://localhost:8000/docs**. Configure `backend/.env` using the backend setup guide; `LLM_PROVIDER=openrouter` selects free OpenRouter models, and `LLM_PROVIDER=openai` selects OpenAI. Omit `--env-file backend/.env` to use the credential-free fixture defaults instead.

Stop the stack with `docker compose --env-file backend/.env down`; the database volume is preserved. On Windows, start Docker Desktop first and enable WSL integration, or run the same command using `docker.exe compose` from WSL.

The **Next.js frontend** (`frontend/`) provides the MVP flow: **enter a product → review its sourced bill of materials → explore the supply network**. Without containers, start the backend on port 8000, then run `bun install` and `bun run dev` in `frontend/`. Open http://127.0.0.1:3000 and try the Raspberry Pi 5 example.

The **Next.js backend** (`backend-node/`) is an earlier implementation of research runs, the evidence graph, a standalone photo/link/description `POST /v1/bom` estimate, OpenRouter support, and BOM import. It still serves the frontend's routes on port 3001 (`MAGELLAN_API_URL=http://127.0.0.1:3001`) and is kept for reference.
