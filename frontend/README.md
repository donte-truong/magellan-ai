# Magellan frontend

A dark navy landing page at `/home` and product exploration experience at `/`: **iPhone 17 Pro → animated 3D decomposition → supplier connections on a 3D globe**. The existing API-backed research workspace is available at `/research`. The product name is **Magellan**, with a capital M and no AI suffix.

## Run locally

Requires **Node.js 22.12+** and **Bun 1.3.9+**. Start the FastAPI service on port 8000 using the [backend instructions](../backend/README.md), then run from this repository's root:

```bash
cd frontend
bun install --frozen-lockfile
cp .env.example .env.local
bun run dev
```

Open **http://127.0.0.1:3000** and select **Deconstruct product**. The featured iPhone 17 Pro demo is deterministic and does not make model or search requests. It uses a curated selection of Apple specifications and iFixit teardown findings; component and supplier details link to their sources. Globe pins represent approximate company headquarters. Connections illustrate component relationships to Apple, not factories or shipping routes. Quantities and a complete manufacturing BOM remain unresolved.

Open **http://127.0.0.1:3000/research** for backend-driven exploration, including the Raspberry Pi 5 fixture, saved runs, and the configured live research provider.

To run the entire MVP in containers, use `docker compose --env-file backend/.env up --build -d` from the repository root, then open http://localhost:3000. Compose builds a standalone Next.js server with Bun and Node.js 22, includes `public/assets`, and connects it to the API over the internal Docker network. Environment files are excluded from the image; the backend workspace token is supplied at runtime. Omit the `--env-file` option for fixture-only defaults. Browser calls use the same-origin Next.js proxy, so a separate backend CORS setting is unnecessary for this frontend.

## What the MVP includes

- A landing page at `/home` with the shared iPhone decomposition and interactive globe, flowing SVG waves, source links, and entry points into the demo and live workspace. An animated compass logo covers initial scene and font loading, then fades away. Entering the globe section triggers one animation: each of the six components condenses into a single glowing dot, then glides along a curved path into a projected surface location; the flight runs independently of further scrolling and does not replay on a return scroll. Landing controls are independent of demo state. Reduced motion omits the sticky sequence and component flight; the hero's secondary button still reveals or reassembles the iPhone.
- A three-stage featured demo with a persistent, original Three.js phone model, six animated assemblies, source links, reassembly, and selection highlighting. The housing has an open frame and rear panel; the shared `scenes/phone-motion.ts` timeline separates components in depth before spreading them laterally and reverses that path for reassembly.
- A draggable spherical world map with 7,015 bright land points, coastline outlines, illuminated relationship arcs, moving particles, supplier selection, search, zoom, and view reset.
- Location cards connected to map pins by SVG lines, showing each company, city, and component. Nearby cards are spaced apart; search also accepts cities and component categories.
- Supplier details, headquarters coordinates/source links, and JSON export with provenance and limitations.
- Responsive mobile layouts, keyboard navigation, native modal focus handling, reduced motion, an animation pause control in the demo, and WebGL fallback illustrations.

The live research workspace retains:

- Product input with an optional company, request validation, idempotent retries, and error recovery.
- Automatic research updates, clarification choices, cancellation, and visible incomplete results.
- A searchable BOM with component/material filters, unknown quantities, and evidence support labels.
- An interactive dependency graph with automatic layout, dragging, zoom, fit, a minimap, and node search/type filters. Evidenced country codes appear when present in the graph's geography layer.
- Connection inspection with claims, exact stored excerpts, source links, scope, rationale, review notes, and caveats. Nodes and edges can also be inspected with Enter or Space.
- Recent explorations, direct `?run=run_…` URLs, and JSON export pinned to the displayed graph revision.
- Responsive layouts, labeled controls, focus indicators, an Escape-dismissable evidence panel, and reduced-motion support.

The featured globe uses curated geography; automatic projection of arbitrary research graphs onto that globe remains future work. Uploads, graph editing, enrichment controls, portfolios, and agent chat remain outside this frontend MVP.

## Tooling and structure

| Tool                             | Purpose                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Next.js 16 App Router + React 19 | Application, routing, server API boundary, and production builds                                                    |
| TypeScript                       | Strict API and application types                                                                                    |
| Bun                              | Dependency installation, lockfile, and task scripts                                                                 |
| Vite + Vitest + Testing Library  | Component and logic tests, following the [Next.js testing guide](https://nextjs.org/docs/app/guides/testing/vitest) |
| Zustand                          | Exploration, graph snapshot, view, and selection state                                                              |
| Three.js                         | Original procedural product model, globe geometry, lighting, and animation                                          |
| React Flow + Dagre               | Interactive graph and directed layout                                                                               |
| Playwright                       | Desktop/mobile browser tests against the real FastAPI backend                                                       |
| ESLint + Prettier                | Static checks and consistent formatting                                                                             |

Next.js owns the application's build pipeline. Vite powers the test pipeline through `vite.config.ts`. Fonts are bundled locally, and the network visualization is loaded when needed.

Project media lives in [public/assets](public/assets/README.md), with separate directories for 3D models, animations, videos, and images. Reference these files using `/assets/…` URLs.

`src/components/experience` contains the featured demo, product renderer, and globe renderer. `src/lib/demo-data.ts` owns curated facts and source URLs; `demo-store.ts` owns demo navigation and selection; `scenes/phone.ts` creates the original six-part model. Each scene caps pixel ratio, stops updates when the page is hidden, handles failed WebGL initialization, and disposes geometry, materials, textures, observers, and animation frames on exit. Map geometry is served locally from `public/assets/models/world-points.json` and `world-coastlines.json`; either layer can render independently if the other fails to load. `scenes/globe-labels.ts` places projected location cards within the viewport without overlapping neighboring cards.

The existing research components remain in `src/components`. `src/lib/api.ts` is the typed browser client; `proxy.ts` implements the server boundary; `store.ts` owns research state; `use-research.ts` synchronizes API snapshots; `graph-layout.ts` keeps API edge direction intact while laying out dependencies.

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

Browser tests start their own Next.js instance on **3100**, a fixture-backed FastAPI instance on **8100**, and a disposable SQLite database in the system temporary directory. They exercise both the iPhone demo (assembly selection, reassembly, supplier filtering, sources, export, resume, reduced motion, and keyboard access) and the live workspace (source inspection, export/resume, ambiguity, and evidence gaps) on desktop and mobile. Screenshots and failure traces go into ignored `test-results/`. No paid provider calls are made.
