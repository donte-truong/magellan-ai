"""Durable asyncio worker. Run one process with bounded research slots."""

import asyncio
import json
import logging
import math
import signal
import time
from collections import deque
from copy import deepcopy
from urllib.parse import urlsplit

from app.config import Settings
from app.db import Database, new_id, now, public
from app.errors import APIError
from app.geography import GeographyService
from app.graphs import (
    DEPENDENCY_PREDICATES,
    add_claim_edge,
    make_node,
    make_source,
    refresh,
)
from app.providers import Budget, BudgetExceeded, ProviderFailure, build_provider
from app.schemas import RunLimits

logger = logging.getLogger(__name__)


class RunStopped(Exception):
    pass


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

        def checkpoint():
            with self.db.transaction(workspace, write=True) as repo:
                current = self.owned(repo, identifier)
                current["usage"] = deepcopy(usage)
                repo.put("run", current)

        budget = Budget(run["limits"], usage, checkpoint)
        reason, questions = "research_exhausted", []
        try:
            async with asyncio.timeout(run["limits"]["max_seconds"]):
                if run["upload_id"]:
                    self.ingest_upload(workspace, identifier, budget)
                if run.get("_bom_estimate"):
                    self.ingest_estimate(workspace, identifier, budget)
                if run.get("_seed_urls") and hasattr(self.provider, "fetch_page"):
                    await self.research_seeds(workspace, identifier, run, budget, questions)
                with self.db.transaction(workspace) as repo:
                    graph = repo.graph(run["graph_id"])
                    queue = deque(n for n in graph["nodes"] if n["tier"] is not None)
                visited = set()
                while queue:
                    target = queue.popleft()
                    if target["id"] in visited or target["tier"] >= run["limits"]["max_hops"]:
                        continue
                    visited.add(target["id"])
                    budget.check()
                    task = {
                        "task_id": new_id("task"),
                        "target_node_id": target["id"],
                        "relation_sought": "upstream_dependencies",
                        "depth": target["tier"],
                    }
                    with self.db.transaction(workspace, write=True) as repo:
                        current = self.owned(repo, identifier)
                        self.emit(repo, current, "task.started", task)
                        repo.put("run", current)
                    found = 0
                    async for document in self.provider.research(
                        target, run["product"], run["company"], budget
                    ):
                        budget.check()
                        added = self.commit_document(
                            workspace, identifier, target, document, budget
                        )
                        found += len(added)
                        queue.extend(added)
                        await asyncio.sleep(0)
                    if not found:
                        questions.append(
                            f"No further verified upstream inputs for {target['label']}."
                        )
                    with self.db.transaction(workspace, write=True) as repo:
                        current = self.owned(repo, identifier)
                        current["progress"] = {
                            "tasks_done": len(visited),
                            "tasks_total": len(visited) + len(queue),
                        }
                        self.emit(
                            repo,
                            current,
                            "task.finished",
                            {**task, "outcome": "findings_committed" if found else "unresolved"},
                        )
                        repo.put("run", current)
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

    async def research_seeds(self, workspace, identifier, run, budget, questions):
        """Re-read pages the estimate cited, targeting the product; findings are verified afresh."""
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
            self.commit_document(workspace, identifier, root, document, budget)
            await asyncio.sleep(0)

    @staticmethod
    def check_graph_budget(graph, run, new_node=True):
        if new_node and len(graph["nodes"]) >= run["limits"]["max_nodes"]:
            raise BudgetExceeded("max_nodes")
        if len(graph["_claims"]) >= run["limits"]["max_claims"]:
            raise BudgetExceeded("max_claims")

    def commit_document(self, workspace, identifier, target, document, budget):
        added = []
        # Each document is committed atomically. Budget exhaustion never leaves orphan claims.
        with self.db.transaction(workspace, write=True) as repo:
            run = self.owned(repo, identifier)
            graph = repo.graph(run["graph_id"])
            if not any(n["id"] == target["id"] for n in graph["nodes"]):
                return []
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
            self.emit(
                repo,
                run,
                "source.retrieved",
                {
                    "source_id": source["id"],
                    **{k: source[k] for k in ("url", "title", "publisher", "published_at")},
                },
            )
            changed = False
            deferred_limit = None
            for finding in document.findings:
                rejected = finding.rejection
                if finding.span not in document.body:
                    rejected = "span_not_found"
                if finding.predicate not in DEPENDENCY_PREDICATES or finding.kind not in {
                    "component",
                    "material",
                    "organization",
                    "facility",
                }:
                    rejected = "predicate_invalid"
                if finding.scope_type == "company":
                    rejected = (
                        "scope_mismatch"  # No resolved organization scope anchor in this task.
                    )
                if finding.label.casefold() == target["label"].casefold():
                    rejected = "duplicate"
                if rejected:
                    self.emit(
                        repo,
                        run,
                        "claim.rejected",
                        {
                            "claim_id": new_id("clm"),
                            "reason": rejected,
                            "detail": finding.rationale,
                        },
                    )
                    continue
                existing = next(
                    (
                        n
                        for n in graph["nodes"]
                        if n["kind"] == finding.kind
                        and n["label"].casefold() == finding.label.casefold()
                    ),
                    None,
                )
                if existing and any(
                    c["subject_id"] == existing["id"]
                    and c["object_id"] == target["id"]
                    and c["predicate"] == finding.predicate
                    and c["scope"]["type"] == finding.scope_type
                    and any(
                        e["span"] == finding.span and e.get("source", {}).get("url") == document.url
                        for e in c["evidence"]
                    )
                    for c in graph["_claims"].values()
                ):
                    continue
                try:
                    self.check_graph_budget(graph, run, new_node=existing is None)
                except BudgetExceeded as exc:
                    deferred_limit = exc
                    break
                node = existing or make_node(
                    finding.kind, finding.label, status=finding.support_label
                )
                if not existing:
                    graph["nodes"].append(node)
                    added.append(node)
                scope = {"type": finding.scope_type}
                if finding.scope_type == "product":
                    scope["product_node_id"] = graph["root_node_id"]
                previous_nodes = {
                    n["id"]: deepcopy(n) for n in graph["nodes"] if n is not node or existing
                }
                previous_edges = {e["id"] for e in graph["edges"]}
                edge, claim = add_claim_edge(
                    repo,
                    graph,
                    node["id"],
                    target["id"],
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
                if not existing:
                    self.emit(repo, run, "node.added", {"node": node})
                for updated in graph["nodes"]:
                    if updated["id"] in previous_nodes and updated != previous_nodes[updated["id"]]:
                        self.emit(repo, run, "node.updated", {"node": updated})
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
