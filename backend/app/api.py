import asyncio
import json
import secrets
import time
from copy import deepcopy
from typing import Annotated

from fastapi import APIRouter, Depends, File, Header, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool

from app import agent, estimate, graphs, jobs, schemas
from app.db import new_id, now, public
from app.errors import APIError, invalid, not_found
from app.uploads import MAX_UPLOAD_BYTES, parse_upload

bearer = HTTPBearer(auto_error=False)


def workspace(
    request: Request, credential: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]
):
    if credential and credential.scheme.casefold() == "bearer":
        for token, name in request.app.state.settings.workspace_tokens.items():
            if secrets.compare_digest(credential.credentials.encode(), token.encode()):
                return name
    raise APIError(
        401,
        "invalid_input",
        "A valid Bearer token is required",
        headers={"WWW-Authenticate": "Bearer"},
    )


Workspace = Annotated[str, Depends(workspace)]
IdempotencyKey = Annotated[
    str | None, Header(alias="Idempotency-Key", min_length=1, max_length=128)
]
Revision = Annotated[int | None, Query(ge=0)]
Limit = Annotated[int, Query(ge=1, le=200)]
Cursor = Annotated[str | None, Query(max_length=2000)]
router = APIRouter(prefix="/v1")


def create(request, workspace, key, body, status, response, action):
    with request.app.state.db.transaction(workspace, write=True) as repo:
        result, replayed = repo.idempotent(key, request.url.path, body, lambda: action(repo))
    response.status_code = 200 if replayed else status
    return result


@router.post(
    "/uploads",
    response_model=schemas.Upload,
    status_code=201,
    tags=["uploads"],
    operation_id="createUpload",
)
async def upload(
    request: Request,
    response: Response,
    ws: Workspace,
    file: Annotated[UploadFile, File()],
    idempotency_key: IdempotencyKey = None,
):
    try:
        content = await file.read(MAX_UPLOAD_BYTES + 1)
        result = parse_upload(file.filename, content)
    finally:
        await file.close()

    def save(repo):
        repo.put("upload", result)
        return result

    return await run_in_threadpool(
        create,
        request,
        ws,
        idempotency_key,
        {"filename": result["filename"], "content_hash": result["content_hash"]},
        201,
        response,
        save,
    )


@router.get(
    "/uploads/{upload_id}",
    response_model=schemas.Upload,
    tags=["uploads"],
    operation_id="getUpload",
)
def get_upload(request: Request, ws: Workspace, upload_id: str):
    with request.app.state.db.transaction(ws) as repo:
        return public(repo.get(upload_id, "upload"))


@router.post(
    "/runs",
    response_model=schemas.Run,
    response_model_exclude_unset=True,
    status_code=202,
    tags=["runs"],
    operation_id="createRun",
)
def create_run(
    request: Request,
    response: Response,
    ws: Workspace,
    body: schemas.RunCreate,
    idempotency_key: IdempotencyKey = None,
):
    return create(
        request,
        ws,
        idempotency_key,
        body.model_dump(),
        202,
        response,
        lambda repo: jobs.create_run(repo, body, request.app.state.provider),
    )


@router.post(
    "/bom/decompose",
    response_model=schemas.Run,
    response_model_exclude_unset=True,
    status_code=202,
    tags=["bom"],
    operation_id="decomposeBillOfMaterials",
    summary="Deconstruct a product's bill of materials from public evidence",
    description="Starts a bounded research job. Poll bom_url for BOM rows, quantities, evidence and unresolved questions, or subscribe to events_url.",
)
def decompose(
    request: Request,
    response: Response,
    ws: Workspace,
    body: schemas.RunCreate,
    idempotency_key: IdempotencyKey = None,
):
    return create_run(request, response, ws, body, idempotency_key)


