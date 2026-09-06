"""Deterministic relationship validity, entity resolution, and passage selection.

No fuzzy or model-driven merges: a label matches by normalized text or an evidence-backed
alias; a part number matches only with the same manufacturer and kind. Anything ambiguous
is reported for review, never merged. Imported BOM hints are never consulted here.
"""

import re
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
    # Where an organization's plants are, and where a facility is: LOCATED_IN points at a
    # geography node; OPERATES links a company to a named site.
    "location": {"LOCATED_IN", "OPERATES"},
}
# Relations that describe an entity itself, not the researched product's supply of it.
GENERIC_PREDICATES = {"LOCATED_IN", "OPERATES", "OWNED_BY"}


def normalized_scope(predicate, scope_type):
    return "generic" if predicate in GENERIC_PREDICATES else scope_type


NON_DEPENDENCY_KINDS = {"organization", "facility", "geography"}


def valid_relation(predicate, subject_kind, object_kind):
    allowed = ALLOWED.get(predicate)
    return bool(allowed) and subject_kind in allowed[0] and object_kind in allowed[1]


def normalize_label(value):
    return " ".join(unicodedata.normalize("NFKC", value or "").casefold().split())


SOFTWARE_PATTERN = re.compile(
    r"(\.(bin|txt|clm_blob|dtbo?|ko|so|py|c|h|elf|img|hex|json|cfg|yaml|yml)$)"
    r"|\b(driver|drivers|firmware|kernel module|software|package|library|bootloader|blob|sdk|api)\b",
    re.IGNORECASE,
)


INTERFACE_PATTERN = re.compile(
    r"\b(ports?|slots?|headers?|connectors?|sockets?|jacks?|interfaces?|pinouts?|pin header)\b"
    r"|\b(wi-?fi|bluetooth|usb|pcie|pci express|hdmi|displayport|ethernet|sata|nvme|sd|microsd)\s*\d"
    r"|\b802\.11|\bgigabit ethernet\b|\bfast ethernet\b",
    re.IGNORECASE,
)


ACCESSORY_PATTERN = re.compile(
    r"\b(charg(e|ing) cable|power adapter|charger|wall plug|earbuds|headphones|earphones|"
    r"documentation|quick start guide|sim (ejector|tool)|starter kit|kit|bundle|case|cover|"
    r"screen protector|stand|mount|tripod|strap|lanyard|hat\+?|carrying pouch|cleaning cloth)\b",
    re.IGNORECASE,
)


def accessory(label, part_number=None, manufacturer=None):
    """Items sold or boxed with a product are not parts of it unless identified as a specific
    internal part by number or maker."""
    if part_number or manufacturer:
        return False
    return bool(ACCESSORY_PATTERN.search(label or ""))


def normalized_predicate(predicate, kind, object_kind):
    """Materials flow INPUT_TO a whole; components are PART_OF it. The same span supports the
    same relation either way, so the predicate is normalized rather than the claim rejected."""
    if predicate == "PART_OF" and kind == "material":
        return "INPUT_TO"
    if predicate == "INPUT_TO" and kind == "component" and object_kind in {"product", "component"}:
        return "PART_OF"
    return predicate


def interface_feature(label, part_number=None, manufacturer=None):
    """Ports, slots, headers, and interface standards describe interfaces, not parts, unless a
    specific part is identified by number or maker."""
    if part_number or manufacturer:
        return False
    return bool(INTERFACE_PATTERN.search(label or ""))


def software_artifact(label):
    """Firmware, drivers, and other software are not parts or materials."""
    return bool(SOFTWARE_PATTERN.search(label or ""))


def strip_manufacturer(label, manufacturer):
    """'Broadcom BCM2712' -> 'bcm2712' when the maker is known; otherwise the normalized label."""
    key = normalize_label(label)
    maker = normalize_label(manufacturer)
    if maker and key.startswith(maker + " "):
        return key[len(maker) + 1 :]
    return key


def name_variants(label, manufacturer=None, node=None):
    """Normalized forms a label may take: as given, and with a known maker prefix removed."""
    variants = {normalize_label(label)}
    makers = [manufacturer]
    if node is not None:
        makers.append((node.get("external_ids") or {}).get("manufacturer"))
    for maker in makers:
        if maker:
            variants.add(strip_manufacturer(label, maker))
    return variants


