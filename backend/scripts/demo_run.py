"""Build, extend, and export a demo graph against a persistent database.

    python scripts/demo_run.py run --product "iPhone 17 Pro" --company Apple \
        --out ../frontend/public/assets/data/iphone-17-pro
    python scripts/demo_run.py followup --graph gph_... --instruction "..." [--targets "A19 Pro|TSMC"]
    python scripts/demo_run.py export --graph gph_...

The app runs in-process with its embedded worker against DATABASE_URL (default
sqlite:///./demo.db, gitignored), so later follow-ups and scenarios reach the same graph.
Model choices come from the environment (OPENROUTER_* variables); every export is public data
only (run, graph export, sites, BOM, events), never the private model-call history.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

TERMINAL = {"completed", "partial", "failed", "cancelled"}


def settings():
    return Settings(
        database_url=os.environ.get("DATABASE_URL", "sqlite:///./demo.db"),
        embedded_worker=True,
        worker_slots=2,
        event_retention=int(os.environ.get("EVENT_RETENTION", "300000")),
        task_concurrency=int(os.environ.get("TASK_CONCURRENCY", "4")),
        research_concurrency=int(os.environ.get("RESEARCH_CONCURRENCY", "6")),
    )


def limits(args):
    return {
        "max_hops": args.max_hops,
        "max_nodes": args.max_nodes,
        "max_claims": args.max_claims,
        "max_searches": args.max_searches,
        "max_documents": args.max_documents,
        "max_input_tokens": args.max_input_tokens,
        "max_output_tokens": args.max_output_tokens,
        "max_seconds": args.max_seconds,
    }


async def wait_run(client, run):
    started, last = time.time(), None
    while run["status"] not in TERMINAL:
        await asyncio.sleep(10)
        run = (await client.get(f"/v1/runs/{run['id']}")).json()
        u = run["usage"]
        line = (
            f"[{int(time.time() - started)}s] {run['status']} progress={run['progress']} "
            f"frontier={run.get('frontier')} searches={u['searches']} docs={u['documents']} "
            f"in={u['input_tokens']} out={u['output_tokens']} cost_minor={u.get('cost_minor')}"
        )
        if line != last:
            print(line, flush=True)
            last = line
    for enr in run.get("enrichment_ids", []):
        for _ in range(120):
            job = (await client.get(f"/v1/graphs/{run['graph_id']}/enrichments/{enr}")).json()
            if job.get("status") in TERMINAL:
                break
            await asyncio.sleep(5)
        print("enrichment:", enr, job.get("status"), job.get("progress"), flush=True)
    return run


async def export(client, graph_id, out, runs):
    out.mkdir(parents=True, exist_ok=True)
    graph = (await client.get(f"/v1/graphs/{graph_id}/export")).json()
    (out / "graph.json").write_text(json.dumps(graph, indent=1))
    sites = (await client.get(f"/v1/graphs/{graph_id}/sites")).json()
    (out / "sites.json").write_text(json.dumps(sites, indent=1))
    saved_runs = []
    for run in runs:
        current = (await client.get(f"/v1/runs/{run['id']}")).json()
        saved_runs.append(current)
        bom = (await client.get(current["bom_url"])).json()
        (out / f"bom-{current['id']}.json").write_text(json.dumps(bom, indent=1))
        events = [
            json.loads(line[6:])
            for line in (await client.get(current["events_url"])).text.splitlines()
            if line.startswith("data: ")
        ]
        (out / f"events-{current['id']}.json").write_text(json.dumps(events))
    index_path = out / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    known = {r["id"]: r for r in index.get("runs", [])}
    for r in saved_runs:
        known[r["id"]] = {
            k: r.get(k)
            for k in (
                "id",
                "mode",
                "instruction",
                "status",
                "stop_reason",
                "usage",
                "progress",
                "created_at",
                "completed_at",
            )
        }
    index.update(
        graph_id=graph_id,
        product=graph["nodes"][0]["label"] if graph["nodes"] else None,
        generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        stats=graph.get("stats"),
        sites=len(sites["sites"]),
        runs=list(known.values()),
        files=sorted(p.name for p in out.iterdir() if p.suffix == ".json"),
    )
    index_path.write_text(json.dumps(index, indent=1))
    print(
        "exported:",
        out,
        "| nodes",
        len(graph["nodes"]),
        "edges",
        len(graph["edges"]),
        "sites",
        len(sites["sites"]),
        flush=True,
    )


async def main(args):
    cfg = settings()
    print(
        "models:",
        cfg.model_for("extraction"),
        "| verifier:",
        cfg.model_for("verifier"),
        "| planner:",
        cfg.model_for("planner"),
        "| db:",
        cfg.database_url,
        flush=True,
    )
    app = create_app(cfg)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://demo",
            headers={"Authorization": "Bearer dev-token"},
            timeout=120,
        ) as client:
            out = Path(args.out)
            if args.command == "run":
                body = {"product": args.product, "company": args.company, "limits": limits(args)}
                r = await client.post("/v1/runs", json=body)
                print("run:", r.status_code, r.text[:200], flush=True)
                r.raise_for_status()
                run = await wait_run(client, r.json())
                await export(client, run["graph_id"], out, [run])
            elif args.command == "followup":
                targets = None
                if args.targets:
                    graph = (await client.get(f"/v1/graphs/{args.graph}/export")).json()
                    wanted = {t.strip().casefold() for t in args.targets.split("|")}
                    targets = [n["id"] for n in graph["nodes"] if n["label"].casefold() in wanted]
                    print("targets:", targets, flush=True)
                body = {"instruction": args.instruction, "limits": limits(args)}
                if targets:
                    body["target_node_ids"] = targets
                r = await client.post(f"/v1/graphs/{args.graph}/research", json=body)
                print("followup:", r.status_code, r.text[:200], flush=True)
                r.raise_for_status()
                run = await wait_run(client, r.json())
                await export(client, args.graph, out, [run])
            else:
                await export(client, args.graph, out, [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["run", "followup", "export"])
    parser.add_argument("--product", default="iPhone 17 Pro")
    parser.add_argument("--company", default="Apple")
    parser.add_argument("--graph")
    parser.add_argument("--instruction")
    parser.add_argument("--targets", help="labels separated by |")
    parser.add_argument("--out", default="../frontend/public/assets/data/demo")
    parser.add_argument("--max-hops", type=int, default=4)
    parser.add_argument("--max-nodes", type=int, default=600)
    parser.add_argument("--max-claims", type=int, default=3000)
    parser.add_argument("--max-searches", type=int, default=750)
    parser.add_argument("--max-documents", type=int, default=1500)
    parser.add_argument("--max-input-tokens", type=int, default=30000000)
    parser.add_argument("--max-output-tokens", type=int, default=3000000)
    parser.add_argument("--max-seconds", type=int, default=5400)
    asyncio.run(main(parser.parse_args()))