@router.post(
    "/bom",
    response_model=schemas.BomEstimate,
    tags=["bom"],
    operation_id="estimateBillOfMaterials",
    summary="Estimate a bill of materials from a description, link, and/or photo",
    description=(
        "Synchronous (one to three minutes). Accepts JSON with an optional base64 `image`, or "
        "multipart/form-data with an `image` file. Every item records where the agent got it "
        "(`sources`) and a code-assigned `basis`: evidenced, inferred, or guessed. The result is "
        "persisted and readable at GET /v1/bom/{bom_id}; pass it as `bom_estimate` to POST /v1/runs "
        "to seed graph research."
    ),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": {"$ref": "#/components/schemas/BomEstimateRequest"}},
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "description": {"type": "string"},
                            "url": {"type": "string"},
                            "image_url": {"type": "string"},
                            "company": {"type": "string"},
                            "limits": {"type": "string", "description": "JSON object"},
                            "image": {"type": "string", "format": "binary"},
                        },
                    }
                },
            },
        }
    },
)
async def estimate_bom(request: Request, ws: Workspace):
    payload = await estimate.read_request(request)
    state = request.app.state
    if state.estimate_active >= 3:
        raise APIError(
            429,
            "rate_limited",
            "At most three BOM estimates may be active",
            headers={"Retry-After": "5"},
        )
    state.estimate_active += 1
    try:
        return await estimate.generate(state.db, state.settings, state.provider, ws, payload)
    finally:
        state.estimate_active -= 1


@router.get(
    "/bom/{bom_id}",
    response_model=schemas.BomEstimate,
    tags=["bom"],
    operation_id="getBillOfMaterialsEstimate",
)
def get_estimate(request: Request, ws: Workspace, bom_id: str):
    with request.app.state.db.transaction(ws) as repo:
        return public(repo.get(bom_id, "bom"))


@router.get(
    "/runs",
    response_model=schemas.Page[schemas.Run],
    response_model_exclude_unset=True,
    tags=["runs"],
    operation_id="listRuns",
)
def list_runs(
    request: Request,
    ws: Workspace,
    cursor: Cursor = None,
    limit: Limit = 50,
    status: schemas.RunStatus | None = None,
):
    with request.app.state.db.transaction(ws) as repo:
        return repo.page("run", cursor, limit, status=status)


@router.get(
    "/runs/{run_id}",
    response_model=schemas.Run,
    response_model_exclude_unset=True,
    tags=["runs"],
    operation_id="getRun",
)
def get_run(request: Request, ws: Workspace, run_id: str):
    with request.app.state.db.transaction(ws) as repo:
        return public(repo.get(run_id, "run"))


@router.post(
    "/runs/{run_id}/answers",
    response_model=schemas.Run,
    response_model_exclude_unset=True,
    tags=["runs"],
    operation_id="answerRunQuestion",
)
def answer_run(request: Request, ws: Workspace, run_id: str, body: schemas.RunAnswer):
    with request.app.state.db.transaction(ws, write=True) as repo:
        return jobs.answer_run(repo, run_id, body)


@router.post(
    "/runs/{run_id}/cancel",
    response_model=schemas.Run,
    response_model_exclude_unset=True,
    tags=["runs"],
    operation_id="cancelRun",
)
def cancel_run(request: Request, ws: Workspace, run_id: str):
    with request.app.state.db.transaction(ws, write=True) as repo:
        return jobs.cancel_run(repo, run_id)


@router.get(
    "/runs/{run_id}/history",
    tags=["runs"],
    operation_id="getRunHistory",
    summary="Private model-call history for a run",
    description="Bounded trace of model calls with verbatim output before validation and classified failures. Debugging only; never shown to end users wholesale.",
)
def run_history(request: Request, ws: Workspace, run_id: str):
    with request.app.state.db.transaction(ws) as repo:
        repo.get(run_id, "run")
        try:
            trace = repo.get(f"{run_id}:trace", "trace")
        except APIError:
            trace = {"run_id": run_id, "entries": []}
        return {"run_id": run_id, "entries": trace["entries"]}


@router.get(
    "/runs/{run_id}/bom",
    response_model=schemas.BOM,
    tags=["bom"],
    operation_id="getBillOfMaterials",
)
def get_bom(request: Request, ws: Workspace, run_id: str, revision: Revision = None):
    with request.app.state.db.transaction(ws) as repo:
        run = repo.get(run_id, "run")
        return jobs.bom_view(run, repo.graph(run["graph_id"], revision))


