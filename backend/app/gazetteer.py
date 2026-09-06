"""Deterministic place resolution: countries, key regions, and recurring manufacturing cities.

No model geocodes anything. A place named in evidence is looked up here; the result carries its
precision (city, region, or country) so a country centroid is never mistaken for a plant's
location. Coordinates are approximate centres, recorded with the method name on the node.
"""

import json
import re
from importlib.resources import files
from pathlib import Path

from app.resolution import normalize_label

METHOD = "gazetteer_v1"
SPLIT = re.compile(r"\s*(?:,|;|/|\(|\)|\bin\b|\bnear\b)\s*")
STRIP_WORDS = ("facility", "plant", "factory", "site", "campus", "province", "city", "state")


class Gazetteer:
    def __init__(self, path=None):
        raw = (
            Path(path).read_text()
            if path
            else files("app").joinpath("data/gazetteer.json").read_text()
        )
        data = json.loads(raw)
        self.countries = data["countries"]
        self.by_country_name = {}
        for code, entry in self.countries.items():
            for name in (code, entry["name"], *entry.get("aliases", [])):
                self.by_country_name[normalize_label(name)] = code
        self.regions = {}
        for entry in data["regions"]:
            for name in (entry["name"], *entry.get("aliases", [])):
                self.regions.setdefault(normalize_label(name), []).append(entry)
        self.cities = {}
        for entry in data["cities"]:
            for name in (entry["name"], *entry.get("aliases", [])):
                self.cities.setdefault(normalize_label(name), []).append(entry)

    def country(self, text):
        """ISO2 for a country name, alias, or code; None otherwise."""
        return self.by_country_name.get(normalize_label(text))

    def parts(self, label):
        out = []
        for part in SPLIT.split(label or ""):
            key = normalize_label(part)
            for word in STRIP_WORDS:
                key = re.sub(rf"\b{word}\b", "", key).strip()
            if key:
                out.append(key)
        return out

    def resolve(self, label, country_hint=None):
        """Best deterministic match for a place label, or None.

        Returns country_iso2, admin1, city, lat, lon, precision, method. A city or region match
        must agree with any country named in the label or hinted by the extractor.
        """
        parts = self.parts(label)
        country = self.country(country_hint) if country_hint else None
        for part in parts:
            for tail in suffixes(part):
                code = self.by_country_name.get(tail)
                if code:
                    country = country or code
                    break
        if country is None:
            # A named region fixes the country too ("Paris, Texas" is not in France).
            for part in parts:
                for tail in suffixes(part):
                    regions = self.regions.get(tail, [])
                    if regions:
                        country = regions[0]["country"]
                        break
                if country:
                    break
        for part in parts:
            for tail in suffixes(part):
                for city in self.cities.get(tail, []):
                    if country is None or city["country"] == country:
                        return {
                            "country_iso2": city["country"],
                            "admin1": city["admin1"] or None,
                            "city": city["name"],
                            "lat": city["lat"],
                            "lon": city["lon"],
                            "precision": "city",
                            "method": METHOD,
                        }
        for part in parts:
            for tail in suffixes(part):
                for region in self.regions.get(tail, []):
                    if country is None or region["country"] == country:
                        return {
                            "country_iso2": region["country"],
                            "admin1": region["name"],
                            "city": None,
                            "lat": region["lat"],
                            "lon": region["lon"],
                            "precision": "region",
                            "method": METHOD,
                        }
        if country and country in self.countries:
            entry = self.countries[country]
            return {
                "country_iso2": country,
                "admin1": None,
                "city": None,
                "lat": entry["lat"],
                "lon": entry["lon"],
                "precision": "country",
                "method": METHOD,
            }
        return None


def suffixes(key):
    """'south wales' -> ['south wales', 'wales', 'south']; 'hsinchu science park' -> [..., 'hsinchu']:
    place names carry leading qualifiers and trailing descriptors."""
    words = key.split()
    tails = [" ".join(words[i:]) for i in range(len(words))]
    heads = [" ".join(words[:i]) for i in range(len(words) - 1, 0, -1)]
    return tails + heads
