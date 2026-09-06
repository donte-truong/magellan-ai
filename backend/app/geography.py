import json
import math
from importlib.resources import files
from pathlib import Path

from pydantic import Field, model_validator

from app.db import digest, now, public
from app.errors import APIError, not_found
from app.graphs import claims_for
from app.schemas import Model, ProductionShares, Stage


class ProductionDataset(Model):
    commodity: str
    aliases: list[str] = Field(default_factory=list)
    year: int
    stage: Stage
    unit: str
    url: str
    title: str
    publisher: str
    locator: str
    production: dict[str, float]
    unallocated_production: float = Field(default=0, ge=0)
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_totals(self):
        if not self.production or any(
            len(c) != 2 or not c.isalpha() or not c.isupper() or v < 0
            for c, v in self.production.items()
        ):
            raise ValueError("Production requires ISO2 country keys and nonnegative quantities")
        if sum(self.production.values()) <= 0:
            raise ValueError("Production total must be positive")
        return self


class GeographyService:
    def __init__(self, path=None):
        raw = (
            Path(path).read_text()
            if path
            else files("app").joinpath("data/production.json").read_text()
        )
        self.datasets = [ProductionDataset.model_validate(v).model_dump() for v in json.loads(raw)]
        keys = [(d["commodity"], d["year"], d["stage"]) for d in self.datasets]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate commodity/year/stage production datasets")

    def reference(self):
        commodities = sorted({d["commodity"] for d in self.datasets})
        return {
            "items": [
                {
                    "commodity": c,
                    "years": sorted({d["year"] for d in self.datasets if d["commodity"] == c}),
                    "stages": sorted({d["stage"] for d in self.datasets if d["commodity"] == c}),
                }
                for c in commodities
            ]
        }

    def production(self, repo, node, year=None, stage=None):
        if node["kind"] != "material":
            raise not_found()
        labels = {node["label"].casefold(), node.get("canonical_name", "").casefold()}
        candidates = [
            d
            for d in self.datasets
            if labels.intersection(
                {d["commodity"].casefold(), *[a.casefold() for a in d["aliases"]]}
            )
            and (year is None or d["year"] == year)
            and (stage is None or d["stage"] == stage)
        ]
        if not candidates:
            raise APIError(
                404,
                "source_unavailable",
                "No production dataset matches this material, year and stage",
            )
        dataset = max(candidates, key=lambda d: (d["year"], d["stage"] == "mine"))
        body = json.dumps(dataset, sort_keys=True)
        source_id = "src_" + digest(body.encode())[:32]
        # Stable source IDs within each workspace; source metadata is not overwritten on reads.
        try:
            source = repo.get(source_id, "source")
        except APIError as exc:
            if exc.code != "not_found":
                raise
            source = {
                "id": source_id,
                "url": dataset["url"],
                "title": dataset["title"],
                "publisher": dataset["publisher"],
                "retrieved_at": now(),
                "content_hash": digest(body.encode()),
                "source_family_id": "usgs",
                "kind": "government_dataset",
                "license_notes": "Public-domain USGS data; hash covers the packaged transcription, not the full PDF.",
                "_body": body,
            }
            repo.put("source", source)
        total = math.fsum(dataset["production"].values()) + dataset["unallocated_production"]
        shares = [
            {"country_iso2": c, "share": value / total}
            for c, value in sorted(dataset["production"].items(), key=lambda x: (-x[1], x[0]))
        ]
        return ProductionShares(
            material_node_id=node["id"],
            commodity=dataset["commodity"],
            year=dataset["year"],
            stage=dataset["stage"],
            unit=dataset["unit"],
            shares=shares,
            hhi=math.fsum(s["share"] ** 2 for s in shares),
            top_share=max(s["share"] for s in shares),
            source_id=source_id,
            method={
                "name": f"country_{dataset['stage']}_production_share",
                "version": "1",
                "params": {
                    "stage": dataset["stage"],
                    "denominator": "sum_of_reported_estimates",
                    "unallocated_production": dataset["unallocated_production"],
                },
                "assumptions": [
                    "HHI excludes the unallocated Other countries category and is a lower bound."
                ],
            },
            data_quality={
                "coverage_pct": math.fsum(s["share"] for s in shares) * 100,
                "notes": dataset["notes"],
                "as_of": source["retrieved_at"],
            },
        ).model_dump()

    def evidenced_location(self, graph, node):
        layer = node["data"].get("geography")
        if not layer:
            return None
        claims = claims_for(graph, layer.get("claim_ids", []))
        valid = []
        for claim in claims:
            country = next((n for n in graph["nodes"] if n["id"] == claim["object_id"]), None)
            country_code = (country or {}).get("external_ids", {}).get("iso2")
            if (
                claim["subject_id"] == node["id"]
                and claim["predicate"] == "LOCATED_IN"
                and claim["status"] == "accepted"
                and claim["evidence"]
                and country
                and country["kind"] == "geography"
                and country_code == layer["country_iso2"]
            ):
                valid.append(claim)
        return (layer, valid) if valid else None

    def geojson(self, graph):
        features, countries = [], {}
        for node in graph["nodes"]:
            location = self.evidenced_location(graph, node)
            if node["kind"] == "facility" and location:
                layer, claims = location
                if layer.get("lat") is not None and layer.get("lon") is not None:
                    features.append(
                        {
                            "type": "Feature",
                            "geometry": {
                                "type": "Point",
                                "coordinates": [layer["lon"], layer["lat"]],
                            },
                            "properties": {
                                "feature_kind": "facility",
                                "node_id": node["id"],
                                "node_kind": node["kind"],
                                "label": node["label"],
                                "country_iso2": layer["country_iso2"],
                                "support_label": claims[0]["support_label"],
                                "claim_ids": [c["id"] for c in claims],
                            },
                        }
                    )
            concentration = node["data"].get("concentration")
            if node["kind"] == "material" and concentration:
                for share in concentration["shares"]:
                    country = countries.setdefault(share["country_iso2"], [])
                    country.append(
                        {
                            "material_node_id": node["id"],
                            "commodity": concentration["commodity"],
                            "share": share["share"],
                            "year": concentration["year"],
                            "source_id": concentration["source_id"],
                            "method": concentration["method"],
                            "data_quality": concentration["data_quality"],
                        }
                    )
        features.extend(
            {
                "type": "Feature",
                "geometry": None,
                "properties": {"feature_kind": "country", "country_iso2": code, "shares": shares},
            }
            for code, shares in sorted(countries.items())
        )
        return {
            "type": "FeatureCollection",
            "graph_id": graph["id"],
            "revision": graph["revision"],
            "features": public(features),
        }