def stream(request, ws, identifier, kind, last_event_id, graph_id=None):
    try:
        after = int(last_event_id) if last_event_id is not None else 0
        if after < 0:
            raise ValueError
    except ValueError as exc:
        raise invalid("Last-Event-ID must be a nonnegative integer") from exc

    def read(after):
        with request.app.state.db.transaction(ws) as repo:
            job = repo.get(identifier, kind)
            if graph_id and job["graph_id"] != graph_id:
                raise not_found()
            return job, repo.event_page(identifier, after)

    read(after)  # Authenticate before sending stream headers.

    async def generate():
        nonlocal after
        heartbeat = time.monotonic()
        while not await request.is_disconnected():
            job, events = await run_in_threadpool(read, after)
            gap = (events and events[0]["seq"] > after + 1) or after > job.get("_seq", 0)
            if gap:
                event_id = events[0]["seq"] - 1 if events else job.get("_seq", 0)
                envelope = {
                    "type": "snapshot.required",
                    "seq": event_id,
                    "at": now(),
                    "payload": {},
                    "graph_id": job["graph_id"],
                }
                if kind == "run":
                    with request.app.state.db.transaction(ws) as repo:
                        revision = repo.graph(job["graph_id"])["revision"]
                    envelope.update(run_id=identifier, revision=revision, mode=job["mode"])
                after = event_id
                yield f"id: {event_id}\nevent: snapshot.required\ndata: {json.dumps(envelope)}\n\n"
            for event in events:
                after = event["seq"]
                yield f"id: {after}\nevent: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            terminal = jobs.TERMINAL_RUN if kind == "run" else jobs.TERMINAL_JOB
            if job["status"] in terminal and after >= job.get("_seq", 0):
                break
            if time.monotonic() - heartbeat >= 15:
                yield ": ping\n\n"
                heartbeat = time.monotonic()
            await asyncio.sleep(0.2)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get(
    "/runs/{run_id}/events",
    tags=["runs"],
    operation_id="streamRunEvents",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
def run_events(
    request: Request,
    ws: Workspace,
    run_id: str,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
):
    return stream(request, ws, run_id, "run", last_event_id)


@router.get(
    "/graphs",
    response_model=schemas.Page[schemas.GraphMeta],
    tags=["graphs"],
    operation_id="listGraphs",
)
def list_graphs(request: Request, ws: Workspace, cursor: Cursor = None, limit: Limit = 50):
    with request.app.state.db.transaction(ws) as repo:
        page = repo.page("graph", cursor, limit)
        page["items"] = [graphs.meta(g) for g in page["items"]]
        return page


@router.get(
    "/graphs/{graph_id}",
    response_model=schemas.Graph,
    response_model_exclude_unset=True,
    tags=["graphs"],
    operation_id="getGraph",
)
def get_graph(
    request: Request,
    response: Response,
    ws: Workspace,
    graph_id: str,
    revision: Revision = None,
    include: str | None = None,
    tier_max: Annotated[int | None, Query(ge=0)] = None,
):
    with request.app.state.db.transaction(ws) as repo:
        graph = repo.graph(graph_id, revision)
        response.headers["ETag"] = f'"{graph["revision"]}"'
        return graphs.graph_view(graph, include, tier_max)


@router.get(
    "/graphs/{graph_id}/nodes/{node_id}",
    response_model=schemas.NodeDetail,
    tags=["graphs"],
    operation_id="getNode",
)
def get_node(
    request: Request, ws: Workspace, graph_id: str, node_id: str, revision: Revision = None
):
    with request.app.state.db.transaction(ws) as repo:
        return graphs.detail_node(repo.graph(graph_id, revision), node_id)


@router.get(
    "/graphs/{graph_id}/edges/{edge_id}",
    response_model=schemas.EdgeDetail,
    tags=["graphs"],
    operation_id="getEdge",
)
def get_edge(
    request: Request, ws: Workspace, graph_id: str, edge_id: str, revision: Revision = None
):
    with request.app.state.db.transaction(ws) as repo:
        return graphs.detail_edge(repo.graph(graph_id, revision), edge_id)


@router.post(
    "/graphs/{graph_id}/fork",
    response_model=schemas.GraphMeta,
    status_code=201,
    tags=["graphs"],
    operation_id="forkGraph",
)
def fork_graph(
    request: Request,
    response: Response,
    ws: Workspace,
    graph_id: str,
    body: schemas.ForkCreate | None = None,
    idempotency_key: IdempotencyKey = None,
):
    body = body or schemas.ForkCreate()

    def fork(repo):
        graph = deepcopy(repo.graph(graph_id, body.revision))
        graph.update(
            id=new_id("gph"),
            name=body.name or graph["name"],
            parent_graph_id=graph_id,
            revision=0,
            run_id=None,
            created_at=now(),
            updated_at=now(),
        )
        repo.save_graph(graph)
        return graphs.meta(graph)

    return create(request, ws, idempotency_key, body.model_dump(), 201, response, fork)


@router.post(
    "/graphs/{graph_id}/mutations",
    response_model=schemas.MutationResult,
    tags=["graphs"],
    operation_id="applyMutations",
)
def mutate_graph(
    request: Request,
    response: Response,
    ws: Workspace,
    graph_id: str,
    body: schemas.MutationBatch,
    if_match: Annotated[str, Header(alias="If-Match")],
    idempotency_key: IdempotencyKey = None,
):
    value = if_match.strip()
    if value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
    if not value.isascii() or not value.isdecimal():
        raise invalid("If-Match must contain the integer graph revision")
    revision = int(value)
    return create(
        request,
        ws,
        idempotency_key,
        {"body": body.model_dump(), "revision": revision},
        200,
        response,
        lambda repo: graphs.apply_mutations(repo, repo.graph(graph_id), body, revision),
    )


@router.get(
    "/graphs/{graph_id}/mutations",
    response_model=schemas.Page[schemas.MutationRecord],
    response_model_exclude_unset=True,
    tags=["graphs"],
    operation_id="listMutations",
)
def list_mutations(
    request: Request, ws: Workspace, graph_id: str, cursor: Cursor = None, limit: Limit = 50
):
    with request.app.state.db.transaction(ws) as repo:
        repo.get(graph_id, "graph")
        return repo.page("mutation", cursor, limit, graph_id)


@router.get(
    "/graphs/{graph_id}/export",
    response_model=schemas.GraphExport,
    tags=["graphs"],
    operation_id="exportGraph",
)
def export_graph(
    request: Request, response: Response, ws: Workspace, graph_id: str, revision: Revision = None
):
    with request.app.state.db.transaction(ws) as repo:
        graph = repo.graph(graph_id, revision)
        response.headers["Content-Disposition"] = (
            f'attachment; filename="{graph["id"]}-r{graph["revision"]}.json"'
        )
        return graphs.export_graph(repo, graph)


@router.get(
    "/graphs/{graph_id}/diff",
    response_model=schemas.GraphDiff,
    tags=["graphs"],
    operation_id="diffGraph",
)
def diff_graph(
    request: Request,
    ws: Workspace,
    graph_id: str,
    from_revision: Annotated[int, Query(alias="from", ge=0)],
    to: Annotated[int, Query(ge=0)],
):
    with request.app.state.db.transaction(ws) as repo:
        return graphs.diff(repo.graph(graph_id, from_revision), repo.graph(graph_id, to))


@router.get(
    "/claims/{claim_id}", response_model=schemas.Claim, tags=["claims"], operation_id="getClaim"
)
def get_claim(request: Request, ws: Workspace, claim_id: str):
    with request.app.state.db.transaction(ws) as repo:
        return public(repo.get(claim_id, "claim"))


@router.get(
    "/sources/{source_id}", response_model=schemas.Source, tags=["claims"], operation_id="getSource"
)
def get_source(request: Request, ws: Workspace, source_id: str):
    with request.app.state.db.transaction(ws) as repo:
        return public(repo.get(source_id, "source"))


@router.post(
    "/claims/{claim_id}/review",
    response_model=schemas.Claim,
    tags=["claims"],
    operation_id="reviewClaim",
)
def review_claim(request: Request, ws: Workspace, claim_id: str, body: schemas.ClaimReview):
    with request.app.state.db.transaction(ws, write=True) as repo:
        return graphs.review_claim(repo, claim_id, body)


@router.post(
    "/graphs/{graph_id}/enrichments",
    response_model=schemas.Enrichment,
    status_code=202,
    tags=["enrichments"],
    operation_id="createEnrichment",
)
def create_enrichment(
    request: Request,
    response: Response,
    ws: Workspace,
    graph_id: str,
    body: schemas.EnrichmentCreate,
    idempotency_key: IdempotencyKey = None,
):
    return create(
        request,
        ws,
        idempotency_key,
        body.model_dump(),
        202,
        response,
        lambda repo: jobs.create_enrichment(repo, graph_id, body),
    )


@router.get(
    "/graphs/{graph_id}/enrichments/{enrichment_id}",
    response_model=schemas.Enrichment,
    tags=["enrichments"],
    operation_id="getEnrichment",
)
def get_enrichment(request: Request, ws: Workspace, graph_id: str, enrichment_id: str):
    with request.app.state.db.transaction(ws) as repo:
        repo.get(graph_id, "graph")
        job = repo.get(enrichment_id, "enrichment")
        if job["graph_id"] != graph_id:
            raise not_found()
        return public(job)


@router.get(
    "/graphs/{graph_id}/enrichments/{enrichment_id}/events",
    tags=["enrichments"],
    operation_id="streamEnrichmentEvents",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
def enrichment_events(
    request: Request,
    ws: Workspace,
    graph_id: str,
    enrichment_id: str,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
):
    return stream(request, ws, enrichment_id, "enrichment", last_event_id, graph_id)


@router.post(
    "/graphs/{graph_id}/chat",
    response_model=agent.ChatResponse,
    tags=["agent"],
    operation_id="chatAboutGraph",
    summary="Answer a question using a graph revision and the current selection",
)
async def chat_about_graph(request: Request, ws: Workspace, graph_id: str, body: agent.ChatRequest):
    with request.app.state.db.transaction(ws) as repo:
        graph = repo.graph(graph_id, body.revision)
    return await agent.answer_graph(request.app.state.provider, graph, body)


@router.post(
    "/graphs/{graph_id}/research",
    response_model=schemas.Run,
    status_code=202,
    tags=["runs"],
    operation_id="createFollowupRun",
    summary="Deepen or refine an existing graph with a natural-language instruction",
)
def create_followup(
    request: Request,
    response: Response,
    ws: Workspace,
    graph_id: str,
    body: schemas.FollowupCreate,
    idempotency_key: IdempotencyKey = None,
):
    return create(
        request,
        ws,
        idempotency_key,
        {"graph_id": graph_id, **body.model_dump()},
        202,
        response,
        lambda repo: jobs.create_followup(repo, graph_id, body, request.app.state.provider),
    )


@router.post(
    "/graphs/{graph_id}/scenarios",
    response_model=schemas.GraphMeta,
    status_code=201,
    tags=["graphs"],
    operation_id="createScenario",
    summary="Fork the graph into a scenario for hypothetical edits and sandboxed research",
)
def create_scenario(request: Request, ws: Workspace, graph_id: str, body: schemas.ScenarioCreate):
    with request.app.state.db.transaction(ws, write=True) as repo:
        return graphs.meta(jobs.create_scenario(repo, graph_id, body))


@router.get(
    "/graphs/{graph_id}/scenarios",
    tags=["graphs"],
    operation_id="listScenarios",
)
def list_scenarios(request: Request, ws: Workspace, graph_id: str):
    with request.app.state.db.transaction(ws) as repo:
        repo.graph(graph_id)
        items = [
            graphs.meta(g)
            for g in repo.all("graph")
            if g.get("parent_graph_id") == graph_id and g.get("mode") == "scenario"
        ]
        return {"items": items}


@router.post(
    "/graphs/{graph_id}/scenarios/{scenario_id}/reset",
    response_model=schemas.GraphMeta,
    tags=["graphs"],
    operation_id="resetScenario",
    summary="Revert the scenario to the base graph's latest real version",
)
def reset_scenario(request: Request, ws: Workspace, graph_id: str, scenario_id: str):
    with request.app.state.db.transaction(ws, write=True) as repo:
        return graphs.meta(jobs.reset_scenario_graph(repo, graph_id, scenario_id))


@router.delete(
    "/graphs/{graph_id}/scenarios/{scenario_id}",
    status_code=204,
    tags=["graphs"],
    operation_id="deleteScenario",
)
def delete_scenario(request: Request, ws: Workspace, graph_id: str, scenario_id: str):
    with request.app.state.db.transaction(ws, write=True) as repo:
        jobs.delete_scenario(repo, graph_id, scenario_id)
    return Response(status_code=204)


@router.post(
    "/graphs/{graph_id}/edits",
    response_model=schemas.EditResult,
    tags=["graphs"],
    operation_id="applyHypotheticalEdit",
    summary="Apply a natural-language hypothetical to a scenario graph",
)
async def apply_edit(request: Request, ws: Workspace, graph_id: str, body: schemas.EditCreate):
    from app.providers import Budget, BudgetExceeded, ProviderFailure

    worker = request.app.state.worker
    with request.app.state.db.transaction(ws) as repo:
        graph = repo.graph(graph_id)
        if graph.get("mode") != "scenario":
            raise APIError(
                400, "invalid_request", "Hypothetical edits apply to scenario graphs only"
            )
        if body.revision is not None and graph["revision"] != body.revision:
            raise APIError(409, "conflict", "The scenario has changed. Refresh it before editing.")
        names = {n["id"]: n["label"] for n in graph["nodes"]}
        edge_ids = {e["id"] for e in graph["edges"]}
        if set(body.target_node_ids) - names.keys() or set(body.target_edge_ids) - edge_ids:
            raise invalid("The selected entities or connections are no longer in this scenario")
        focus = set(body.target_node_ids)
        for edge in graph["edges"]:
            if edge["id"] in body.target_edge_ids:
                focus.update([edge["source_node_id"], edge["target_node_id"]])
        summary = {
            "selection": [names[i] for i in sorted(focus)],
            "entities": [
                {"label": n["label"], "kind": n["kind"]}
                for n in sorted(graph["nodes"], key=lambda n: n["id"] not in focus)
            ][:150],
            "relations": [
                f"{names[e['source_node_id']]} {e['predicate']} {names[e['target_node_id']]}"
                for e in graph["edges"]
            ][:200],
        }
        revision = graph["revision"]
    budget = Budget(
        schemas.RunLimits(max_input_tokens=60000, max_output_tokens=4000).model_dump(), {}
    )
    if not hasattr(worker.provider, "propose_edits"):
        raise APIError(400, "invalid_request", "The configured provider cannot propose edits")
    try:
        async with asyncio.timeout(85):
            edits = await worker.provider.propose_edits(body.instruction, summary, budget)
    except (ProviderFailure, BudgetExceeded, TimeoutError) as exc:
        raise APIError(
            503,
            "agent_unavailable",
            "The AI provider could not prepare the edit. Please try again shortly.",
        ) from exc
    edit_id = new_id("edit")
    with request.app.state.db.transaction(ws, write=True) as repo:
        graph = repo.graph(graph_id)
        if graph["revision"] != revision:
            raise APIError(409, "conflict", "The scenario changed while the edit was proposed")
        applied, skipped = graphs.apply_edits(repo, graph, edits, body.instruction, edit_id)
        graph.setdefault("scenario_edits", []).append(
            {"edit_id": edit_id, "instruction": body.instruction, "applied": applied, "at": now()}
        )
        graph["revision"] += 1
        graphs.refresh(graph)
        repo.save_graph(graph)
        return {
            "edit_id": edit_id,
            "graph_id": graph_id,
            "revision": graph["revision"],
            "applied": applied,
            "skipped": skipped,
        }


@router.get(
    "/graphs/{graph_id}/sites",
    tags=["geography"],
    operation_id="getGraphSites",
    summary="Map pins with what each site makes, shares as distributions, and provenance",
)
def graph_sites(request: Request, ws: Workspace, graph_id: str, revision: Revision = None):
    from app.geography import sites

    with request.app.state.db.transaction(ws) as repo:
        graph = repo.graph(graph_id, revision)
        return sites(graph)


@router.get(
    "/graphs/{graph_id}/geography",
    response_model=schemas.GeoFeatureCollection,
    tags=["geography"],
    operation_id="getGraphGeography",
    responses={200: {"content": {"application/geo+json": {}}}},
)
def graph_geography(request: Request, ws: Workspace, graph_id: str, revision: Revision = None):
    with request.app.state.db.transaction(ws) as repo:
        graph = repo.graph(graph_id, revision)
        return JSONResponse(
            request.app.state.geography.geojson(graph), media_type="application/geo+json"
        )


@router.get(
    "/materials/{material_node_id}/production",
    response_model=schemas.ProductionShares,
    tags=["geography"],
    operation_id="getMaterialProduction",
)
def material_production(
    request: Request,
    ws: Workspace,
    material_node_id: str,
    year: Annotated[int | None, Query(ge=1900, le=2200)] = None,
    stage: schemas.Stage | None = None,
):
    with request.app.state.db.transaction(ws, write=True) as repo:
        for graph in repo.all("graph"):
            node = next(
                (
                    n
                    for n in graph["nodes"]
                    if n["id"] == material_node_id and n["kind"] == "material"
                ),
                None,
            )
            if node:
                return request.app.state.geography.production(repo, node, year, stage)
        raise not_found()


@router.get(
    "/reference/commodities",
    response_model=schemas.CommodityList,
    tags=["geography"],
    operation_id="listCommodities",
)
def commodities(request: Request, ws: Workspace):
    return request.app.state.geography.reference()
