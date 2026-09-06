"""Durable asyncio worker. Run one process with bounded research slots."""

import asyncio
import json
import logging
import math
import signal
import time
from copy import deepcopy
from urllib.parse import urlsplit

from app.config import Settings
from app.db import Database, digest, new_id, now, public
from app.errors import APIError
from app.geography import GeographyService
from app.graphs import (
    add_claim_edge,
    make_node,
    make_source,
    refresh,
)
from app.providers import Budget, BudgetExceeded, ProviderFailure, build_provider
from app.resolution import (
    NON_DEPENDENCY_KINDS,
    RELATION_TYPES,
    interface_feature,
    near_duplicates,
    normalize_label,
    part_tokens,
    record_identity,
    resolution_candidates,
    resolve_entity,
    software_artifact,
    valid_relation,
)
from app.schemas import RunLimits

logger = logging.getLogger(__name__)


class RunStopped(Exception):
    pass


MAX_TRACE_ENTRIES = 200
MAX_TRACE_TEXT = 8000
PLANNER_CONTEXT_CHARS = 6000
RELATIONS_BY_KIND = {
    "product": ["upstream_inputs", "manufacturer_or_facility"],
    "component": ["upstream_inputs", "manufacturer_or_facility"],
    "material": ["material_origin", "supplier"],
    "organization": ["supplier"],
    "facility": ["supplier"],
}
PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}


class RunState:
    """Per-run scheduling and reuse memory. Lives only for the duration of process_run()."""

    def __init__(self):
        self.sources = {}  # content hash -> stored source record
        self.analyzed = {}  # content hash -> set of (target id, relation sought)
        self.spend = {}  # branch id -> documents consumed
        self.done = {}  # branch id -> tasks completed
        self.branch_of = {}  # node id -> branch id
        self.queries = {}  # node id -> queries tried
        self.failed = {}  # node id -> queries with no verified finding
        self.trace = []
        self.visited = set()
        self.invalid_documents = []  # pages whose model output was unusable
        self.stale = {}  # branch id -> consecutive tasks without a verified finding
        self.paused = set()  # branches paused by the stagnation rule
        self.analysis_slots = None  # asyncio.Semaphore bounding concurrent document analyses
        self.running = {}  # asyncio task -> branch id, for fair concurrent scheduling

    def record(self, entry):
        if len(self.trace) >= MAX_TRACE_ENTRIES:
            self.trace.pop(0)
        self.trace.append(
            {
                "at": now(),
                **{k: (v[:MAX_TRACE_TEXT] if isinstance(v, str) else v) for k, v in entry.items()},
            }
        )

    def branch(self, node, graph):
        if node["id"] == graph["root_node_id"]:
            return "root"
        return self.branch_of.get(node["id"], node["id"])


def branch_label(graph, branch):
    return next((n["label"] for n in graph["nodes"] if n["id"] == branch), branch)


def unanswered_relations(graph, node):
    """Relation types with no directly supported inbound edge for this node."""
    supported = {
        e["predicate"]
        for e in graph["edges"]
        if e["target_node_id"] == node["id"] and e["support_label"] == "directly_supported"
    }
    return [
        relation
        for relation in RELATIONS_BY_KIND.get(node["kind"], [])
        if not supported & RELATION_TYPES[relation]
    ]


def template_queries(product, company, node, hints):
    label, kind = node["label"], node["kind"]
    company = company or ""
    if node.get("tier") == 0:
        return [
            f"{product} {company} teardown components",
            f"{product} specifications datasheet bill of materials",
        ]
    if kind == "component":
        return [f"{label} {hints} datasheet manufacturer", f"{product} {label} supplier"]
    if kind == "material":
        return [f"{label} refiner smelter supplier {product}", f"{label} production country"]
    return [f"{label} manufacturing plant location", f"{label} supplies {product}"]


def planner_context(run, graph, node, state, budget, questions):
    """Bounded graph context: newest triples first, oldest dropped past the character budget."""
    names = {n["id"]: n["label"] for n in graph["nodes"]}
    triples = [
        {
            "subject": names.get(e["source_node_id"]),
            "predicate": e["predicate"],
            "object": names.get(e["target_node_id"]),
            "scope": e["scope"]["type"],
            "support": e["support_label"],
        }
        for e in graph["edges"]
    ]
    kept, size = [], 0
    for triple in reversed(triples):
        size += len(json.dumps(triple))
        if size > PLANNER_CONTEXT_CHARS:
            break
        kept.append(triple)
    imported = [
        {k: item.get(k) for k in ("part_number", "manufacturer", "material")}
        for item in ((node.get("data") or {}).get("custom") or {}).get("bom_items", [])
        if isinstance(item, dict)
    ][:5]
    return {
        "product": run["product"],
        "company": run["company"],
        "target": {
            "label": node["label"],
            "kind": node["kind"],
            "tier": node.get("tier"),
            "external_ids": node.get("external_ids") or {},
            "aliases": node.get("aliases") or [],
            "imported_hints": imported,
        },
        "triples": list(reversed(kept)),
        "triples_omitted": max(0, len(triples) - len(kept)),
        "unanswered": unanswered_relations(graph, node),
        "previous_queries": state.queries.get(node["id"], [])[-6:],
        "failed_queries": state.failed.get(node["id"], [])[-6:],
        "open_questions": questions[-8:],
        "remaining": {
            "searches": budget.remaining("searches"),
            "documents": budget.remaining("documents"),
            "seconds": max(
                0, round(run["limits"]["max_seconds"] - budget.usage.get("elapsed_seconds", 0))
            ),
        },
    }