MAKER_PREDICATES = {"MANUFACTURES", "PRODUCES"}
PRECISION_RANK = {"address": 3, "city": 2, "region": 1, "country": 0}


def distributions(graph):
    """Who makes, and who supplies, each product, component, material, or organization, as a
    distribution over sources. Stated shares come from verified claims (an edge's operational
    weight). The rest of the mass is `unassigned`; sources with no stated share also carry a
    uniform-prior estimate over that remainder, labelled as an estimate, never as evidence.
    Distributions may sum to less than one when information is missing."""
    nodes = {n["id"]: n for n in graph["nodes"]}
    out = []
    for target in graph["nodes"]:
        for family, predicates, kinds in (
            ("makers", MAKER_PREDICATES, {"product", "component", "material"}),
            ("suppliers", {"SUPPLIES"}, {"organization", "facility"}),
        ):
            if target["kind"] not in kinds:
                continue
            edges = [
                e
                for e in graph["edges"]
                if e["target_node_id"] == target["id"] and e["predicate"] in predicates
            ]
            if not edges:
                continue
            entries, stated_total = [], 0.0
            for edge in edges:
                source = nodes[edge["source_node_id"]]
                weight = ((edge.get("data") or {}).get("operational") or {}).get("weight")
                entries.append(
                    {
                        "node_id": source["id"],
                        "label": source["label"],
                        "kind": source["kind"],
                        "predicate": edge["predicate"],
                        "scope": edge["scope"]["type"],
                        "share": weight,
                        "share_basis": "stated" if weight is not None else None,
                        "share_estimate": None,
                        "estimate_basis": None,
                        "claim_ids": list(edge["claim_ids"]),
                    }
                )
                stated_total += weight or 0.0
            unassigned = max(0.0, 1.0 - stated_total)
            unstated = [e for e in entries if e["share"] is None]
            for entry in unstated:
                entry["share_estimate"] = round(unassigned / len(unstated), 4)
                entry["estimate_basis"] = "uniform_prior"
            out.append(
                {
                    "target_node_id": target["id"],
                    "target_label": target["label"],
                    "family": family,
                    "entries": entries,
                    "stated_total": round(min(1.0, stated_total), 4),
                    "unassigned": round(unassigned, 4),
                }
            )
    return out


