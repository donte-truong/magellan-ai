# Magellan AI

Evidence-backed supply chain research: start with a product name and build a sourced graph and research bill of materials.

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [API specification](docs/API_SPEC.md) and [OpenAPI contract](docs/openapi.yaml)
- [Backend setup, configuration, and tests](backend/README.md)
- [Frontend setup, user flow, and tests](frontend/README.md)

The FastAPI backend implements API sections 2.1–2.6 plus `POST /v1/bom/decompose`. Run the entire MVP with PostgreSQL, migrations, API, worker, and frontend:

```bash
docker compose --env-file backend/.env up --build -d
```

Open **http://localhost:3000** to explore products. API docs are at **http://localhost:8000/docs**. Configure `backend/.env` using the backend setup guide; `LLM_PROVIDER=openrouter` selects free OpenRouter models, and `LLM_PROVIDER=openai` selects OpenAI. Omit `--env-file backend/.env` to use the credential-free fixture defaults instead.

Stop the stack with `docker compose --env-file backend/.env down`; the database volume is preserved. On Windows, start Docker Desktop first and enable WSL integration, or run the same command using `docker.exe compose` from WSL.

The Next.js frontend provides the MVP flow: **enter a product → review its sourced bill of materials → explore the supply network**. Start the backend, then run `bun install` and `bun run dev` in `frontend/`. Open http://127.0.0.1:3000 and try the Raspberry Pi 5 example. TypeScript, Zustand, React Flow, Vite/Vitest, and Playwright support the application.
