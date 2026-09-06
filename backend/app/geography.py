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
