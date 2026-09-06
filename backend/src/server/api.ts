import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { runResearch, validateRequest } from '../research/engine';
import { assertLiveCredentials, liveConfig } from '../research/providers';
import { hash, id, normalize, type Graph, type Run, type RunEvent } from '../research/schema';
import { deriveBom, presentRun } from './frontend-compat';
import { atomicJson, readJson } from '../research/store';
import { renderHtml } from '../research/view';
import { annotateEdge, ensureGraphEdgeMetadata, hasEdgeMetadata } from '../research/edge-metadata';
import type { Edge } from '../research/schema';
import { generateBom, validateBomRequest } from '../bom/pipeline';
import { MAX_IMAGE_BYTES, sniffImage, type Bom } from '../bom/schema';

type Job = { controller: AbortController; promise: Promise<unknown> };
const state = globalThis as typeof globalThis & { supplyJobs?: Map<string, Job>; supplyLaunchLock?: Promise<unknown>; supplyBomActive?: number };
const jobs = state.supplyJobs ??= new Map<string, Job>();
// Runtime data is external to the build graph and must never be bundled.
const root = () => resolve(/* turbopackIgnore: true */ process.env.RESEARCH_RUNS_DIR ?? 'runs');
const runPath = (runId: string) => { if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new HttpError(404, 'not_found', 'Run not found'); return join(root(), runId); };
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function authorize(request: Request) {
  const token = process.env.RESEARCH_API_TOKEN;
  if (!token) throw new HttpError(503, 'configuration_required', 'Set RESEARCH_API_TOKEN to enable the local API');
  const header = request.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(header);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'unauthorized', 'Valid bearer token required');
}
async function readRun(runId: string): Promise<Run> {
  const run = await readJson<Run>(join(runPath(runId), 'run.json'));
  // A process restart loses in-memory workers; never claim a stale run is still working.
  if (run.status === 'running' && !jobs.has(runId)) return { ...run, status: 'partial', stop_reason: 'worker_interrupted', open_questions: [...run.open_questions, 'Worker is no longer attached. Inspect the persisted frontier and start a new run; automatic resume is not implemented.'] };
  return run;
}
async function runIds() {
  try { return (await readdir(/* turbopackIgnore: true */ root())).filter(n => /^run_[a-f0-9]{32}$/.test(n)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
async function findGraph(graphId: string) {
  if (!/^gph_[a-f0-9]{32}$/.test(graphId)) throw new HttpError(404, 'not_found', 'Graph not found');
  for (const runId of await runIds()) {
    try {
      const run = await readRun(runId);
      if (run.graph_id === graphId) return { run, graph: ensureGraphEdgeMetadata(await readJson<Graph>(join(runPath(runId), 'graph.json'))) };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  throw new HttpError(404, 'not_found', 'Graph not found');
}
async function readBody(request: Request, maxBytes = 100_000) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_input', 'JSON body required');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'invalid_input', `JSON body exceeds ${Math.round(maxBytes / 1000)} KB`); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'invalid_input', 'Malformed JSON'); }
}
const BOM_BODY_LIMIT = 8_000_000;
const bomPath = (bomId: string) => { if (!/^bom_[a-f0-9]{32}$/.test(bomId)) throw new HttpError(404, 'not_found', 'BOM not found'); return join(root(), bomId); };
// Accepts JSON (image as base64) or multipart/form-data (image as a file field named `image`).
export async function readBomBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > BOM_BODY_LIMIT) throw new HttpError(413, 'invalid_input', 'Request body exceeds 8 MB');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return readBody(request, BOM_BODY_LIMIT);
  let form: FormData;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'invalid_input', 'Malformed multipart body'); }
  const text = (name: string) => { const value = form.get(name); return typeof value === 'string' && value.trim() ? value : undefined; };
  const body: Record<string, unknown> = {};
  for (const name of ['description', 'url', 'image_url', 'company']) { const value = text(name); if (value !== undefined) body[name] = value; }
  const limits = text('limits');
  if (limits) { try { body.limits = JSON.parse(limits); } catch { throw new HttpError(400, 'invalid_input', 'limits must be a JSON object'); } }
  const file = form.get('image');
  if (file instanceof Blob) {
    if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'invalid_input', `Image exceeds ${MAX_IMAGE_BYTES} bytes`);
    const buffer = Buffer.from(await file.arrayBuffer());
    const media = sniffImage(buffer);
    if (!media) throw new HttpError(400, 'invalid_input', 'image must be a JPEG, PNG, WebP, or GIF file');
    body.image = { data: buffer.toString('base64'), media_type: media };
  }
  return body;
}
async function createBom(request: Request) {
  const raw = await readBomBody(request);
  try { validateBomRequest(raw); }
  catch (e) { throw new HttpError(400, 'invalid_input', e instanceof Error ? e.message : 'Invalid BOM request'); }
  try { assertLiveCredentials(); liveConfig(); }
  catch (e) { throw new HttpError(503, 'configuration_required', e instanceof Error ? e.message : 'Provider configuration required'); }
  if ((state.supplyBomActive ?? 0) >= 3) throw new HttpError(429, 'rate_limited', 'Three BOM estimates are already active');
  state.supplyBomActive = (state.supplyBomActive ?? 0) + 1;
  try {
    // Synchronous by design for the MVP: the response body is the persisted bom.json, also readable at GET /v1/bom/{id}.
    const { bom } = await generateBom(raw, { root: root(), signal: request.signal });
    return json(bom, 200);
  } finally { state.supplyBomActive = (state.supplyBomActive ?? 1) - 1; }
}
// Frontend entry point: `{product, company?}` starts a research run. Live when provider keys are configured;
// otherwise the curated Raspberry Pi 5 replay is the only product that can be served.
async function decompose(request: Request) {
  const body = z.object({ product: z.string().trim().min(1).max(200), company: z.string().trim().max(200).optional() }).strict().parse(await readBody(request));
  const company = body.company?.trim() || undefined;
  let mode: 'live' | 'replay' = 'live';
  try { assertLiveCredentials(); liveConfig(); }
  catch (e) {
    if (normalize(body.product) === 'raspberry pi 5' && (!company || normalize(company) === 'raspberry pi')) mode = 'replay';
    else throw new HttpError(503, 'configuration_required', `Live research is not configured on this workspace, so only the Raspberry Pi 5 curated example is available. (${e instanceof Error ? e.message : 'provider configuration required'})`);
  }
  const forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ product: body.product, ...(company ? { company } : {}), mode }) });
  return launch(forwarded);
}
async function launch(request: Request) {
  const parsed = z.object({ mode: z.enum(['live', 'replay']).default('live') }).passthrough().parse(await readBody(request, 2_000_000));
  const { mode, ...raw } = parsed;
  let input;
  try { input = validateRequest(raw, mode); }
  catch (e) { throw new HttpError(400, 'invalid_input', e instanceof Error ? e.message : 'Invalid research input'); }
  const idem = request.headers.get('idempotency-key');
  if (idem && idem.length > 200) throw new HttpError(400, 'invalid_input', 'Idempotency-Key must be at most 200 characters');
  const bodyHash = hash(JSON.stringify({ input, mode }));
  const idemPath = idem ? join(root(), 'idempotency', `${hash(idem)}.json`) : null;
  const work = async () => {
    if (idemPath) {
      try {
        const previous = await readJson<{ bodyHash: string; runId: string }>(idemPath);
        if (previous.bodyHash !== bodyHash) throw new HttpError(409, 'idempotency_conflict', 'Key already used for different inputs');
        return json(presentRun(await readRun(previous.runId)), 200);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (jobs.size >= 3) throw new HttpError(429, 'rate_limited', 'Three research runs are already active');
    if (mode === 'live') {
      try { assertLiveCredentials(); liveConfig(); }
      catch (e) { throw new HttpError(503, 'configuration_required', e instanceof Error ? e.message : 'Provider configuration required'); }
    }
    const controller = new AbortController();
    let createdResolve!: (run: Run) => void; let createdReject!: (error: unknown) => void;
    const created = new Promise<Run>((res, rej) => { createdResolve = res; createdReject = rej; });
    let runId: string | undefined;
    const promise = runResearch(input, { mode, root: root(), signal: controller.signal, onCreated(run) { runId = run.id; jobs.set(run.id, { controller, promise }); createdResolve(structuredClone(run)); } }).catch(error => { createdReject(error); return null; }).finally(() => { if (runId) jobs.delete(runId); });
    const run = await created;
    if (idemPath) { await mkdir(join(root(), 'idempotency'), { recursive: true, mode: 0o700 }); await atomicJson(idemPath, { bodyHash, runId: run.id }); }
    return json(presentRun(run), 202);
  };
  const pending = (state.supplyLaunchLock ?? Promise.resolve()).then(work, work);
  state.supplyLaunchLock = pending.catch(() => undefined);
  return pending;
}
async function events(request: Request, runId: string) {
  await readRun(runId);
  const rawCursor = request.headers.get('last-event-id') ?? '0';
  if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) throw new HttpError(400, 'invalid_input', 'Last-Event-ID must be a nonnegative integer');
  let cursor = Number(rawCursor); let stopped = false;
  let finishWait: (() => void) | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: string) => { if (!stopped) controller.enqueue(encoder.encode(value)); };
      let ping = Date.now();
      try {
        while (!stopped && !request.signal.aborted) {
          const text = await readFile(join(runPath(runId), 'events.jsonl'), 'utf8');
          // Ignore the last partial line during an append; it will be complete on the next read.
          const rows = text.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as RunEvent);
          const legacy = rows.filter(e => ['edge.added', 'edge.updated'].includes(e.type) && e.payload.edge && !hasEdgeMetadata(e.payload.edge as Edge));
          if (legacy.length) {
            const graph = await readJson<Graph>(join(runPath(runId), 'graph.json'));
            // Project from only each event's claim IDs, preserving its historical state.
            for (const event of legacy) annotateEdge(event.payload.edge as Edge, graph);
          }
          const last = rows.at(-1)?.seq ?? 0;
          if (cursor > last) {
            const run = await readRun(runId);
            send(`event: snapshot.required\ndata: ${JSON.stringify({ type: 'snapshot.required', seq: last, run_id: runId, graph_id: run.graph_id, revision: 0, at: new Date().toISOString(), payload: { mode: run.mode } })}\n\n`);
            cursor = 0;
          }
          for (const event of rows.filter(e => e.seq > cursor)) { send(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq; }
          const run = await readRun(runId);
          if (run.status !== 'running' && (!jobs.has(runId) || rows.some(e => e.type === 'run.completed'))) {
            if (!rows.some(e => e.type === 'run.completed')) send(`event: snapshot.required\ndata: ${JSON.stringify({ type: 'snapshot.required', seq: cursor, run_id: runId, graph_id: run.graph_id, revision: 0, at: new Date().toISOString(), payload: { mode: run.mode, reason: run.stop_reason } })}\n\n`);
            break;
          }
          if (Date.now() - ping > 15_000) { send(': ping\n\n'); ping = Date.now(); }
          await new Promise<void>(res => { const timer = setTimeout(res, 500); finishWait = () => { clearTimeout(timer); res(); }; });
        }
        if (!stopped) controller.close();
      } catch (e) { if (!stopped) controller.error(e); }
    },
    cancel() { stopped = true; finishWait?.(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' } });
}
export async function handle(request: Request, segments: string[]) {
  try {
    authorize(request);
    const [resource, resourceId, action, childId] = segments;
    const method = request.method; const url = new URL(request.url);
    if (resource === 'bom') {
      if (segments.length === 1 && method === 'POST') return await createBom(request);
      if (resourceId === 'decompose' && segments.length === 2 && method === 'POST') return await decompose(request);
      if (resourceId && segments.length === 2 && method === 'GET') return json(await readJson<Bom>(join(bomPath(resourceId), 'bom.json')));
      if (resourceId && action === 'history' && segments.length === 3 && method === 'GET') return new Response(await readFile(join(bomPath(resourceId), 'history.jsonl')), { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
    }
    if (resource === 'runs' && segments.length === 1) {
      if (method === 'POST') return await launch(request);
      if (method === 'GET') {
        const limitParam = url.searchParams.get('limit');
        if (limitParam !== null && !/^\d+$/.test(limitParam)) throw new HttpError(400, 'invalid_input', 'limit must be a nonnegative integer');
        const limit = Math.min(200, limitParam === null ? 50 : Number(limitParam));
        const all = (await Promise.all((await runIds()).map(runId => readRun(runId).catch(() => null)))).filter((r): r is Run => !!r).sort((a, b) => b.created_at.localeCompare(a.created_at));
        const runs = all.filter(r => !url.searchParams.has('status') || r.status === url.searchParams.get('status')).slice(0, limit).map(presentRun);
        // `items` mirrors `runs` for the frontend's draft-contract client.
        return json({ runs, items: runs, next_cursor: null });
      }
    }
    if (resource === 'runs' && resourceId) {
      if (method === 'GET' && segments.length === 2) return json(presentRun(await readRun(resourceId)));
      if (method === 'GET' && action === 'bom' && segments.length === 3) { const run = await readRun(resourceId); return json(deriveBom(run, ensureGraphEdgeMetadata(await readJson<Graph>(join(runPath(resourceId), 'graph.json'))))); }
      if (method === 'GET' && action === 'events' && segments.length === 3) return await events(request, resourceId);
      if (method === 'GET' && action === 'history' && segments.length === 3) return new Response(await readFile(join(runPath(resourceId), 'history.jsonl')), { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
      if (method === 'POST' && action === 'cancel' && segments.length === 3) { const run = await readRun(resourceId); jobs.get(resourceId)?.controller.abort(); return json({ ...presentRun(run), cancellation_requested: run.status === 'running' }); }
    }
    if (resource === 'graphs' && resourceId && method === 'GET') {
      const { graph, run } = await findGraph(resourceId);
      const revision = url.searchParams.get('revision');
      if (revision !== null && !/^\d+$/.test(revision)) throw new HttpError(400, 'invalid_input', 'revision must be a nonnegative integer');
      // Only the latest revision is persisted. The whole-graph read is strict; child reads pinned to an
      // earlier revision (the frontend pins the revision it last displayed) are served from the latest graph.
      if (revision !== null && Number(revision) !== graph.revision && (segments.length === 2 || Number(revision) > graph.revision)) throw new HttpError(409, 'revision_conflict', 'Only the latest graph revision is persisted in this prototype');
      if (segments.length === 2) return json(graph);
      if (action === 'export' && segments.length === 3) return new Response(JSON.stringify(graph, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${graph.id}.json"`, 'Cache-Control': 'no-store' } });
      if (action === 'view' && segments.length === 3) return new Response(renderHtml(run, graph), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (action === 'edges' && childId && segments.length === 4) {
        const edge = graph.edges.find(e => e.id === childId); if (!edge) throw new HttpError(404, 'not_found', 'Edge not found');
        const claims = graph.claims.filter(c => edge.claim_ids.includes(c.id)).map(c => ({ ...c, evidence: c.evidence.map(e => ({ ...e, source: graph.sources.find(s => s.id === e.source_id) })) }));
        return json({ ...edge, claims, contradictions: claims.filter(c => c.evidence.some(e => e.support_type === 'contradicts')) });
      }
      if (action === 'nodes' && childId && segments.length === 4) {
        const node = graph.nodes.find(n => n.id === childId); if (!node) throw new HttpError(404, 'not_found', 'Node not found');
        return json({ ...node, in_edge_ids: graph.edges.filter(e => e.target_node_id === childId).map(e => e.id), out_edge_ids: graph.edges.filter(e => e.source_node_id === childId).map(e => e.id), claims: graph.claims.filter(c => c.subject_id === childId || c.object_id === childId) });
      }
    }
    if (['claims', 'sources'].includes(resource) && resourceId && method === 'GET' && segments.length === 2) {
      for (const runId of await runIds()) {
        const graph = await readJson<Graph>(join(runPath(runId), 'graph.json'));
        const value = (resource === 'claims' ? graph.claims : graph.sources).find(r => r.id === resourceId);
        if (value) return json(value);
      }
    }
    throw new HttpError(404, 'not_found', 'Endpoint or resource not found');
  } catch (error) {
    const http = error instanceof HttpError ? error : error instanceof z.ZodError || error instanceof SyntaxError ? new HttpError(400, 'invalid_input', error.message) : (error as NodeJS.ErrnoException).code === 'ENOENT' ? new HttpError(404, 'not_found', 'Resource not found') : new HttpError(500, 'internal', error instanceof Error ? error.message : 'Internal error');
    return json({ error: { code: http.code, message: http.message, details: {}, request_id: id('req') } }, http.status);
  }
}