def sites(graph):
    """Pins for a map: every facility or organization with a resolved place, what it makes or
    supplies for this graph with its share (stated, or a uniform prior over the unassigned
    remainder, and split evenly across an operator's located plants when only the operator's
    share is known), the place's precision and method, and the claims and sources behind the
    location and the relations."""
    nodes = {n["id"]: n for n in graph["nodes"]}
    claims = graph.get("_claims") or {c["id"]: c for c in graph.get("claims", [])}
    dist = {(d["target_node_id"], d["family"]): d for d in distributions(graph)}
    operators = {}  # facility id -> organization ids
    plants = {}  # organization id -> located facility ids
    for edge in graph["edges"]:
        org, plant = None, None
        if edge["predicate"] == "OPERATES":
            org, plant = edge["source_node_id"], edge["target_node_id"]
        elif edge["predicate"] == "OWNED_BY":
            org, plant = edge["target_node_id"], edge["source_node_id"]
        if org and plant and nodes.get(plant, {}).get("kind") == "facility":
            operators.setdefault(plant, []).append(org)
            if (nodes[plant].get("data") or {}).get("geography"):
                plants.setdefault(org, []).append(plant)

    def urls(claim_ids):
        found = []
        for cid in claim_ids:
            for ev in (claims.get(cid) or {}).get("evidence", []):
                url = (ev.get("source") or {}).get("url")
                if url and url not in found:
                    found.append(url)
        return found

    def makes_for(node_id, divide=1, basis_suffix=""):
        rows = []
        for edge in graph["edges"]:
            if edge["source_node_id"] != node_id:
                continue
            family = (
                "makers"
                if edge["predicate"] in MAKER_PREDICATES
                else "suppliers"
                if edge["predicate"] == "SUPPLIES"
                else None
            )
            if family is None:
                continue
            entry = next(
                (
                    e
                    for e in dist.get((edge["target_node_id"], family), {}).get("entries", [])
                    if e["node_id"] == node_id and e["predicate"] == edge["predicate"]
                ),
                None,
            )
            share = basis = None
            if entry and entry["share"] is not None:
                share, basis = entry["share"], "stated"
            elif entry and entry["share_estimate"] is not None:
                share, basis = entry["share_estimate"], "uniform_prior"
            if share is not None and divide > 1:
                share, basis = round(share / divide, 4), f"{basis}{basis_suffix}"
            rows.append(
                {
                    "node_id": edge["target_node_id"],
                    "label": nodes[edge["target_node_id"]]["label"],
                    "kind": nodes[edge["target_node_id"]]["kind"],
                    "predicate": edge["predicate"],
                    "scope": edge["scope"]["type"],
                    "share": share,
                    "share_basis": basis,
                    "claim_ids": list(edge["claim_ids"]),
                    "sources": urls(edge["claim_ids"]),
                }
            )
        return rows

    out = []
    for node in graph["nodes"]:
        if node["kind"] not in {"facility", "organization"}:
            continue
        layer = (node.get("data") or {}).get("geography")
        if not layer or layer.get("lat") is None or layer.get("lon") is None:
            continue
        makes = makes_for(node["id"])
        if node["kind"] == "facility":
            # A plant inherits what its operator makes, split evenly across the operator's
            # located plants: which plant a given unit comes from is not knowable from public
            # text, so the split is a labelled prior, not a claim.
            for org in operators.get(node["id"], []):
                count = max(1, len(plants.get(org, [])))
                for row in makes_for(org, divide=count, basis_suffix="_over_plants"):
                    if not any(
                        r["node_id"] == row["node_id"] and r["predicate"] == row["predicate"]
                        for r in makes
                    ):
                        row["via_organization_id"] = org
                        makes.append(row)
        out.append(
            {
                "node_id": node["id"],
                "kind": node["kind"],
                # A located organization is its office or headquarters, never a plant.
                "role": "plant" if node["kind"] == "facility" else "organization",
                "label": node["label"],
                "country_iso2": layer["country_iso2"],
                "admin1": layer.get("admin1"),
                "city": layer.get("address"),
                "lat": layer["lat"],
                "lon": layer["lon"],
                "precision": layer.get("precision", "country"),
                "geocoding": ((node.get("data") or {}).get("custom") or {}).get("geocoding"),
                "location_claim_ids": list(layer.get("claim_ids", [])),
                "location_sources": urls(layer.get("claim_ids", [])),
                "operators": [
                    {"node_id": o, "label": nodes[o]["label"]}
                    for o in operators.get(node["id"], [])
                ],
                "makes": makes,
            }
        )
    return {"sites": out, "distributions": list(dist.values())}
