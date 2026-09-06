# Magellan frontend

A minimal supply-chain exploration workspace: **product name → decomposed bill of materials → interactive network overlay**.

## Run locally

Requires **Node.js 22.12+** and **Bun 1.3.9+**. Start the FastAPI service on port 8000 using the [backend instructions](../backend/README.md), then run from this repository's root:

```bash
cd frontend
bun install --frozen-lockfile
cp .env.example .env.local
bun run dev
```

Open **http://127.0.0.1:3000**. Select **Raspberry Pi 5**, then **Deconstruct product** for an immediately usable example. The backend's default curated provider returns three sourced components and explicit research gaps. Arbitrary-product research uses the backend's optional live provider; the frontend never substitutes fabricated components for missing research.

To run the entire MVP in containers, use `docker compose --env-file backend/.env up --build -d` from the repository root, then open http://localhost:3000. Compose builds a standalone Next.js server with Bun and Node.js 22, includes `public/assets`, and connects it to the API over the internal Docker network. Environment files are excluded from the image; the backend workspace token is supplied at runtime. Omit the `--env-file` option for fixture-only defaults. Browser calls use the same-origin Next.js proxy, so a separate backend CORS setting is unnecessary for this frontend.

## What the MVP includes

- Product input with an optional company, request validation, idempotent retries, and error recovery.
- Automatic research updates, clarification choices, cancellation, and visible incomplete results.
- A searchable BOM with component/material filters, unknown quantities, and evidence support labels.
- An interactive dependency graph with automatic layout, dragging, zoom, fit, a minimap, and node search/type filters. Evidenced country codes appear when present in the graph's geography layer.
- Connection inspection with claims, exact stored excerpts, source links, scope, rationale, review notes, and caveats. Nodes and edges can also be inspected with Enter or Space.
- Recent explorations, direct `?run=run_…` URLs, and JSON export pinned to the displayed graph revision.
- Responsive layouts, labeled controls, focus indicators, an Escape-dismissable evidence panel, and reduced-motion support.

The overlay is a dependency network. A geographic basemap, uploads, graph editing, enrichment controls, portfolios, and agent chat remain outside this frontend MVP.

## Tooling and structure

| Tool                             | Purpose                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Next.js 16 App Router + React 19 | Application, routing, server API boundary, and production builds                                                    |
| TypeScript                       | Strict API and application types                                                                                    |
| Bun                              | Dependency installation, lockfile, and task scripts                                                                 |
| Vite + Vitest + Testing Library  | Component and logic tests, following the [Next.js testing guide](https://nextjs.org/docs/app/guides/testing/vitest) |
| Zustand                          | Exploration, graph snapshot, view, and selection state                                                              |
| React Flow + Dagre               | Interactive graph and directed layout                                                                               |
| Playwright                       | Desktop/mobile browser tests against the real FastAPI backend                                                       |
| ESLint + Prettier                | Static checks and consistent formatting                                                                             |

Next.js owns the application's build pipeline. Vite powers the test pipeline through `vite.config.ts`. Fonts are bundled locally, and the network visualization is loaded when needed.

Project media lives in [public/assets](public/assets/README.md), with separate directories for 3D models, animations, videos, and images. Reference these files using `/assets/…` URLs.

`src/components` contains the input, BOM, network, and evidence views. `src/lib/api.ts` is the typed browser client; `proxy.ts` implements the server boundary; `store.ts` owns exploration state; `use-research.ts` synchronizes API snapshots; `graph-layout.ts` keeps API edge direction intact while laying out dependencies.

Research updates use sequential polling with bounded retry delays. Each refresh reads the run and graph, then requests the BOM at that graph revision. Inspections and exports pin the same revision. Navigation aborts outstanding reads; a generation counter prevents late responses from replacing another exploration. A graph revision change applies a fresh layout; manual node positions last for the current view and revision.

The frontend's subset of the API types is in `src/lib/types.ts`; the authoritative contract remains [docs/openapi.yaml](../docs/openapi.yaml).

## Server configuration

| Variable             | Default                         | Purpose                             |
| -------------------- | ------------------------------- | ----------------------------------- |
| `MAGELLAN_API_URL`   | `http://127.0.0.1:8000`         | Backend origin, without `/v1`       |
| `MAGELLAN_API_TOKEN` | `dev-token` in development only | Provisioned backend workspace token |

These variables stay on the server. Do not prefix the token with `NEXT_PUBLIC_`. The proxy permits only the endpoints needed by this MVP, bounds request bodies and upstream timeouts, checks write origins, and excludes upstream credentials/cookies from response headers.

This is a **local/private, single-workspace MVP**. Anyone able to reach its Next.js server can use the configured workspace. The supplied development and start commands bind to loopback. A public multi-user deployment needs application authentication and per-user workspace authorization at this server boundary. Reverse proxies must preserve the browser-facing `Host` header for write-origin checks.

For a production build served locally:

```bash
bun run build
# Set MAGELLAN_API_TOKEN in .env.local or the process environment first.
bun run start
```

Production has no implicit token fallback; an unconfigured proxy returns a helpful 503 response.

## Verify

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build

# Requires the backend's virtual environment at backend/.venv.
bunx playwright install --with-deps chromium
bun run test:e2e
```

Use `bun run test` to invoke Vitest. The native `bun test` runner does not use this project's Vite configuration.

Browser tests start their own Next.js instance on **3100**, a fixture-backed FastAPI instance on **8100**, and a disposable SQLite database in the system temporary directory. They exercise the complete flow, source inspection, export/resume, product ambiguity, and evidence gaps on desktop and mobile. Screenshots and failure traces go into ignored `test-results/`. No paid provider calls are made.
