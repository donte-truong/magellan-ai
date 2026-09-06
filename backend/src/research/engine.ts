import { resolve } from 'node:path';
import { Budget, Stop } from './budget';
import { Ledger, preflight, reviewGate } from './ledger';
import { assertLiveCredentials, LiveProvider, liveConfig, PROMPT_VERSION, ProviderHttpError, publicUrl, type Config, type Provider } from './providers';
import { ReplayProvider } from './replay';
import { RunStore } from './store';
import { extractionSchema, hash, id, inputSchema, normalize, planSchema, verificationSchema, type Candidate, type Document, type Graph, type Input, type Mode, type Run, type RunEvent, type Task } from './schema';

export interface Options {
  mode?: Mode; root?: string; signal?: AbortSignal; onEvent?: (event: RunEvent) => void;
  providerFactory?: (budget: Budget, store: RunStore) => Provider;
  onCreated?: (run: Run, directory: string) => void;
}
export interface ResearchResult { run: Run; graph: Graph; directory: string }
export function validateRequest(raw: unknown, mode: Mode): Input {
  const input = inputSchema.parse(raw);
  if (input.bom_estimate) {
    if (input.bom.length) throw new Error('Supply bom or bom_estimate, not both');
    if (normalize(input.product) !== normalize(input.bom_estimate.product.name)) throw new Error('product must match bom_estimate.product.name');
    const seeds = input.bom_estimate.sources.map(s => s.url).filter(url => /^https?:\/\//i.test(url));
    for (const url of seeds) publicUrl(url);
    for (const item of input.bom_estimate.items) for (const citation of item.sources) if ('url' in citation) publicUrl(citation.url);
    input.seed_urls = [...new Set([...input.seed_urls, ...seeds])].slice(0, 10);
  }
  for (const url of input.seed_urls) publicUrl(url);
  if (mode === 'replay' && (normalize(input.product) !== 'raspberry pi 5' || (input.company && normalize(input.company) !== 'raspberry pi') || input.bom.length || input.bom_estimate || input.seed_urls.some(u => u !== 'https://www.raspberrypi.com/products/raspberry-pi-5/'))) throw new Error('Curated replay accepts only Raspberry Pi 5 / Raspberry Pi, no custom BOM, and the example seed URL. Use live mode for other inputs.');
  return input;
}
export function selectPassages(text: string, target: string) {
  if (text.length <= 16_000) return { text, windows: [[0, text.length]] };
  const lower = text.toLowerCase(); const terms = target.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  const chunks = Array.from({ length: Math.ceil(text.length / 4000) }, (_, i) => ({ start: i * 4000, end: Math.min(text.length, (i + 1) * 4000 + 600) }));
  const ranked = chunks.map(c => ({ ...c, score: terms.reduce((n, t) => n + lower.slice(c.start, c.end).split(t).length - 1, 0) })).sort((a, b) => b.score - a.score);
  const selected = [chunks[0], ...ranked.filter(c => c.start !== 0).slice(0, 2)].sort((a, b) => a.start - b.start);
  return { text: selected.map(c => text.slice(c.start, c.end)).join('\n[OMITTED SOURCE TEXT]\n'), windows: selected.map(c => [c.start, c.end]) };
}
export async function runResearch(raw: unknown, options: Options = {}): Promise<ResearchResult> {
  const mode = options.mode ?? 'live';
  const input = validateRequest(raw, mode);
  let config: Config = { model: 'curated-replay', verifierModel: 'curated-replay', prices: { input: 0, output: 0, search: 0, extract: 0 } };
  if (mode === 'live' && !options.providerFactory) { assertLiveCredentials(); config = liveConfig(); }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Stop('max_seconds')), input.limits.max_seconds * 1000);
  timer.unref();
  const budget = new Budget(input.limits, config.prices, signal);
  const runId = id('run'); const ledger = new Ledger(input, runId, mode); const graph = ledger.graph;
  const store = new RunStore(resolve(options.root ?? process.env.RESEARCH_RUNS_DIR ?? 'runs'), runId);
  const run: Run = { id: runId, status: 'running', mode, product: input.product, company: input.company ?? null, graph_id: graph.id, limits: input.limits, usage: budget.usage, progress: { tasks_done: 0, tasks_total: 0 }, pending_questions: [], open_questions: [], stop_reason: null, events_url: `/v1/runs/${runId}/events`, created_at: new Date().toISOString(), completed_at: null };
  const frontier: Task[] = []; const seenUrls = new Set<string>(); const seenContent = new Set<string>(); const scheduled = new Set<string>();
  let active: Task | null = null;
  let taskBudgetBound = false;
  const gap = (question: string) => { if (!run.open_questions.includes(question) && run.open_questions.length < 100) run.open_questions.push(question); };
  const checkpoint = async () => { ledger.refresh(); budget.usage.elapsed_seconds = (Date.now() - budget.started) / 1000; await store.checkpoint(run, graph, { active, pending: frontier, visited_urls: [...seenUrls], scheduled_targets: [...scheduled] }); };
  const emit = async (type: string, payload: Record<string, unknown>) => { const event = await store.event(run, graph, type, payload); options.onEvent?.(event); };
  const enqueue = (task: Omit<Task, 'id'>) => {
    const key = `${task.target_node_id}:${normalize(task.query)}`;
    if (scheduled.has(key)) return;
    if (run.progress.tasks_total >= input.limits.max_tasks) { taskBudgetBound = true; gap(`Task budget left unsearched: ${task.question}`); return; }
    scheduled.add(key); frontier.push({ id: id('task'), ...task }); run.progress.tasks_total++;
  };
  await store.init(input, { ...config, mode, harness_version: '0.1.0', edge_metadata_method: 'edge_evidence_v1', prompt_version: PROMPT_VERSION, resolver_version: 'exact-kind-name-v1', passage_version: 'target-keyword-windows-v1', fixture: mode === 'replay' ? 'curated, hand-authored provider responses; no fresh research' : null });
  try {
    await checkpoint(); await store.render(run, graph);
    options.onCreated?.(run, store.dir);
    await emit('run.status', { status: run.status, progress: run.progress, usage: run.usage });
    for (const node of graph.nodes) await emit('node.added', { node });
    const provider = options.providerFactory?.(budget, store) ?? (mode === 'replay' ? new ReplayProvider(budget, store) : new LiveProvider(budget, store, config));
    if (provider.mode !== mode) throw new Error('Provider mode does not match run mode');
    // The explicit run request authorizes creation of this new research graph.
    // This workflow cannot mutate an existing graph or start any unrelated run.
    const imported = input.bom_estimate;
    if (imported) await store.trace('bom.import', 'snapshot_received', { bom_id: imported.id, items: imported.items.length, source_ids: imported.sources.map(s => s.id), policy: 'Imported evidence is unverified; preserve original basis/confidence separately from graph support.' });
    const rows = imported ? imported.items.map(item => ({ component: item.name, kind: item.category === 'material' ? 'material' as const : 'component' as const,
      quantity: item.quantity ?? undefined, unit: item.unit ?? undefined })) : input.bom;
    for (const [index, row] of rows.entries()) {
      const item = imported?.items[index];
      const provenance = item && imported ? { estimate_id: imported.id, ...item, cited_source_metadata: imported.sources.filter(s => item.sources.some(ref => 'source_id' in ref && ref.source_id === s.id)), verification: 'imported_not_independently_verified' } : null;
      const text = JSON.stringify({ product: input.product, ...row, ...(provenance ? { bom_estimate: provenance } : {}) });
      const doc: Document = { text, source: { id: id('src'), url: `urn:bom:${run.id}:row:${index + 1}`, title: `User BOM row ${index + 1}`, publisher: 'user', published_at: null, retrieved_at: new Date().toISOString(), content_hash: hash(text), source_family_id: `family_upload_${run.id}`, kind: 'upload', license_notes: 'User-provided BOM; not independently verified.' } };
      const candidate: Candidate = { subject: { kind: row.kind, label: row.component }, predicate: 'INPUT_TO', object: { kind: 'product', label: input.product }, scope_type: 'product', scope_entity: input.product, quote: text, rationale: 'User BOM row explicitly associates this input with the requested product.', polarity: 'supports' };
      await store.document(doc);
      const result = ledger.commit(candidate, doc, 'User assertion: bypasses model verification and remains labeled user_asserted.', budget);
      if (result.rejection) await emit('claim.rejected', { claim_id: id('clm'), ...result.rejection });
      if (result.claim) {
        const edge = graph.edges.find(e => e.claim_ids.includes(result.claim!.id));
        if (edge) {
          edge.data.operational = { quantity: row.quantity, unit: row.unit };
          if (provenance) edge.data.custom = { ...edge.data.custom, bom_estimate: provenance };
        }
        if (provenance) {
          const node = graph.nodes.find(n => n.id === result.claim!.subject_id)!;
          const custom = node.data.custom as { bom_items?: unknown[] };
          node.data.custom = { ...custom, bom_items: [...(custom.bom_items ?? []), provenance] };
        }
      }
      await checkpoint(); for (const event of result.events) await emit(event.type, event.payload);
    }
    const planningId = id('task');
    // Parent references are preserved as original BOM item IDs. They are not
    // asserted as verified PART_OF edges; independent research may establish them.
    const bomContext = imported?.items.map(({ id, name, category, manufacturer, part_number, parent_item_id, basis, confidence }) => ({ id, name, category, manufacturer, part_number, parent_item_id, basis, confidence }));
    const plan = await provider.model('plan', planSchema, { product: input.product, company: input.company ?? null,
      ...(bomContext ? { bom_estimate: { id: imported!.id, items: bomContext, provenance: 'UNVERIFIED_IMPORTED_ESTIMATE', instruction: 'Use part numbers, manufacturer hints and hierarchy to prioritize searches; verify every relationship against fetched sources.' } } : {}),
      requested_scope: 'Evidence for this exact product; company evidence must stay company scope.', limits: input.limits }, { task_id: planningId });
    for (const task of plan.tasks) enqueue({ ...task, target_node_id: graph.root_node_id, target_label: input.product, depth: 0 });
    if (!frontier.length) enqueue({ target_node_id: graph.root_node_id, target_label: input.product, depth: 0, question: `What publicly evidenced inputs and manufacturing facilities are associated with ${input.product}?`, query: `${input.product} ${input.company ?? ''} components manufacturing official datasheet`, reason: 'Deterministic fallback because the planner returned no tasks.' });
    await store.trace('plan', 'frontier_created', { tasks: frontier }); await checkpoint();
    let stagnant = 0;
    while (frontier.length) {
      budget.check(); active = frontier.shift()!;
      await checkpoint();
      await emit('task.started', { task_id: active.id, target_node_id: active.target_node_id, relation_sought: active.question, depth: active.depth });
      const context = { task_id: active.id }; const before = graph.claims.length;
      const seeds = input.seed_urls.map(publicUrl).filter(url => !seenUrls.has(url));
      let hits: { url: string; title: string; snippet: string }[] = [];
      if (budget.usage.searches < input.limits.max_searches) hits = await provider.search(active.query, context);
      else if (!seeds.length) budget.stop('max_searches');
      const availableUrls = [...new Set([...seeds, ...hits.map(h => h.url)])].filter(url => !seenUrls.has(url));
      const urls = availableUrls.slice(0, 4);
      for (const omitted of availableUrls.slice(4)) gap(`Per-task document allowance deferred this source: ${omitted}`);
      if (!urls.length) gap(`No new source documents found: ${active.question}`);
      for (const url of urls) {
        budget.check(); seenUrls.add(url);
        let doc: Document;
        try { doc = await provider.fetch(url, context); }
        catch (error) {
          if (error instanceof Stop) throw error;
          budget.check();
          const reason = error instanceof Error ? error.message : 'Source retrieval failed';
          await emit('source.failed', { url, reason }); gap(`Source unavailable: ${url} (${reason})`);
          if (error instanceof ProviderHttpError && [401, 403, 429].includes(error.status)) throw error;
          continue;
        }
        if (seenContent.has(doc.source.content_hash)) { await store.trace('fetch', 'duplicate_content', { ...context, url, content_hash: doc.source.content_hash }); continue; }
        seenContent.add(doc.source.content_hash);
        doc.source.title ??= hits.find(h => h.url === url)?.title ?? null;
        await store.document(doc); ledger.addSource(doc);
        await emit('source.retrieved', { source_id: doc.source.id, url: doc.source.url, title: doc.source.title, publisher: doc.source.publisher, published_at: doc.source.published_at });
        const passages = selectPassages(doc.text, active.target_label);
        await store.trace('extract', 'passages_selected', { ...context, source_id: doc.source.id, source_hash: doc.source.content_hash, windows: passages.windows, omitted_characters: Math.max(0, doc.text.length - passages.text.length) });
        const extracted = await provider.model('extract', extractionSchema, { product: input.product, company: input.company ?? null, task: active.question, known_entities: graph.nodes.map(n => ({ kind: n.kind, label: n.label })), document: { source_id: doc.source.id, url: doc.source.url, text: passages.text } }, context);
        extracted.gaps.forEach(gap);
        const valid: { index: number; candidate: Candidate; claim_id: string; context: string }[] = [];
        for (const [index, candidate] of extracted.candidates.entries()) {
          const claim_id = id('clm');
          await emit('claim.proposed', { claim_id, subject_label: candidate.subject.label, predicate: candidate.predicate, object_label: candidate.object.label, scope: { type: candidate.scope_type, entity: candidate.scope_entity } });
          const rejection = preflight(candidate, doc, input);
          if (rejection) { await emit('claim.rejected', { claim_id, ...rejection }); await store.trace('verify', 'rejected', { ...context, source_id: doc.source.id, candidate, ...rejection }); }
          else { const start = doc.text.indexOf(candidate.quote); valid.push({ index, candidate, claim_id, context: doc.text.slice(Math.max(0, start - 450), start + candidate.quote.length + 450) }); }
        }
        if (valid.length) {
          const verified = await provider.model('verify', verificationSchema, { product: input.product, company: input.company ?? null, candidates: valid.map(v => ({ index: v.index, claim: { subject: v.candidate.subject, predicate: v.candidate.predicate, object: v.candidate.object, scope_type: v.candidate.scope_type, scope_entity: v.candidate.scope_entity, polarity: v.candidate.polarity }, quote: v.candidate.quote, context: v.context })) }, context);
          const eligible: typeof valid = [];
          for (const candidate of valid) {
            const matches = verified.verdicts.filter(v => v.index === candidate.index);
            const rejection = matches.length !== 1 ? { reason: 'entailment_failed', detail: 'Verifier must return exactly one verdict for this candidate.' } : reviewGate(matches[0]);
            if (rejection) { await emit('claim.rejected', { claim_id: candidate.claim_id, ...rejection }); await store.trace('verify', 'rejected', { ...context, candidate: candidate.candidate, ...rejection }); }
            else eligible.push(candidate);
          }
          // Resolve connected relations before their children, independent of extraction order.
          for (let pass = 0; eligible.length && pass <= valid.length; pass++) {
            let progressed = false;
            for (let i = 0; i < eligible.length;) {
              const candidate = eligible[i];
              const result = ledger.commit(candidate.candidate, doc, verified.verdicts.find(v => v.index === candidate.index)!.explanation, budget, candidate.claim_id);
              if (result.rejection?.reason === 'disconnected') { i++; continue; }
              eligible.splice(i, 1); progressed = true;
              await store.trace('commit', result.rejection ? 'rejected' : 'accepted', { ...context, proposed_claim_id: candidate.claim_id, committed_claim_id: result.claim?.id, source_id: doc.source.id, candidate: candidate.candidate, rejection: result.rejection });
              if (result.rejection) { await emit('claim.rejected', { claim_id: candidate.claim_id, ...result.rejection }); gap(`${candidate.candidate.subject.label} ${candidate.candidate.predicate} ${candidate.candidate.object.label}: ${result.rejection.detail}`); }
              else {
                await checkpoint();
                for (const event of result.events) await emit(event.type, event.payload);
                await store.render(run, graph);
                for (const node of result.added) {
                  const depth = ledger.distance.get(node.id)!;
                  if (depth >= input.limits.max_hops || node.kind === 'geography') { gap(`Research boundary reached at ${node.label}; upstream dependencies remain unknown.`); continue; }
                  enqueue({ target_node_id: node.id, target_label: node.label, depth, question: `What upstream inputs, physical manufacturer, or facility location are explicitly evidenced for ${node.label}?`, query: `${node.label} ${node.kind === 'facility' ? 'location operates' : 'manufacturer materials datasheet'} official`, reason: `Expand a verified discovery from ${doc.source.id}; names are data in a fixed search template.` });
                }
              }
            }
            if (!progressed) break;
          }
          for (const candidate of eligible) { await emit('claim.rejected', { claim_id: candidate.claim_id, reason: 'disconnected', detail: 'Unrelated or unresolved endpoints; no link to research context.' }); }
        }
        await emit('budget.updated', { ...budget.usage }); await checkpoint();
      }
      run.progress.tasks_done++;
      stagnant = graph.claims.length === before ? stagnant + 1 : 0;
      if (graph.claims.length === before) gap(`No additional verified relations: ${active.question}`);
      await emit('task.finished', { task_id: active.id, target_node_id: active.target_node_id, relation_sought: active.question, depth: active.depth, outcome: `${graph.claims.length - before} claims committed` });
      active = null; await checkpoint();
      if (stagnant >= 2 && frontier.length) throw new Stop('no_progress');
    }
    run.status = graph.edges.length && !taskBudgetBound ? 'completed' : 'partial';
    run.stop_reason = taskBudgetBound ? 'max_tasks' : graph.edges.length ? 'frontier_exhausted' : 'no_verified_findings';
    if (taskBudgetBound) budget.usage.binding_limit = 'max_tasks';
  } catch (error) {
    if (error instanceof Stop || signal.aborted) {
      const reason = error instanceof Stop ? error.reason : signal.reason instanceof Stop ? signal.reason.reason : 'cancelled';
      run.status = reason === 'cancelled' ? 'cancelled' : 'partial'; run.stop_reason = reason; budget.usage.binding_limit = reason;
    } else {
      run.status = graph.claims.length ? 'partial' : 'failed'; run.stop_reason = 'provider_or_workflow_error';
      gap(error instanceof Error ? error.message : 'Unknown workflow failure');
      await store.trace('run', 'failed', { error: error instanceof Error ? error.message : String(error), task_id: active?.id });
    }
    if (active) gap(`Interrupted task: ${active.question}`);
    frontier.forEach(t => gap(`Unfinished task: ${t.question}`));
  } finally {
    clearTimeout(timer);
    run.completed_at = new Date().toISOString();
    gap('This is a bounded public-evidence snapshot, not an exhaustive or current bill of materials.');
    await checkpoint(); await store.render(run, graph);
    await emit('run.completed', { status: run.status, stop_reason: run.stop_reason, coverage_summary: graph.stats, open_questions: run.open_questions });
  }
  return { run, graph, directory: store.dir };
}