def node_names(node):
    """Normalized label, evidence-backed aliases, and the recorded part number."""
    names = {normalize_label(node["label"])} | {normalize_label(a) for a in node.get("aliases", [])}
    ids = node.get("external_ids") or {}
    if ids.get("mpn"):
        names.add(normalize_label(ids["mpn"]))
    maker = ids.get("manufacturer")
    if maker:
        names.add(strip_manufacturer(node["label"], maker))
    return names


def resolve_entity(graph, kind, label, part_number=None, manufacturer=None):
    """Return (node, review_reason). node is None when nothing matches or the match is ambiguous.

    A label matches a node by normalized text, an evidence-backed alias, the node's recorded part
    number, or the same text with a known manufacturer prefix removed (the maker must be recorded
    on the node or stated by the finding). Containment alone never matches; see near_duplicates.
    """
    candidates = []
    for node in graph["nodes"]:
        if node["kind"] != kind:
            continue
        if name_variants(label, manufacturer, node) & node_names(node):
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


PART_TOKEN = re.compile(r"\b[a-z0-9]{3,}\b")
# Quantities with units look like part numbers but describe a spec, not an identity.
SPEC_TOKEN = re.compile(
    r"^\d+(mp|gb|mb|tb|kb|mah|wh|mhz|ghz|khz|hz|nm|mm|cm|inch|in|w|v|a|k|bit|core|x|nit|nits|ppi)$"
)


def part_tokens(key):
    """Part-number-like tokens: three or more alphanumerics mixing letters and digits (rp1, a76,
    bcm2712), excluding bare numbers (100, 2023) and quantities such as 12mp or 8gb."""
    return {
        t
        for t in PART_TOKEN.findall(key)
        if any(c.isdigit() for c in t) and not t.isdigit() and not SPEC_TOKEN.match(t)
    }


QUOTE_CHARS = "'\u2018\u2019\u201a\u2032\"\u201c\u201d\u201e\u2033"
DASH_CHARS = "-\u2010\u2011\u2012\u2013\u2014\u2212"


def locate_span(body, quote):
    """Return the verbatim body substring the quote refers to, or None.

    Exact match first. Otherwise the quote is matched with whitespace runs, line breaks, and
    bracketed citation markers ("[12]") allowed between words and with straight or typographic
    quotes and dashes treated alike, so a quote copied from a PDF or a wiki still resolves to a
    verbatim span of the stored text. The returned span is always text of the body itself.
    """
    if not quote or not body:
        return None
    if quote in body:
        return quote
    words = quote.split()
    if not words or len(quote) > 1200:
        return None
    parts = []
    for word in words:
        chunk = []
        for ch in word:
            if ch in QUOTE_CHARS:
                chunk.append(f"[{re.escape(QUOTE_CHARS)}]")
            elif ch in DASH_CHARS:
                chunk.append(f"[{re.escape(DASH_CHARS)}]")
            else:
                chunk.append(re.escape(ch))
        parts.append("".join(chunk))
    pattern = r"(?:\s|\[\d{1,3}\])+".join(parts)
    try:
        match = re.search(pattern, body)
    except re.error:
        return None
    return match.group(0) if match else None


def tidy_label(label):
    """Slug-like labels lifted from URLs or alt text ("kioxia-256gb-nand-flash-memory") become
    words; everything else is returned untouched."""
    text = (label or "").strip()
    if " " not in text and text.count("-") >= 2 and text == text.lower():
        return text.replace("-", " ")
    return text


def near_duplicates(graph, kind, label, exclude_id=None):
    """Same-kind nodes whose label contains, is contained by, or shares a part-number-like token
    with this label. A review signal only; it never authorizes a merge."""
    if label is None:
        return []
    key = normalize_label(label)
    tokens = part_tokens(key)
    found = []
    for node in graph["nodes"]:
        if node["kind"] != kind or node["id"] == exclude_id:
            continue
        other = normalize_label(node["label"])
        if other == key:
            continue
        contained = (len(key) >= 3 and re.search(rf"\b{re.escape(key)}\b", other)) or (
            len(other) >= 3 and re.search(rf"\b{re.escape(other)}\b", key)
        )
        if contained or (tokens & part_tokens(other)):
            found.append(node)
    return found


MAX_RESOLUTION_CANDIDATES = 12