class Worker:
    def __init__(self, db, settings, provider=None, geography=None):
        self.db, self.settings = db, settings
        self.provider = provider or build_provider(settings)
        self.geography = geography or GeographyService(settings.production_data_path)
        self.identifier = new_id("worker")

    def emit(self, repo, job, kind, payload):
        return repo.emit(job, kind, payload, self.settings.event_retention)

    def claim_next(self):
        for workspace in self.db.workspaces():
            with self.db.transaction(workspace, write=True) as repo:
                for kind in ("run", "enrichment"):
                    for job in reversed(repo.all(kind)):
                        if job["status"] == "running" and job.get("_lease_until", 0) < time.time():
                            # Do not repeat uncertain paid provider calls after a crash.
                            if kind == "run":
                                job.update(
                                    status="partial",
                                    stop_reason="worker_interrupted",
                                    completed_at=now(),
                                )
                                job["open_questions"].append(
                                    "Worker interrupted; committed evidence was preserved. Start a new run to continue research."
                                )
                                self.emit(
                                    repo,
                                    job,
                                    "run.completed",
                                    {
                                        "status": "partial",
                                        "stop_reason": job["stop_reason"],
                                        "coverage_summary": {},
                                        "open_questions": job["open_questions"],
                                    },
                                )
                            else:
                                job["status"] = "partial"
                                job["results"].extend(
                                    {
                                        "node_id": nid,
                                        "kind": k,
                                        "outcome": "unresolved",
                                        "reason": "worker_interrupted",
                                    }
                                    for nid in job["_node_ids"]
                                    for k in job["kinds"]
                                    if not any(
                                        r["node_id"] == nid and r["kind"] == k
                                        for r in job["results"]
                                    )
                                )
                                self.emit(repo, job, "job.completed", {"resource": public(job)})
                            repo.put(kind, job)
                        if job["status"] != "queued":
                            continue
                        job.update(
                            status="running",
                            _worker=self.identifier,
                            _lease_until=time.time() + self.settings.worker_lease_seconds,
                        )
                        self.emit(
                            repo,
                            job,
                            "run.status" if kind == "run" else "job.status",
                            {
                                "status": "running",
                                "progress": job["progress"],
                                **({"usage": job["usage"]} if kind == "run" else {}),
                            },
                        )
                        repo.put(kind, job)
                        return workspace, kind, job["id"]
        return None

    async def tick(self):
        claimed = self.claim_next()
        if claimed is None:
            return False
        workspace, kind, identifier = claimed
        try:
            if kind == "run":
                await self.process_run(workspace, identifier)
            else:
                await self.process_enrichment(workspace, identifier)
        except asyncio.CancelledError:
            self.fail(workspace, kind, identifier, "worker_interrupted")
            raise
        except Exception:
            logger.exception("Worker job failed: %s", identifier)
            self.fail(workspace, kind, identifier, "internal")
        return True

    def owned(self, repo, identifier, kind="run"):
        job = repo.get(identifier, kind)
        if job["status"] != "running" or job.get("_worker") != self.identifier:
            raise RunStopped
        job["_lease_until"] = time.time() + self.settings.worker_lease_seconds
        return job

    def fail(self, workspace, kind, identifier, reason):
        with self.db.transaction(workspace, write=True) as repo:
            job = repo.get(identifier, kind)
            if job["status"] != "running" or job.get("_worker") != self.identifier:
                return
            if kind == "run":
                graph = repo.graph(job["graph_id"])
                job.update(
                    status="partial" if graph["edges"] else "failed",
                    stop_reason=reason,
                    completed_at=now(),
                )
                job["open_questions"].append(
                    f"Research stopped: {reason}; committed findings were retained."
                )
                self.emit(
                    repo,
                    job,
                    "run.completed",
                    {
                        "status": job["status"],
                        "stop_reason": reason,
                        "coverage_summary": graph["stats"],
                        "open_questions": job["open_questions"],
                    },
                )
            else:
                job["status"] = "failed"
                job["results"].extend(
                    {"node_id": nid, "kind": k, "outcome": "unresolved", "reason": reason}
                    for nid in job["_node_ids"]
                    for k in job["kinds"]
                    if not any(r["node_id"] == nid and r["kind"] == k for r in job["results"])
                )
                self.emit(repo, job, "job.completed", {"resource": public(job)})
            repo.put(kind, job)

    async def process_run(self, workspace, identifier):
        with self.db.transaction(workspace) as repo:
            run = self.owned(repo, identifier)
        if run["mode"] == "replay":
            await self.replay(workspace, identifier, run)
            return
        if self.provider.name == "curated_fixture" and run["product"].casefold() in {
            "raspberry pi",
            "rpi",
        }:
            with self.db.transaction(workspace, write=True) as repo:
                run = self.owned(repo, identifier)
                question = {
                    "question_id": new_id("q"),
                    "kind": "product_ambiguity",
                    "prompt": "Choose the exact product to research.",
                    "choices": [
                        {
                            "id": "raspberry-pi-5",
                            "label": "Raspberry Pi 5",
                            "detail": "Available curated public-source example",
                        }
                    ],
                }
                run.update(status="awaiting_input", pending_questions=[question])
                self.emit(repo, run, "run.question", question)
                repo.put("run", run)
            return
        usage = deepcopy(run["usage"])
        state = RunState()

        def checkpoint():
            with self.db.transaction(workspace, write=True) as repo:
                current = self.owned(repo, identifier)
                current["usage"] = deepcopy(usage)
                repo.put("run", current)

        budget = Budget(run["limits"], usage, checkpoint, state.record)
        reason, questions = "research_exhausted", []
        try:
            async with asyncio.timeout(run["limits"]["max_seconds"]):
                if run["upload_id"]:
                    self.ingest_upload(workspace, identifier, budget)
                if run.get("_bom_estimate"):
                    self.ingest_estimate(workspace, identifier, budget)
                if run.get("_seed_urls") and hasattr(self.provider, "fetch_page"):
                    await self.research_seeds(workspace, identifier, run, budget, questions, state)
                state.analysis_slots = asyncio.Semaphore(self.settings.research_concurrency)
                await self.research_all(workspace, identifier, run, budget, questions, state)
                if self.provider.name == "curated_fixture":
                    entry = self.provider.lookup(run["product"], run["company"])
                    questions.extend(
                        entry["notes"]
                        if entry
                        else [
                            "No curated evidence is available for this product; configure live research to search public sources."
                        ]
                    )
                else:
                    questions.append(
                        "Public evidence does not establish a complete manufacturing BOM or all supplier tiers."
                    )
        except BudgetExceeded as exc:
            reason = "budget_exhausted"
            usage["binding_limit"] = exc.limit
            questions.append(
                f"Research stopped at {exc.limit}; unexplored branches remain unknown."
            )
        except TimeoutError:
            reason, usage["binding_limit"] = "budget_exhausted", "max_seconds"
            questions.append("Research time budget exhausted.")
        except ProviderFailure as exc:
            reason = exc.code
            questions.append(exc.message)
        except RunStopped:
            return
        usage["elapsed_seconds"] = round(time.monotonic() - budget.started, 3)
        if self.provider.name != "curated_fixture":
            rates = (
                self.settings.input_token_cost_per_million_minor,
                self.settings.output_token_cost_per_million_minor,
                self.settings.search_cost_minor,
            )
            if all(r is not None for r in rates):
                usage["cost_minor"] = math.ceil(
                    usage["input_tokens"] * rates[0] / 1e6
                    + usage["output_tokens"] * rates[1] / 1e6
                    + usage["searches"] * rates[2]
                )
            else:
                questions.append(
                    "Provider cost is unavailable until operator billing rates are configured; usage counts are retained."
                )
        with self.db.transaction(workspace, write=True) as repo:
            current = repo.get(identifier, "run")
            current["usage"] = usage
            self.save_trace(repo, identifier, state)
            if current["status"] == "cancelled":
                repo.put("run", current)
                return
            graph = repo.graph(current["graph_id"])
            current.update(
                status="partial",
                stop_reason=reason,
                completed_at=now(),
                open_questions=list(dict.fromkeys(questions)),
            )
            self.emit(repo, current, "budget.updated", usage)
            self.emit(
                repo,
                current,
                "run.completed",
                {
                    "status": current["status"],
                    "stop_reason": reason,
                    "coverage_summary": graph["stats"],
                    "open_questions": current["open_questions"],
                },
            )
            repo.put("run", current)

    def save_trace(self, repo, identifier, state):
        """Bounded private model-call history; read only through GET /runs/{id}/history."""
        repo.put(
            "trace",
            {
                "id": f"{identifier}:trace",
                "run_id": identifier,
                "entries": list(state.trace),
                "created_at": now(),
            },
            identifier,
        )

    def pending_tasks(self, graph, run, state):
        return [
            n
            for n in graph["nodes"]
            if n["tier"] is not None
            and n["tier"] < run["limits"]["max_hops"]
            and n["id"] not in state.visited
            and state.branch(n, graph) not in state.paused
        ]

    def frontier_counts(self, graph, run, state):
        counts = {}
        for node in self.pending_tasks(graph, run, state):
            counts[str(node["tier"])] = counts.get(str(node["tier"]), 0) + 1
        return counts

    def next_task(self, workspace, identifier, run, state):
        """Fair opportunity: branches with no task in flight first, then the branch that has
        consumed the fewest documents per completed task; ties go to the lower tier, then to
        targets with more unanswered relation types. Returns (node, branch) or None."""
        with self.db.transaction(workspace) as repo:
            graph = repo.graph(run["graph_id"])
        pending = self.pending_tasks(graph, run, state)
        if not pending:
            return None
        for node in pending:
            if node["id"] not in state.branch_of and node["tier"] == 1:
                state.branch_of[node["id"]] = node["id"]
        busy = set(state.running.values())

        def key(node):
            branch = state.branch(node, graph)
            fairness = state.spend.get(branch, 0) / (1 + state.done.get(branch, 0))
            return (
                branch in busy,
                fairness,
                node["tier"],
                -len(unanswered_relations(graph, node)),
                node["label"],
            )

        node = min(pending, key=key)
        return node, state.branch(node, graph)

    async def research_all(self, workspace, identifier, run, budget, questions, state):
        """Run research tasks as a bounded pool. Model calls overlap across tasks; every graph
        commit and budget charge is a synchronous step, so ordering rules are unchanged. The
        first budget stop or provider failure cancels the other tasks."""
        running = state.running
        try:
            while True:
                while len(running) < self.settings.task_concurrency:
                    chosen = self.next_task(workspace, identifier, run, state)
                    if chosen is None:
                        break
                    node, branch = chosen
                    state.visited.add(node["id"])
                    task = asyncio.create_task(
                        self.research_task(
                            workspace, identifier, run, node, budget, questions, state
                        )
                    )
                    running[task] = branch
                if not running:
                    return
                done, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    running.pop(task)
                    task.result()
        finally:
            for task in running:
                task.cancel()
            await asyncio.gather(*running, return_exceptions=True)
            running.clear()

    async def plan_task(self, run, graph, node, budget, questions, state, failed=None):
        hints = self.provider.query_hints(node) if hasattr(self.provider, "query_hints") else ""
        fallback = {
            "relation_sought": (unanswered_relations(graph, node) or ["upstream_inputs"])[0],
            "queries": template_queries(run["product"], run["company"], node, hints),
            "source_types": {},
            "skip": False,
            "skip_reason": None,
            "priority": "medium",
            "source": "template",
        }
        if not hasattr(self.provider, "plan"):
            return fallback
        context = planner_context(run, graph, node, state, budget, questions)
        if failed:
            context["failed_queries"] = list(dict.fromkeys(context["failed_queries"] + failed))
        try:
            plan = await self.provider.plan(context, budget)
        except ProviderFailure as exc:
            if exc.code != "model_output_invalid":
                raise
            questions.append(
                f"Planner output was invalid for {node['label']}; used template queries."
            )
            return fallback
        queries = [q.query for q in plan.queries if q.query.strip()]
        return {
            "relation_sought": plan.relation_sought,
            "queries": queries or fallback["queries"],
            "source_types": {q.query: list(q.source_types) for q in plan.queries},
            "skip": plan.skip,
            "skip_reason": plan.skip_reason,
            "priority": plan.priority,
            "source": "planner",
        }

    async def research_task(self, workspace, identifier, run, target, budget, questions, state):
        state.visited.add(target["id"])
        with self.db.transaction(workspace) as repo:
            graph = repo.graph(run["graph_id"])
        branch = state.branch(target, graph)
        budget.check()
        plan = await self.plan_task(run, graph, target, budget, questions, state)
        task = {
            "task_id": new_id("task"),
            "target_node_id": target["id"],
            "relation_sought": plan["relation_sought"],
            "depth": target["tier"],
        }
        with self.db.transaction(workspace, write=True) as repo:
            current = self.owned(repo, identifier)
            self.emit(
                repo,
                current,
                "task.planned",
                {
                    **task,
                    "queries": plan["queries"],
                    "skip": plan["skip"],
                    "skip_reason": plan["skip_reason"],
                    "priority": plan["priority"],
                    "planner": plan["source"],
                },
            )
            if plan["skip"]:
                questions.append(
                    f"Skipped research for {target['label']}: {plan['skip_reason'] or 'no likely public source'}."
                )
            else:
                self.emit(repo, current, "task.started", task)
            repo.put("run", current)
        found, failure = 0, None
        if not plan["skip"]:
            limits = run["limits"]
            searches_used = documents_used = 0
            queries = list(plan["queries"])
            replanned = False
            while queries and searches_used < limits["max_searches_per_task"]:
                query = queries.pop(0)
                if documents_used >= limits["max_documents_per_task"]:
                    break
                state.queries.setdefault(target["id"], []).append(query)
                searches_used += 1
                before = found
                before_invalid = len(state.invalid_documents)
                found_here, docs = await self.run_query(
                    workspace,
                    identifier,
                    run,
                    target,
                    query,
                    plan,
                    budget,
                    state,
                    limits,
                    documents_used,
                    remaining_queries=len(queries) + 1,
                )
                if len(state.invalid_documents) > before_invalid and not found_here:
                    failure = "model_output_invalid"
                    questions.append(
                        f"Model output was unusable for {len(state.invalid_documents) - before_invalid} document(s) while researching {target['label']}; other documents and branches continued."
                    )
                found += found_here
                documents_used += docs
                state.spend[branch] = state.spend.get(branch, 0) + docs
                if found == before:
                    state.failed.setdefault(target["id"], []).append(query)
                    # Replan once with the failed query on record; per-task planning is the experiment.
                    if (
                        not replanned
                        and not queries
                        and budget.remaining("searches")
                        and plan["source"] == "planner"
                    ):
                        replanned = True
                        again = await self.plan_task(
                            run, graph, target, budget, questions, state, failed=[query]
                        )
                        tried = set(state.queries.get(target["id"], []))
                        queries = [q for q in again["queries"] if q not in tried]
                        if again["skip"]:
                            queries = []
        state.done[branch] = state.done.get(branch, 0) + 1
        if not found and not plan["skip"] and not failure:
            questions.append(f"No further verified upstream inputs for {target['label']}.")
        state.stale[branch] = 0 if found else state.stale.get(branch, 0) + 1
        limit = self.settings.branch_stagnation_tasks
        if limit and branch != "root" and state.stale[branch] >= limit:
            with self.db.transaction(workspace) as repo:
                remaining = [
                    n
                    for n in self.pending_tasks(repo.graph(run["graph_id"]), run, state)
                    if state.branch(n, repo.graph(run["graph_id"])) == branch
                ]
            if remaining:
                state.paused.add(branch)
                questions.append(
                    f"Paused the {branch_label(graph, branch)} branch after {limit} tasks without verified findings; "
                    f"{len(remaining)} pending task(s) released their budget to other branches."
                )
        with self.db.transaction(workspace, write=True) as repo:
            current = self.owned(repo, identifier)
            graph = repo.graph(run["graph_id"])
            pending = self.pending_tasks(graph, run, state)
            current["progress"] = {
                "tasks_done": len(state.visited),
                "tasks_total": len(state.visited) + len(pending),
            }
            current["frontier"] = self.frontier_counts(graph, run, state)
            outcome = (
                "skipped"
                if plan["skip"]
                else "findings_committed"
                if found
                else f"failed:{failure}"
                if failure
                else "unresolved"
            )
            self.emit(repo, current, "task.finished", {**task, "outcome": outcome})
            self.save_trace(repo, identifier, state)
            repo.put("run", current)

    @staticmethod
    def relevant(body, run, target):
        """A long page that never names the product, the target, or an alias is not worth a call."""
        if len(body) <= 2000:
            return True
        text = body.casefold()
        ids = target.get("external_ids") or {}
        names = [run["product"], target["label"], ids.get("mpn"), *target.get("aliases", [])]
        # A datasheet names the part number, not the descriptive label the graph carries.
        names.extend(part_tokens(normalize_label(target["label"])))
        return any(name and name.casefold() in text for name in names)

    async def run_query(
        self,
        workspace,
        identifier,
        run,
        target,
        query,
        plan,
        budget,
        state,
        limits,
        used,
        remaining_queries=1,
    ):
        """One search: reuse pages already analyzed for this question, analyze the rest, commit."""
        found = docs = 0
        invalid = state.invalid_documents
        question = (target["id"], plan["relation_sought"])
        # Spread the task's document allowance across its remaining queries so one query that
        # returns irrelevant pages cannot starve the others.
        share = -(-(limits["max_documents_per_task"] - used) // max(1, remaining_queries))
        room = max(1, min(share, limits["max_documents_per_task"] - used, 5))
        if hasattr(self.provider, "search_pages") and hasattr(self.provider, "analyze"):
            pages = await self.provider.search_pages(
                query,
                room,
                budget,
                source_types=plan.get("source_types", {}).get(query),
                product=run["product"],
                company=run["company"],
            )
            chosen, deferred = [], None
            for page in pages:
                if len(chosen) >= room:
                    break
                try:
                    budget.check()
                except BudgetExceeded as exc:
                    deferred = exc
                    break
                if not page.body:
                    continue
                if not self.relevant(page.body, run, target):
                    state.record(
                        {
                            "stage": "document",
                            "url": page.url,
                            "skipped": "no mention of product or target",
                        }
                    )
                    continue
                content_hash = digest(page.body.encode())
                seen = state.analyzed.setdefault(content_hash, set())
                if question in seen:
                    state.record(
                        {
                            "stage": "reuse",
                            "url": page.url,
                            "skipped": "already analyzed for this question",
                        }
                    )
                    continue
                seen.add(question)
                try:
                    budget.charge("documents")
                except BudgetExceeded as exc:
                    # Selected pages are still analyzed and committed before the stop propagates.
                    seen.discard(question)
                    deferred = exc
                    break
                docs += 1
                chosen.append(page)
            # Model calls run concurrently (bounded); commits stay sequential through the
            # single-writer transaction, so ordering and budgets are unchanged.
            semaphore = state.analysis_slots or asyncio.Semaphore(
                self.settings.research_concurrency
            )

            async def analyze(page):
                async with semaphore:
                    try:
                        return (
                            page,
                            await self.provider.analyze(
                                target,
                                run["product"],
                                run["company"],
                                page.url,
                                page.title,
                                page.body,
                                budget,
                            ),
                            None,
                        )
                    except ProviderFailure as exc:
                        if exc.code != "model_output_invalid":
                            raise
                        return page, None, exc.code

            for page, document, failure in await asyncio.gather(*(analyze(p) for p in chosen)):
                if failure:
                    # One unusable model output fails this document only; the task continues.
                    state.record({"stage": "document", "url": page.url, "failure": failure})
                    invalid.append(page.url)
                    continue
                await self.resolve_findings(workspace, run, target, document, budget, state)
                committed = len(
                    self.commit_document(workspace, identifier, target, document, budget, state)
                )
                found += committed
                state.record(
                    {
                        "stage": "document",
                        "url": page.url,
                        "chars": len(page.body),
                        "findings": len(document.findings),
                        "rejected": sum(1 for f in document.findings if f.rejection),
                        "new_nodes": committed,
                    }
                )
            if deferred:
                raise deferred
            return found, docs
        # Legacy providers expose only research(); no reuse is possible for them.
        async for document in self.provider.research(
            target, run["product"], run["company"], budget
        ):
            budget.check()
            docs += 1
            found += len(
                self.commit_document(workspace, identifier, target, document, budget, state)
            )
            await asyncio.sleep(0)
        return found, docs

    async def resolve_findings(self, workspace, run, target, document, budget, state):
        """Ask the model whether labels about to become new nodes paraphrase existing ones.

        Runs just before the document commits, against the current graph, with a bounded candidate
        list per label. Decisions are hints: commit_document re-runs the deterministic rules first
        and only uses a hint when they find nothing.
        """
        mode = self.settings.model_resolution
        if mode == "off" or not hasattr(self.provider, "resolve"):
            return
        with self.db.transaction(workspace) as repo:
            graph = repo.graph(run["graph_id"])
        target_node = next((n for n in graph["nodes"] if n["id"] == target["id"]), None)
        if target_node is None:
            return
        items, slots = [], []
        for finding in document.findings:
            if finding.rejection:
                continue
            object_label = finding.object_label or target_node["label"]
            object_kind = finding.object_kind or target_node["kind"]
            subject, s_review = resolve_entity(
                graph, finding.kind, finding.label, finding.part_number, finding.manufacturer
            )
            if finding.object_label is None:
                obj, o_review = target_node, None
            else:
                obj, o_review = resolve_entity(graph, object_kind, object_label)
            if s_review or o_review:
                continue  # identifier conflicts and ambiguity stay with the deterministic rules
            for role, node, kind, label, ids in (
                (
                    "subject",
                    subject,
                    finding.kind,
                    finding.label,
                    (finding.part_number, finding.manufacturer),
                ),
                ("object", obj, object_kind, object_label, (None, None)),
            ):
                if node is not None:
                    continue
                anchor = obj if role == "subject" else subject
                candidates = resolution_candidates(
                    graph, kind, label, anchor["id"] if anchor else None
                )
                if not candidates:
                    continue
                items.append(
                    {
                        "index": len(items),
                        "label": label,
                        "kind": kind,
                        "part_number": ids[0],
                        "manufacturer": ids[1],
                        "quote": finding.span[:300],
                        "candidates": [
                            {
                                "index": i,
                                "label": c["label"],
                                "aliases": c.get("aliases", [])[:4],
                                "external_ids": c.get("external_ids") or {},
                            }
                            for i, c in enumerate(candidates)
                        ],
                    }
                )
                slots.append((finding, role, candidates))
        if not items:
            return
        try:
            decisions = await self.provider.resolve(run["product"], items, budget)
        except ProviderFailure as exc:
            if exc.code != "model_output_invalid":
                raise
            return  # unresolved labels simply become new nodes, flagged by the token rule
        for decision in decisions:
            if not 0 <= decision.index < len(slots):
                continue
            finding, role, candidates = slots[decision.index]
            if decision.verdict == "different" or decision.match is None:
                continue
            if not 0 <= decision.match < len(candidates):
                continue
            verdict = "same" if decision.verdict == "same" and mode == "merge" else "unsure"
            finding.resolved[role] = {
                "node_id": candidates[decision.match]["id"],
                "verdict": verdict,
                "rationale": decision.rationale,
            }

    def ingest_upload(self, workspace, identifier, budget):
        with self.db.transaction(workspace) as repo:
            run = self.owned(repo, identifier)
            upload = repo.get(run["upload_id"], "upload")
        for row in upload["_rows"]:
            budget.check()
            with self.db.transaction(workspace, write=True) as repo:
                run = self.owned(repo, identifier)
                graph = repo.graph(run["graph_id"])
                self.check_graph_budget(graph, run)
                node = make_node(row["kind"], row["label"], status="user_asserted")
                graph["nodes"].append(node)
                source = make_source(
                    repo,
                    f"urn:magellan:upload:{upload['id']}",
                    upload["filename"],
                    row["span"],
                    kind="upload",
                    source_family_id=upload["id"],
                    license_notes="User-asserted BOM row; hash covers the canonical row.",
                )
                edge, claim = add_claim_edge(
                    repo,
                    graph,
                    node["id"],
                    graph["root_node_id"],
                    "INPUT_TO" if row["kind"] == "material" else "PART_OF",
                    {"type": "product", "product_node_id": graph["root_node_id"]},
                    source,
                    row["span"],
                    locator=f"BOM row {row['line']}",
                    rationale="User-uploaded bill of materials",
                    data={
                        "operational": {"quantity": row["quantity"], "unit": row["unit"]},
                        "custom": {"operational_provenance": {"support_label": "user_asserted"}},
                    },
                )
                graph["revision"] += 1
                refresh(graph)
                repo.save_graph(graph)
                for kind, payload in [
                    ("source.retrieved", {"source_id": source["id"], **source}),
                    ("node.added", {"node": node}),
                    (
                        "claim.committed",
                        {"claim_id": claim["id"], "support_label": "user_asserted"},
                    ),
                    ("edge.added", {"edge": edge}),
                ]:
                    self.emit(repo, run, kind, payload)
                repo.put("run", run)

    def ingest_estimate(self, workspace, identifier, budget):
        """Seed the graph from an imported BOM estimate. Rows are user_asserted; citations stay unverified."""
        with self.db.transaction(workspace) as repo:
            run = self.owned(repo, identifier)
        estimate = run["_bom_estimate"]
        for item in estimate["items"]:
            budget.check()
            with self.db.transaction(workspace, write=True) as repo:
                run = self.owned(repo, identifier)
                graph = repo.graph(run["graph_id"])
                root = next(n for n in graph["nodes"] if n["id"] == graph["root_node_id"])
                if item["name"].casefold() == root["label"].casefold():
                    # The assembly row is the product itself; keep it as metadata, not a self-edge.
                    root["data"].setdefault("custom", {}).setdefault("bom_items", []).append(
                        self.estimate_provenance(estimate, item)
                    )
                    graph["revision"] += 1
                    refresh(graph)
                    repo.save_graph(graph)
                    self.emit(repo, run, "node.updated", {"node": root})
                    repo.put("run", run)
                    continue
                kind = "material" if item["category"] == "material" else "component"
                existing = next(
                    (
                        n
                        for n in graph["nodes"]
                        if n["kind"] == kind and n["label"].casefold() == item["name"].casefold()
                    ),
                    None,
                )
                if existing is None:
                    self.check_graph_budget(graph, run)
                else:
                    self.check_graph_budget(graph, run, new_node=False)
                node = existing or make_node(kind, item["name"], status="user_asserted")
                if existing is None:
                    graph["nodes"].append(node)
                provenance = self.estimate_provenance(estimate, item)
                node["data"].setdefault("custom", {}).setdefault("bom_items", []).append(provenance)
                span = json.dumps(
                    {
                        "component": item["name"],
                        "kind": kind,
                        "quantity": item["quantity"],
                        "unit": item["unit"],
                        "bom_item_id": item["id"],
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                source = make_source(
                    repo,
                    f"urn:magellan:bom-estimate:{estimate['id']}",
                    f"BOM estimate {estimate['id']}",
                    span,
                    kind="upload",
                    source_family_id=estimate["id"],
                    license_notes="Imported BOM estimate row; not independently verified.",
                )
                edge, claim = add_claim_edge(
                    repo,
                    graph,
                    node["id"],
                    graph["root_node_id"],
                    "INPUT_TO" if kind == "material" else "PART_OF",
                    {"type": "product", "product_node_id": graph["root_node_id"]},
                    source,
                    span,
                    locator=f"BOM estimate item {item['id']}",
                    rationale=f"Imported from BOM estimate {estimate['id']} (basis {item['basis']}, confidence {item['confidence']}); web citations are unverified provenance.",
                    data={
                        "operational": {"quantity": item["quantity"], "unit": item["unit"]},
                        "custom": {
                            "operational_provenance": {"support_label": "user_asserted"},
                            "bom_estimate": provenance,
                        },
                    },
                )
                graph["revision"] += 1
                refresh(graph)
                repo.save_graph(graph)
                events = [("source.retrieved", {"source_id": source["id"], **source})]
                if existing is None:
                    events.append(("node.added", {"node": node}))
                else:
                    events.append(("node.updated", {"node": node}))
                events.extend(
                    [
                        (
                            "claim.committed",
                            {"claim_id": claim["id"], "support_label": "user_asserted"},
                        ),
                        (
                            "edge.added" if len(edge["claim_ids"]) == 1 else "edge.updated",
                            {"edge": edge},
                        ),
                    ]
                )
                for kind_name, payload in events:
                    self.emit(repo, run, kind_name, payload)
                repo.put("run", run)

    @staticmethod
    def estimate_provenance(estimate, item):
        return {
            "estimate_id": estimate["id"],
            "item_id": item["id"],
            "parent_item_id": item["parent_item_id"],
            "category": item["category"],
            "part_number": item["part_number"],
            "manufacturer": item["manufacturer"],
            "material": item["material"],
            "notes": item["notes"],
            "basis": item["basis"],
            "confidence": item["confidence"],
            "sources": item["sources"],
            "provenance": "imported_not_independently_verified",
        }

    async def research_seeds(self, workspace, identifier, run, budget, questions, state=None):
        """Re-read pages the estimate cited, targeting the product; findings are verified afresh."""
        state = state or RunState()
        with self.db.transaction(workspace) as repo:
            graph = repo.graph(run["graph_id"])
        root = next(n for n in graph["nodes"] if n["id"] == graph["root_node_id"])
        for url in run["_seed_urls"]:
            budget.check()
            if not budget.remaining("documents"):
                questions.append(
                    "Document budget exhausted before every BOM estimate source was re-read."
                )
                break
            try:
                page = await self.provider.fetch_page(url, budget)
                document = await self.provider.analyze(
                    root, run["product"], run["company"], page.url, page.title, page.body, budget
                )
            except ProviderFailure as exc:
                questions.append(f"BOM estimate source could not be re-read: {url} ({exc.message})")
                continue
            state.spend["root"] = state.spend.get("root", 0) + 1
            state.analyzed.setdefault(digest(page.body.encode()), set()).add(
                (root["id"], "upstream_inputs")
            )
            self.commit_document(workspace, identifier, root, document, budget, state)
            await asyncio.sleep(0)

    @staticmethod
    def check_graph_budget(graph, run, new_node=True):
        if new_node and len(graph["nodes"]) >= run["limits"]["max_nodes"]:
            raise BudgetExceeded("max_nodes")
        if len(graph["_claims"]) >= run["limits"]["max_claims"]:
            raise BudgetExceeded("max_claims")

    def commit_document(self, workspace, identifier, target, document, budget, state=None):
        """Commit every verified relationship a document supports, in order-independent passes.

        Findings may connect any two entities: at least one endpoint must already be in the graph
        (the "disconnected" gate); the other is created within the hop limit. Each document is
        committed atomically, so budget exhaustion never leaves orphan claims.
        """
        added = []
        with self.db.transaction(workspace, write=True) as repo:
            run = self.owned(repo, identifier)
            graph = repo.graph(run["graph_id"])
            if not any(n["id"] == target["id"] for n in graph["nodes"]):
                return []
            content_hash = digest(document.body.encode())
            source = state.sources.get(content_hash) if state else None
            if source is None:
                source = make_source(
                    repo,
                    document.url,
                    document.title,
                    document.body,
                    document.kind,
                    document.publisher,
                    source_family_id=urlsplit(document.url).hostname or document.publisher,
                    license_notes="Curated cached excerpt; content hash covers excerpt only."
                    if document.cached
                    else "Retrieved public text; evidence excerpts only are exposed.",
                )
                if state is not None:
                    state.sources[content_hash] = source
                self.emit(
                    repo,
                    run,
                    "source.retrieved",
                    {
                        "source_id": source["id"],
                        **{k: source[k] for k in ("url", "title", "publisher", "published_at")},
                    },
                )
            root = next(n for n in graph["nodes"] if n["id"] == graph["root_node_id"])
            target_node = next(n for n in graph["nodes"] if n["id"] == target["id"])

            def reject(finding, reason):
                self.emit(
                    repo,
                    run,
                    "claim.rejected",
                    {"claim_id": new_id("clm"), "reason": reason, "detail": finding.rationale},
                )

            eligible = []
            for finding in document.findings:
                object_label = finding.object_label or target_node["label"]
                object_kind = finding.object_kind or target_node["kind"]
                rejected = finding.rejection
                if finding.span not in document.body:
                    rejected = "span_not_found"
                elif not valid_relation(finding.predicate, finding.kind, object_kind):
                    rejected = "predicate_invalid"
                elif normalize_label(finding.label) == normalize_label(object_label):
                    rejected = "predicate_invalid"
                elif finding.predicate in {"PART_OF", "INPUT_TO"} and (
                    software_artifact(finding.label) or software_artifact(object_label)
                ):
                    rejected = "predicate_invalid"  # firmware, drivers, software are not parts
                elif finding.predicate in {"PART_OF", "INPUT_TO"} and (
                    (
                        finding.kind == "component"
                        and interface_feature(
                            finding.label, finding.part_number, finding.manufacturer
                        )
                    )
                    or (object_kind == "component" and interface_feature(object_label))
                ):
                    rejected = "predicate_invalid"  # ports, slots, and standards are interfaces
                elif any(
                    kind == "product" and normalize_label(label) != normalize_label(root["label"])
                    for kind, label in ((finding.kind, finding.label), (object_kind, object_label))
                ):
                    rejected = "scope_mismatch"
                elif finding.scope_type == "product" and finding.predicate == "LOCATED_IN":
                    rejected = "scope_mismatch"
                elif finding.scope_type != "product" and "product" in (finding.kind, object_kind):
                    rejected = "scope_mismatch"
                elif finding.scope_type == "company" and "organization" not in (
                    finding.kind,
                    object_kind,
                ):
                    rejected = "scope_mismatch"
                if rejected:
                    reject(finding, rejected)
                    continue
                eligible.append((finding, object_label, object_kind))
            changed = False
            deferred_limit = None
            progress = True
            while eligible and progress and deferred_limit is None:
                progress = False
                for item in list(eligible):
                    finding, object_label, object_kind = item
                    subject, s_review = resolve_entity(
                        graph,
                        finding.kind,
                        finding.label,
                        finding.part_number,
                        finding.manufacturer,
                    )
                    if finding.object_label is None:
                        obj, o_review = target_node, None
                    else:
                        obj, o_review = resolve_entity(graph, object_kind, object_label)
                    hinted = []
                    for role, node in (("subject", subject), ("object", obj)):
                        hint = finding.resolved.get(role)
                        if node is not None or not hint or s_review or o_review:
                            continue
                        kind = finding.kind if role == "subject" else object_kind
                        match = next(
                            (
                                n
                                for n in graph["nodes"]
                                if n["id"] == hint["node_id"] and n["kind"] == kind
                            ),
                            None,
                        )
                        if match is None:
                            continue
                        if hint["verdict"] == "same":
                            if role == "subject":
                                subject = match
                            else:
                                obj = match
                            hinted.append((role, match, hint))
                        else:
                            self.emit(
                                repo,
                                run,
                                "entity.review_needed",
                                {
                                    "candidate_ids": [match["id"]],
                                    "reason": f"model_unsure: '{finding.label if role == 'subject' else object_label}' "
                                    f"may be '{match['label']}': {hint['rationale']}",
                                },
                            )
                    review = s_review or o_review
                    if review:
                        self.emit(
                            repo,
                            run,
                            "entity.review_needed",
                            {
                                "candidate_ids": [n["id"] for n in (subject, obj) if n],
                                "reason": f"{review}: {finding.label} {finding.predicate} {object_label}",
                            },
                        )
                        reject(finding, review)
                        eligible.remove(item)
                        progress = True
                        continue
                    if subject is None and obj is None:
                        continue  # Wait for a later pass once another finding places an endpoint.
                    anchor = subject or obj
                    missing_kind = (
                        object_kind if obj is None else finding.kind if subject is None else None
                    )
                    if missing_kind and missing_kind not in NON_DEPENDENCY_KINDS:
                        if anchor["tier"] is None or anchor["tier"] + 1 > run["limits"]["max_hops"]:
                            reject(finding, "max_hops")
                            eligible.remove(item)
                            progress = True
                            continue
                    scope = {"type": finding.scope_type}
                    if finding.scope_type == "product":
                        scope["product_node_id"] = graph["root_node_id"]
                    elif finding.scope_type == "company":
                        organization = next(
                            (n for n in (subject, obj) if n and n["kind"] == "organization"), None
                        )
                        if organization is None:
                            reject(finding, "scope_mismatch")
                            eligible.remove(item)
                            progress = True
                            continue
                        scope["organization_node_id"] = organization["id"]
                    if (
                        subject
                        and obj
                        and any(
                            c["subject_id"] == subject["id"]
                            and c["object_id"] == obj["id"]
                            and c["predicate"] == finding.predicate
                            and c["scope"]["type"] == finding.scope_type
                            and any(
                                e["span"] == finding.span
                                and e.get("source", {}).get("url") == document.url
                                for e in c["evidence"]
                            )
                            for c in graph["_claims"].values()
                        )
                    ):
                        eligible.remove(item)
                        progress = True
                        continue
                    try:
                        self.check_graph_budget(graph, run, new_node=missing_kind is not None)
                    except BudgetExceeded as exc:
                        deferred_limit = exc
                        break
                    previous_nodes = {n["id"]: deepcopy(n) for n in graph["nodes"]}
                    previous_edges = {e["id"] for e in graph["edges"]}
                    for created_kind, created_label in (
                        (finding.kind, finding.label) if subject is None else (None, None),
                        (object_kind, object_label) if obj is None else (None, None),
                    ):
                        # Name variants that resolution refused to merge are flagged for review.
                        similar = near_duplicates(graph, created_kind, created_label)
                        if created_label is not None and similar:
                            self.emit(
                                repo,
                                run,
                                "entity.review_needed",
                                {
                                    "candidate_ids": [n["id"] for n in similar],
                                    "reason": f"near_duplicate: new {created_kind} '{created_label}' "
                                    "resembles "
                                    + ", ".join(f"'{n['label']}'" for n in similar[:3]),
                                },
                            )
                    if subject is None:
                        subject = make_node(
                            finding.kind, finding.label, status=finding.support_label
                        )
                        graph["nodes"].append(subject)
                        added.append(subject)
                    if obj is None:
                        obj = make_node(object_kind, object_label, status=finding.support_label)
                        graph["nodes"].append(obj)
                        added.append(obj)
                    if state is not None:
                        # Entities found from the product root start their own tier-1 branch;
                        # deeper discoveries inherit the branch of the task that found them.
                        parent_branch = (
                            None
                            if target_node["id"] == graph["root_node_id"]
                            else state.branch(target_node, graph)
                        )
                        for node in added:
                            state.branch_of.setdefault(node["id"], parent_branch or node["id"])
                    record_identity(
                        subject, finding.label, finding.part_number, finding.manufacturer
                    )
                    if finding.object_label:
                        record_identity(obj, finding.object_label)
                    for role, match, hint in hinted:
                        self.emit(
                            repo,
                            run,
                            "entity.merged",
                            {
                                "node_id": match["id"],
                                "alias": finding.label if role == "subject" else object_label,
                                "resolver": "model",
                                "rationale": hint["rationale"],
                            },
                        )
                    edge, claim = add_claim_edge(
                        repo,
                        graph,
                        subject["id"],
                        obj["id"],
                        finding.predicate,
                        scope,
                        source,
                        finding.span,
                        finding.support_label,
                        finding.rationale,
                        f"{document.locator}; chars {document.body.find(finding.span)}:{document.body.find(finding.span) + len(finding.span)}",
                        {"operational": {"quantity": finding.quantity, "unit": finding.unit}},
                    )
                    # Save before events so the event revision is the committed snapshot revision.
                    graph["revision"] += 1
                    refresh(graph)
                    repo.save_graph(graph)
                    for node in graph["nodes"]:
                        if node["id"] not in previous_nodes:
                            self.emit(repo, run, "node.added", {"node": node})
                        elif node != previous_nodes[node["id"]]:
                            self.emit(repo, run, "node.updated", {"node": node})
                    self.emit(
                        repo,
                        run,
                        "claim.committed",
                        {"claim_id": claim["id"], "support_label": finding.support_label},
                    )
                    self.emit(
                        repo,
                        run,
                        "edge.updated" if edge["id"] in previous_edges else "edge.added",
                        {"edge": edge},
                    )
                    changed = True
                    progress = True
                    eligible.remove(item)
            for finding, _, _ in eligible:
                reject(finding, "disconnected")
            run["usage"] = deepcopy(budget.usage)
            self.emit(repo, run, "budget.updated", run["usage"])
            repo.put("run", run)
        if deferred_limit:
            raise deferred_limit
        return added if changed else []

    async def replay(self, workspace, identifier, cached_run):
        snapshot = cached_run["_replay_snapshot"]
        with self.db.transaction(workspace, write=True) as repo:
            run = self.owned(repo, identifier)
            graph = repo.graph(run["graph_id"])
            graph.update(
                nodes=deepcopy(snapshot["nodes"]),
                edges=deepcopy(snapshot["edges"]),
                _claims=deepcopy(snapshot["_claims"]),
            )
            graph["revision"] += 1
            refresh(graph)
            repo.save_graph(graph)
            for node in graph["nodes"]:
                self.emit(
                    repo,
                    run,
                    "node.updated" if node["id"] == graph["root_node_id"] else "node.added",
                    {"node": node},
                )
            for edge in graph["edges"]:
                self.emit(repo, run, "edge.added", {"edge": edge})
            run.update(
                status=cached_run["_replay_status"],
                stop_reason="replay_completed",
                completed_at=now(),
                open_questions=cached_run["_replay_questions"],
                progress={"tasks_done": 1, "tasks_total": 1},
            )
            self.emit(
                repo,
                run,
                "run.completed",
                {
                    "status": run["status"],
                    "stop_reason": run["stop_reason"],
                    "coverage_summary": graph["stats"],
                    "open_questions": run["open_questions"],
                },
            )
            repo.put("run", run)

    async def process_enrichment(self, workspace, identifier):
        # Location research runs outside transactions, then merges into the latest graph.
        with self.db.transaction(workspace) as repo:
            pending = self.owned(repo, identifier, "enrichment")
            initial = repo.graph(pending["graph_id"])
        locations, location_errors = {}, {}
        if "geography" in pending["kinds"] and hasattr(self.provider, "locate"):

            def checkpoint():
                with self.db.transaction(workspace, write=True) as repo:
                    current = self.owned(repo, identifier, "enrichment")
                    repo.put("enrichment", current)

            budget = Budget(
                RunLimits(
                    max_seconds=180,
                    max_searches=30,
                    max_documents=50,
                    max_input_tokens=200000,
                    max_output_tokens=20000,
                ).model_dump(),
                {},
                checkpoint,
            )
            try:
                async with asyncio.timeout(180):
                    for node in initial["nodes"]:
                        if (
                            node["id"] not in pending["_node_ids"]
                            or node["kind"] != "facility"
                            or self.geography.evidenced_location(initial, node)
                        ):
                            continue
                        try:
                            locations[node["id"]] = await self.provider.locate(node, budget)
                        except ProviderFailure as exc:
                            location_errors[node["id"]] = exc.message
            except (BudgetExceeded, TimeoutError):
                for nid in pending["_node_ids"]:
                    if nid not in locations:
                        location_errors[nid] = "Geography research budget exhausted"
        with self.db.transaction(workspace, write=True) as repo:
            job = self.owned(repo, identifier, "enrichment")
            graph = repo.graph(job["graph_id"])
            changed = []
            for nid in job["_node_ids"]:
                node = next((n for n in graph["nodes"] if n["id"] == nid), None)
                for kind in job["kinds"]:
                    outcome, reason = "unresolved", None
                    if node is None:
                        reason = "Node was removed before enrichment started"
                    elif kind == "concentration":
                        if node["kind"] != "material":
                            outcome, reason = "skipped", "Concentration applies to materials"
                        else:
                            try:
                                result = self.geography.production(repo, node)
                                layer = {
                                    k: v
                                    for k, v in result.items()
                                    if k not in {"material_node_id", "unit"}
                                }
                                if node["data"].get("concentration") != layer:
                                    node["data"]["concentration"] = layer
                                    changed.append(node)
                                outcome = "filled"
                            except APIError as exc:
                                reason = exc.message
                    elif kind == "geography":
                        document = locations.get(nid)
                        old_node = next((n for n in initial["nodes"] if n["id"] == nid), None)
                        if document and old_node and old_node["label"] == node["label"]:
                            layer = deepcopy(document.geography)
                            country = next(
                                (
                                    n
                                    for n in graph["nodes"]
                                    if n["kind"] == "geography"
                                    and n["external_ids"].get("iso2") == layer["country_iso2"]
                                ),
                                None,
                            )
                            if country is None:
                                country = make_node(
                                    "geography",
                                    layer["country_iso2"],
                                    external_ids={"iso2": layer["country_iso2"]},
                                    status="directly_supported",
                                )
                                graph["nodes"].append(country)
                                changed.append(country)
                            source = make_source(
                                repo,
                                document.url,
                                document.title,
                                document.body,
                                publisher=document.publisher,
                                source_family_id=urlsplit(document.url).hostname,
                            )
                            finding = document.findings[0]
                            _, claim = add_claim_edge(
                                repo,
                                graph,
                                nid,
                                country["id"],
                                "LOCATED_IN",
                                {"type": "generic"},
                                source,
                                finding.span,
                                "directly_supported",
                                finding.rationale,
                                f"chars {document.body.find(finding.span)}:{document.body.find(finding.span) + len(finding.span)}",
                            )
                            layer["claim_ids"] = [claim["id"]]
                            node["data"]["geography"] = layer
                            changed.append(node)
                        location = self.geography.evidenced_location(graph, node)
                        if location:
                            outcome = "filled"
                        else:
                            reason = location_errors.get(
                                nid,
                                "No accepted location claim with a stored source span; location remains unknown",
                            )
                    else:
                        # Explicit fixture mappings only; never invent tickers from company names.
                        symbols = {
                            "tin": ("inst_fixture_lme_sn", "commodity_price"),
                            "copper": ("inst_fixture_lme_cu", "commodity_price"),
                        }
                        mapping = (
                            symbols.get(node["label"].casefold())
                            if node["kind"] == "material"
                            else None
                        )
                        if mapping:
                            method = {
                                "name": "fixture_commodity_instrument_mapping",
                                "version": "1",
                                "params": {"provider": "fixture"},
                                "assumptions": [
                                    "Illustrative mapping; no prices or live instrument coverage are supplied."
                                ],
                            }
                            layer = {
                                "instruments": [
                                    {
                                        "instrument_id": mapping[0],
                                        "role": mapping[1],
                                        "mapping_confidence": "plausible",
                                        "rationale": "Explicit fixture mapping for the canonical commodity",
                                        "method": method,
                                    }
                                ],
                                "exposure_weight": None,
                                "method": method,
                                "data_quality": {
                                    "coverage_pct": 100,
                                    "notes": ["Fixture mapping only; exposure weight is unknown."],
                                    "as_of": job["created_at"],
                                },
                            }
                            if node["data"].get("market") != layer:
                                node["data"]["market"] = layer
                                changed.append(node)
                            outcome = "filled"
                        else:
                            reason = "No configured instrument mapping for this node"
                    job["results"].append(
                        {"node_id": nid, "kind": kind, "outcome": outcome, "reason": reason}
                    )
                job["progress"]["nodes_done"] += 1
            if changed:
                graph["revision"] += 1
                refresh(graph)
                repo.save_graph(graph)
                for node in {n["id"]: n for n in changed}.values():
                    self.emit(
                        repo, job, "node.updated", {"node": node, "revision": graph["revision"]}
                    )
            job.update(
                status="partial"
                if any(r["outcome"] == "unresolved" for r in job["results"])
                else "completed",
                revision_after=graph["revision"],
            )
            self.emit(repo, job, "job.completed", {"resource": public(job)})
            repo.put("enrichment", job)

    async def serve(self, stop=None):
        stop = stop or asyncio.Event()

        async def slot():
            while not stop.is_set():
                if not await self.tick():
                    try:
                        await asyncio.wait_for(stop.wait(), self.settings.worker_poll_seconds)
                    except TimeoutError:
                        pass
                else:
                    await asyncio.sleep(0)

        async with asyncio.TaskGroup() as group:
            for _ in range(self.settings.worker_slots):
                group.create_task(slot())


async def main():
    settings = Settings()
    db = Database(settings.database_url)
    if settings.auto_create_schema:
        db.create_schema()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await Worker(db, settings).serve(stop)
    finally:
        db.engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
