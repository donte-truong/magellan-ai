"""Deterministic relationship validity, entity resolution, and passage selection.

No fuzzy or model-driven merges: a label matches by normalized text or an evidence-backed
alias; a part number matches only with the same manufacturer and kind. Anything ambiguous
is reported for review, never merged. Imported BOM hints are never consulted here.
"""

import unicodedata

# predicate -> (allowed subject kinds, allowed object kinds). Direction is literal:
# "component PART_OF product", "organization MANUFACTURES component", "facility LOCATED_IN geography".
ALLOWED = {
    "INPUT_TO": ({"component", "material"}, {"product", "component", "material"}),
    "PART_OF": ({"component", "material", "facility"}, {"product", "component", "facility"}),
    "MANUFACTURES": ({"organization", "facility"}, {"product", "component"}),
    "PRODUCES": ({"organization", "facility"}, {"product", "component", "material"}),
    "OPERATES": ({"organization"}, {"facility"}),
    "LOCATED_IN": ({"facility", "organization"}, {"geography"}),
    "SUPPLIES": ({"organization", "facility"}, {"organization", "facility"}),
    "OWNED_BY": ({"organization", "facility"}, {"organization"}),
    "PROCESSED_BY": ({"material", "component"}, {"organization", "facility"}),
}
# Relation types a research task can seek for a target, and the predicates that answer them.
RELATION_TYPES = {
    "upstream_inputs": {"INPUT_TO", "PART_OF"},
    "manufacturer_or_facility": {"MANUFACTURES", "PRODUCES"},
    "material_origin": {"PROCESSED_BY", "PRODUCES"},
    "supplier": {"SUPPLIES"},
}
NON_DEPENDENCY_KINDS = {"organization", "facility", "geography"}


def valid_relation(predicate, subject_kind, object_kind):
    allowed = ALLOWED.get(predicate)
    return bool(allowed) and subject_kind in allowed[0] and object_kind in allowed[1]


def normalize_label(value):
    return " ".join(unicodedata.normalize("NFKC", value or "").casefold().split())


def resolve_entity(graph, kind, label, part_number=None, manufacturer=None):
    """Return (node, review_reason). node is None when nothing matches or the match is ambiguous."""
    key = normalize_label(label)
    candidates = []
    for node in graph["nodes"]:
        if node["kind"] != kind:
            continue
        names = {normalize_label(node["label"])} | {
            normalize_label(a) for a in node.get("aliases", [])
        }
        if key in names:
            candidates.append(node)
    if part_number and manufacturer:
        mpn, maker = part_number.strip(), normalize_label(manufacturer)
        for node in graph["nodes"]:
            ids = node.get("external_ids") or {}
            if (
                node["kind"] == kind
                and ids.get("mpn") == mpn
                and normalize_label(ids.get("manufacturer", "")) == maker
                and node not in candidates
            ):
                candidates.append(node)
    if len(candidates) > 1:
        return None, "ambiguous_match"
    if not candidates:
        return None, None
    node = candidates[0]
    ids = node.get("external_ids") or {}
    if part_number and ids.get("mpn") and ids["mpn"] != part_number.strip():
        # Same name, different identifier: a package or revision difference, not the same part.
        return None, "identifier_conflict"
    if (
        manufacturer
        and ids.get("manufacturer")
        and normalize_label(ids["manufacturer"]) != normalize_label(manufacturer)
    ):
        return None, "identifier_conflict"
    return node, None


def record_identity(node, label, part_number=None, manufacturer=None):
    """Attach an evidence-backed alias and identifiers to a resolved node."""
    if normalize_label(label) != normalize_label(node["label"]) and label not in node["aliases"]:
        node["aliases"].append(label)
    ids = node.setdefault("external_ids", {})
    if part_number and not ids.get("mpn"):
        ids["mpn"] = part_number.strip()
    if manufacturer and not ids.get("manufacturer"):
        ids["manufacturer"] = manufacturer.strip()


FIRST_WINDOW = 8000
KEYWORD_WINDOW = 6000
WHOLE_TEXT = 16000


def select_passages(text, terms):
    """First window plus up to two keyword-dense windows; the full text stays stored elsewhere."""
    if len(text) <= WHOLE_TEXT:
        return text, [(0, len(text))]
    lower = text.casefold()
    keywords = [t.casefold() for t in " ".join(terms).split() if len(t) > 3]
    windows = [
        (start, min(len(text), start + KEYWORD_WINDOW))
        for start in range(FIRST_WINDOW, len(text), KEYWORD_WINDOW)
    ]
    scored = sorted(
        windows,
        key=lambda w: -sum(lower[w[0] : w[1]].count(k) for k in keywords),
    )
    chosen = sorted(
        [(0, FIRST_WINDOW)]
        + [w for w in scored[:2] if any(lower[w[0] : w[1]].count(k) for k in keywords)]
    )
    return "\n[OMITTED SOURCE TEXT]\n".join(text[s:e] for s, e in chosen), chosen