STOPWORDS = {"the", "and", "for", "with", "of", "a", "an", "in", "on", "to"}


def word_tokens(label):
    return {t for t in re.findall(r"[a-z0-9]+", normalize_label(label)) if t not in STOPWORDS}


def resolution_candidates(graph, kind, label, anchor_id=None):
    """Existing same-kind nodes a new label might paraphrase, best first: token near-duplicates
    anywhere in the graph, siblings that already relate to the same anchor (other parts of the
    same whole, other makers of the same part), and cousins under the anchor's own wholes
    ("rear wide-angle camera" under "cameras" beside "48MP Main camera" under the phone).
    Ranked by shared words and bounded, so the model sees a short list, not the graph."""
    key = normalize_label(label)
    nodes = {n["id"]: n for n in graph["nodes"]}
    ranked = {}  # node id -> (priority, shared words)
    words = word_tokens(label)

    def consider(node, priority):
        if node is None or node["id"] == anchor_id or node["kind"] != kind:
            return
        if normalize_label(node["label"]) == key:
            return
        shared = len(words & word_tokens(node["label"]))
        current = ranked.get(node["id"])
        if current is None or (priority, shared) > current:
            ranked[node["id"]] = (priority, shared)

    for node in near_duplicates(graph, kind, label):
        consider(node, 3)
    if anchor_id:
        parents = {e["target_node_id"] for e in graph["edges"] if e["source_node_id"] == anchor_id}
        for edge in graph["edges"]:
            if edge["target_node_id"] == anchor_id:
                consider(nodes.get(edge["source_node_id"]), 2)
            elif edge["target_node_id"] in parents:
                consider(nodes.get(edge["source_node_id"]), 1)
    order = sorted(ranked, key=lambda i: ranked[i], reverse=True)
    return [nodes[i] for i in order[:MAX_RESOLUTION_CANDIDATES]]


def preferred_label(current, candidate):
    """Prefer a short identifier-bearing name ("BCM2712", "Renesas DA9091") over a description
    ("D0 stepping of the BCM2712 application processor", "Dialog/Renesas power chip") once both
    are evidenced."""
    if not part_tokens(normalize_label(candidate)):
        return False
    current_words, candidate_words = len(current.split()), len(candidate.split())
    if not part_tokens(normalize_label(current)):
        return candidate_words <= 4
    return current_words > 4 and candidate_words < current_words


def static_rejection(
    kind,
    label,
    predicate,
    object_kind,
    object_label,
    scope_type,
    root_label,
    part_number=None,
    manufacturer=None,
):
    """Deterministic gates that need no evidence reading. Applied before verification (so the
    verifier is not paid for claims that can never commit) and again at commit time."""
    if not valid_relation(predicate, kind, object_kind):
        return "predicate_invalid"
    if normalize_label(label) == normalize_label(object_label):
        return "predicate_invalid"
    if predicate in {"PART_OF", "INPUT_TO"}:
        if software_artifact(label) or software_artifact(object_label):
            return "predicate_invalid"  # firmware, drivers, software are not parts
        if (kind == "component" and interface_feature(label, part_number, manufacturer)) or (
            object_kind == "component" and interface_feature(object_label)
        ):
            return "predicate_invalid"  # ports, slots, and standards are interfaces
        if (kind == "component" and accessory(label, part_number, manufacturer)) or (
            object_kind == "component" and accessory(object_label)
        ):
            return "predicate_invalid"  # boxed or sold-with items are not parts
    if any(
        k == "product" and normalize_label(name) != normalize_label(root_label)
        for k, name in ((kind, label), (object_kind, object_label))
    ):
        return "scope_mismatch"
    if scope_type == "product" and predicate == "LOCATED_IN":
        return "scope_mismatch"
    if scope_type != "product" and "product" in (kind, object_kind):
        return "scope_mismatch"
    if scope_type == "company" and "organization" not in (kind, object_kind):
        return "scope_mismatch"
    return None


def record_identity(node, label, part_number=None, manufacturer=None):
    """Attach an evidence-backed alias and identifiers to a resolved node."""
    if normalize_label(label) != normalize_label(node["label"]) and label not in node["aliases"]:
        if preferred_label(node["label"], label):
            node["aliases"].append(node["label"])
            node["label"] = label
        else:
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
