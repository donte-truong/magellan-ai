"""Public API models. Field names follow docs/openapi.yaml."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Support = Literal[
    "directly_supported",
    "strongly_inferred",
    "weakly_inferred",
    "disputed",
    "user_asserted",
    "unresolved",
]
Predicate = Literal[
    "INPUT_TO",
    "PART_OF",
    "MANUFACTURES",
    "PRODUCES",
    "OPERATES",
    "LOCATED_IN",
    "SUPPLIES",
    "OWNED_BY",
    "PROCESSED_BY",
]
NodeKind = Literal["product", "component", "material", "organization", "facility", "geography"]
RunStatus = Literal[
    "queued", "awaiting_input", "running", "completed", "partial", "failed", "cancelled"
]
EnrichmentKind = Literal["geography", "concentration", "market_exposure"]
Stage = Literal["mine", "refinery", "export"]
Name = Annotated[str, Field(min_length=1, max_length=200)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class Method(Model):
    name: str
    version: str = "1"
    params: dict[str, Any] = Field(default_factory=dict)
    assumptions: list[str] = Field(default_factory=list)


class DataQuality(Model):
    coverage_pct: float = Field(ge=0, le=100)
    unmapped_node_ids: list[str] = Field(default_factory=list)
    equal_weight_fallback: bool = False
    notes: list[str] = Field(default_factory=list)
    as_of: str | None = None


class Scope(Model):
    type: Literal["product", "company", "generic"]
    product_node_id: str | None = None
    organization_node_id: str | None = None


class GeographyLayer(Model):
    country_iso2: str = Field(pattern=r"^[A-Z]{2}$")
    admin1: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    address: str | None = None
    precision: Literal["address", "city", "region", "country"] = "country"
    claim_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def coordinates_together(self):
        if (self.lat is None) != (self.lon is None):
            raise ValueError("Latitude and longitude must be provided together")
        return self


class ShareEntry(Model):
    country_iso2: str = Field(pattern=r"^[A-Z]{2}$")
    share: float = Field(ge=0, le=1)
    organization_node_id: str | None = None


class ConcentrationLayer(Model):
    commodity: str
    year: int
    stage: Stage
    hhi: float = Field(ge=0, le=1)
    top_share: float = Field(ge=0, le=1)
    shares: list[ShareEntry]
    source_id: str
    method: Method
    data_quality: DataQuality


class InstrumentMapping(Model):
    instrument_id: str
    role: Literal["commodity_price", "supplier_equity", "supplier_credit", "fx", "freight"]
    mapping_confidence: Literal["strong", "plausible", "weak"]
    rationale: str = ""
    method: Method | None = None


class MarketLayer(Model):
    instruments: list[InstrumentMapping] = Field(default_factory=list)
    exposure_weight: float | None = Field(default=None, ge=0, le=1)
    method: Method | None = None
    data_quality: DataQuality | None = None


class OperationalLayer(Model):
    quantity: float | None = Field(default=None, ge=0)
    unit: str | None = None
    lead_time_days: int | None = Field(default=None, ge=0)
    inventory_days: int | None = Field(default=None, ge=0)
    weight: float | None = Field(default=None, ge=0, le=1)
    substitutability: Literal["none", "low", "medium", "high"] | None = None


class DataLayers(Model):
    geography: GeographyLayer | None = None
    concentration: ConcentrationLayer | None = None
    market: MarketLayer | None = None
    operational: OperationalLayer | None = None
    custom: dict[str, Any] = Field(default_factory=dict)


class Node(Model):
    id: str
    kind: NodeKind
    label: Name
    canonical_name: str = ""
    aliases: list[str] = Field(default_factory=list)
    external_ids: dict[str, str] = Field(default_factory=dict)
    tier: int | None = Field(default=None, ge=0)
    status: Support = "unresolved"
    flags: list[
        Literal["single_supplier_observed", "labor_risk_context", "screening_candidate", "disputed"]
    ] = Field(default_factory=list)
    data: DataLayers = Field(default_factory=DataLayers)


class EvidenceSummary(Model):
    source_count: int = 0
    independent_family_count: int = 0
    latest_published_at: str | None = None
    has_contradiction: bool = False


class Edge(Model):
    id: str
    source_node_id: str
    target_node_id: str
    predicate: Predicate
    scope: Scope
    support_label: Support
    claim_ids: list[str]
    evidence_summary: EvidenceSummary = Field(default_factory=EvidenceSummary)
    # Provenance and the deterministic edge_evidence_v1 score; filled by app.edge_metadata.
    source: list["EdgeSource"] = Field(default_factory=list)
    date: str | None = None
    time: str | None = None
    confidence: float = Field(default=0, ge=0, le=1)
    confidence_details: "EdgeConfidenceDetails | None" = None
    valid_from: str | None = None
    valid_to: str | None = None
    data: DataLayers = Field(default_factory=DataLayers)


class Source(Model):
    id: str
    url: str
    retrieved_at: str
    content_hash: str
    title: str | None = None
    publisher: str | None = None
    published_at: str | None = None
    source_family_id: str = ""
    kind: Literal[
        "filing",
        "supplier_list",
        "teardown",
        "datasheet",
        "press",
        "government_dataset",
        "upload",
        "other",
    ] = "other"
    license_notes: str | None = None


class EdgeSource(Source):
    support_types: list[Literal["supports", "contradicts", "context"]]


class EdgeConfidenceFactors(Model):
    base: float
    corroboration: float
    freshness: float
    contradiction: float


class EdgeDataQuality(Model):
    calibrated: Literal[False] = False
    replay: bool
    supporting_families: int = Field(ge=0)
    missing_claim_ids: list[str]
    missing_source_ids: list[str]
    notes: list[str]


class EdgeConfidenceDetails(Model):
    method: Method
    factors: EdgeConfidenceFactors
    data_quality: EdgeDataQuality
    evaluated_at: str | None = None


class Evidence(Model):
    id: str
    source_id: str
    span: str = Field(min_length=1, max_length=600)
    support_type: Literal["supports", "contradicts", "context"]
    locator: str = ""
    extracted_at: str
    source: Source | None = None


class ClaimSummary(Model):
    id: str
    subject_id: str
    predicate: Predicate
    object_id: str
    scope: Scope
    status: Literal["proposed", "accepted", "rejected", "disputed", "under_review"]
    support_label: Support


class Claim(ClaimSummary):
    rationale: str = ""
    observed_at: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    evidence: list[Evidence] = Field(default_factory=list)
    contradiction_claim_ids: list[str] = Field(default_factory=list)
    resolution_notes: list[str] = Field(default_factory=list)
    confidence_features: dict[str, Any] = Field(default_factory=dict)


class NodeDetail(Node):
    in_edge_ids: list[str]
    out_edge_ids: list[str]
    claims: list[ClaimSummary]


class EdgeDetail(Edge):
    claims: list[Claim]
    contradictions: list[Claim]
    rationale: str = ""
    caveats: list[str] = Field(default_factory=list)


class GraphMeta(Model):
    id: str
    revision: int
    name: str
    created_at: str
    updated_at: str
    run_id: str | None = None
    parent_graph_id: str | None = None
    root_node_id: str | None = None
    mode: Literal["live", "replay", "scenario"] = "live"
    # Scenarios: the base revision they were forked from and the hypothetical edits applied.
    forked_from_revision: int | None = None
    scenario_edits: list[dict[str, Any]] = Field(default_factory=list)
    stats: dict[str, Any]


class Graph(GraphMeta):
    nodes: list[Node]
    edges: list[Edge]
    claims: list[ClaimSummary] | None = None


class GraphExport(GraphMeta):
    nodes: list[Node]
    edges: list[Edge]
    claims: list[Claim]
    evidence: list[Evidence]
    sources: list[Source]
    exported_at: str


class GraphDiff(Model):
    graph_id: str
    from_: int = Field(alias="from")
    to: int
    nodes_added: list[Node]
    nodes_removed: list[str]
    nodes_changed: list[Node]
    edges_added: list[Edge]
    edges_removed: list[str]
    edges_changed: list[Edge]


class MutationOp(Model):
    op: Literal[
        "add_node",
        "add_edge",
        "update_node",
        "update_edge",
        "remove_node",
        "remove_edge",
        "annotate",
    ]
    temp_id: str | None = None
    node: dict[str, Any] | None = None
    edge: dict[str, Any] | None = None
    node_id: str | None = None
    edge_id: str | None = None
    target_id: str | None = None
    patch: dict[str, Any] | None = None
    key: str | None = Field(default=None, min_length=1, max_length=100)
    value: Any = None
    reason: str | None = None

    @model_validator(mode="after")
    def required_fields(self):
        required = {
            "add_node": ["node"],
            "add_edge": ["edge"],
            "update_node": ["node_id", "patch"],
            "update_edge": ["edge_id", "patch"],
            "remove_node": ["node_id", "reason"],
            "remove_edge": ["edge_id", "reason"],
            "annotate": ["target_id", "key"],
        }
        for key in required[self.op]:
            if getattr(self, key) is None:
                raise ValueError(f"{self.op} requires {key}")
        return self


class MutationBatch(Model):
    ops: list[MutationOp] = Field(min_length=1, max_length=200)
    message: str = Field(default="", max_length=2000)


class MutationResult(Model):
    graph_id: str
    revision: int
    delta: GraphDiff
    temp_id_map: dict[str, str]


class MutationRecord(Model):
    id: str
    graph_id: str
    revision_before: int
    revision_after: int
    actor: str
    ops: list[MutationOp]
    message: str = ""
    created_at: str
    proposal_id: str | None = None


class ForkCreate(Model):
    name: Name | None = None
    revision: int | None = Field(default=None, ge=0)


class Upload(Model):
    id: str
    filename: str
    row_count: int
    columns: list[str]
    preview: list[dict[str, Any]] = Field(max_length=10)
    warnings: list[str]
    content_hash: str
    created_at: str


class RunLimits(Model):
    max_hops: int = Field(default=3, ge=1, le=4)
    max_nodes: int = Field(default=50, ge=1, le=150)
    max_claims: int = Field(default=80, ge=0, le=300)
    max_searches: int = Field(default=25, ge=0, le=120)
    max_documents: int = Field(default=40, ge=0, le=200)
    max_input_tokens: int = Field(default=400000, ge=0, le=2000000)
    max_output_tokens: int = Field(default=30000, ge=0, le=200000)
    max_seconds: int = Field(default=480, ge=1, le=900)
    # Per-task caps (new): searches and documents one research task may consume.
    max_searches_per_task: int = Field(default=3, ge=1, le=10)
    max_documents_per_task: int = Field(default=4, ge=1, le=20)


class RunCreate(Model):
    product: Name
    company: Name | None = None
    upload_id: str | None = None
    limits: RunLimits = Field(default_factory=RunLimits)
    replay_of_run_id: str | None = None
    # A persisted /v1/bom response. Rows seed the graph as user_asserted; citations stay unverified.
    bom_estimate: "BomEstimateImport | None" = None

    @model_validator(mode="after")
    def estimate_matches_product(self):
        if self.bom_estimate is None:
            return self
        if self.upload_id:
            raise ValueError("Supply upload_id or bom_estimate, not both")
        normalize = lambda value: " ".join(value.casefold().split())  # noqa: E731
        if normalize(self.product) != normalize(self.bom_estimate.product.name):
            raise ValueError("product must match bom_estimate.product.name")
        return self


class RunUsage(Model):
    searches: int = 0
    documents: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_minor: int | None = None
    currency: str = "USD"
    elapsed_seconds: float = 0
    binding_limit: str | None = None


class QuestionChoice(Model):
    id: str
    label: str
    detail: str = ""


class RunQuestion(Model):
    question_id: str
    kind: Literal["product_ambiguity", "company_ambiguity"]
    prompt: str
    choices: list[QuestionChoice]


class Run(Model):
    id: str
    status: RunStatus
    mode: Literal["live", "replay", "followup"]
    # Follow-up runs: the natural-language instruction steering planning and extraction.
    instruction: str | None = None
    product: str
    company: str | None = None
    upload_id: str | None = None
    graph_id: str
    limits: RunLimits
    usage: RunUsage
    progress: dict[str, int]
    # Pending research tasks per tier (new field; progress stays a flat int map).
    frontier: dict[str, int] = Field(default_factory=dict)
    # Follow-up jobs the run queued when it finished (geography for facilities without an
    # evidenced location); poll them at /graphs/{graph_id}/enrichments/{id}.
    enrichment_ids: list[str] = Field(default_factory=list)
    pending_questions: list[RunQuestion]
    stop_reason: str | None = None
    open_questions: list[str]
    events_url: str
    bom_url: str
    provider: str
    created_at: str
    completed_at: str | None = None


class RunAnswer(Model):
    question_id: str
    choice: str


class ClaimReview(Model):
    verdict: Literal["accept", "reject", "dispute"]
    note: str = Field(default="", max_length=2000)


class EnrichmentCreate(Model):
    kinds: list[EnrichmentKind] = Field(min_length=1, max_length=3)
    node_ids: list[str] | None = Field(default=None, max_length=150)

    @model_validator(mode="after")
    def unique_kinds(self):
        if len(set(self.kinds)) != len(self.kinds):
            raise ValueError("Enrichment kinds must be unique")
        return self


class EnrichmentResult(Model):
    node_id: str
    kind: EnrichmentKind
    outcome: Literal["filled", "unresolved", "skipped"]
    reason: str | None = None


class Enrichment(Model):
    id: str
    graph_id: str
    kinds: list[EnrichmentKind]
    status: Literal["queued", "running", "completed", "partial", "failed"]
    progress: dict[str, int]
    results: list[EnrichmentResult]
    revision_after: int | None = None
    events_url: str
    created_at: str


class ProductionShares(ConcentrationLayer):
    material_node_id: str
    unit: str


class GeoFeatureCollection(Model):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    graph_id: str
    revision: int
    features: list[dict[str, Any]]


class Commodity(Model):
    commodity: str
    years: list[int]
    stages: list[Stage]


class CommodityList(Model):
    items: list[Commodity]


class BOMItem(Model):
    node_id: str
    name: str
    kind: NodeKind
    tier: int
    parent_node_id: str
    edge_id: str
    quantity: float | None = None
    unit: str | None = None
    quantity_support_label: Support | None = None
    support_label: Support
    scope: Scope
    claim_ids: list[str]
    evidence: list[Evidence]


class BOM(Model):
    run_id: str
    graph_id: str
    revision: int
    product: str
    status: RunStatus
    mode: Literal["live", "replay", "followup"]
    provider: str
    items: list[BOMItem]
    open_questions: list[str]
    method: Method
    data_quality: DataQuality


class Page[T](Model):
    items: list[T]
    next_cursor: str | None


# ---------------- BOM estimate (text/link/photo → labelled bill of materials)
BomCategory = Literal[
    "component", "subassembly", "material", "packaging", "consumable", "software", "other"
]
Basis = Literal["evidenced", "inferred", "guessed"]
Confidence = Literal["high", "medium", "low"]
ImageMediaType = Literal["image/jpeg", "image/png", "image/webp", "image/gif"]


class BomEstimateLimits(Model):
    max_searches: int = Field(default=5, ge=0, le=20)
    max_documents: int = Field(default=6, ge=0, le=20)
    max_items: int = Field(default=60, ge=1, le=200)
    max_seconds: int = Field(default=180, ge=1, le=600)
    max_input_tokens: int = Field(default=400000, ge=1000, le=2000000)
    max_output_tokens: int = Field(default=60000, ge=500, le=200000)


class InlineImage(Model):
    data: str = Field(min_length=1, max_length=7_000_000)
    media_type: ImageMediaType


class BomEstimateRequest(Model):
    description: str | None = Field(default=None, min_length=1, max_length=4000)
    url: str | None = Field(default=None, min_length=1, max_length=2000)
    image: InlineImage | None = None
    image_url: str | None = Field(default=None, min_length=1, max_length=2000)
    company: Name | None = None
    limits: BomEstimateLimits = Field(default_factory=BomEstimateLimits)

    @model_validator(mode="after")
    def at_least_one_input(self):
        if not (self.description or self.url or self.image or self.image_url):
            raise ValueError("Provide at least one of description, url, image, or image_url")
        return self


class WebPageRef(Model):
    type: Literal["web_page"]
    source_id: str
    url: str
    title: str | None = None
    quote: str
    locator: str


class WebPageUnverifiedRef(Model):
    type: Literal["web_page_unverified"]
    source_id: str
    url: str
    title: str | None = None
    claimed_quote: str
    note: str


class SearchSnippetRef(Model):
    type: Literal["search_snippet"]
    url: str
    title: str
    snippet: str
    query: str


class ImageAnalysisRef(Model):
    type: Literal["image_analysis"]
    source_id: str
    note: str


class UserInputRef(Model):
    type: Literal["user_input"]
    field: Literal["description", "url", "image_url", "company"]
    note: str


class ModelKnowledgeRef(Model):
    type: Literal["model_knowledge"]
    note: str


BomSourceRef = Annotated[
    WebPageRef
    | WebPageUnverifiedRef
    | SearchSnippetRef
    | ImageAnalysisRef
    | UserInputRef
    | ModelKnowledgeRef,
    Field(discriminator="type"),
]


class BomEstimateItem(Model):
    """`sources` records where the agent got the item; `manufacturer` is the part maker."""

    id: str
    name: str
    category: BomCategory
    quantity: float | None = None
    unit: str | None = None
    material: str | None = None
    manufacturer: str | None = None
    part_number: str | None = None
    parent_item_id: str | None = None
    notes: str | None = None
    basis: Basis
    confidence: Confidence
    sources: list[BomSourceRef]


class BomEstimateEvidence(Model):
    id: str
    origin: str
    name: str | None = None
    category: BomCategory | None = None
    quantity: float | None = None
    unit: str | None = None
    material: str | None = None
    manufacturer: str | None = None
    part_number: str | None = None
    notes: str | None = None
    url: str | None = None
    title: str | None = None
    quote: str | None = None
    ref: BomSourceRef


class BomEstimateProduct(Model):
    name: str | None = None
    brand: str | None = None
    category: str | None = None
    identifiers: list[str] = Field(default_factory=list)
    summary: str | None = None
    identified_from: list[str] = Field(default_factory=list)
    ambiguity: str | None = None


class BomEstimateImage(Model):
    media_type: ImageMediaType
    bytes: int
    sha256: str


class BomEstimateInputs(Model):
    description: str | None = None
    url: str | None = None
    image: BomEstimateImage | None = None
    image_url: str | None = None
    company: str | None = None


class BomEstimateUsage(Model):
    searches: int = 0
    documents: int = 0
    model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    elapsed_seconds: float = 0
    binding_limit: str | None = None
    cost_minor: int | None = None
    currency: str = "USD"


class BomEstimate(Model):
    id: str
    status: Literal["running", "completed", "partial", "failed", "cancelled"]
    mode: Literal["live"] = "live"
    provider: str
    stop_reason: str | None = None
    product: BomEstimateProduct
    inputs: BomEstimateInputs
    items: list[BomEstimateItem]
    evidence: list[BomEstimateEvidence]
    sources: list[Source]
    open_questions: list[str]
    usage: BomEstimateUsage
    limits: BomEstimateLimits
    disclaimer: str
    created_at: str
    completed_at: str | None = None


# ---------------- BOM estimate import into a research run
class Lenient(BaseModel):
    """Import contract for a persisted estimate: extra snapshot fields are kept, never trusted."""

    model_config = ConfigDict(extra="allow", allow_inf_nan=False)


class ImportedBomItem(Lenient):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    category: BomCategory
    quantity: float | None = None
    unit: str | None = Field(default=None, max_length=40)
    material: str | None = Field(default=None, max_length=100)
    manufacturer: str | None = Field(default=None, max_length=100)
    part_number: str | None = Field(default=None, max_length=100)
    parent_item_id: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=300)
    basis: Basis
    confidence: Confidence
    sources: list[BomSourceRef] = Field(default_factory=list, max_length=100)


class ImportedBomProduct(Lenient):
    name: str = Field(min_length=1, max_length=200)
    brand: str | None = Field(default=None, max_length=100)


class ImportedBomSource(Lenient):
    id: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2000)


class BomEstimateImport(Lenient):
    id: str = Field(min_length=1, max_length=200)
    status: Literal["completed", "partial"]
    product: ImportedBomProduct
    items: list[ImportedBomItem] = Field(max_length=200)
    sources: list[ImportedBomSource] = Field(max_length=100)

    @model_validator(mode="after")
    def consistent_references(self):
        items = {item.id: item for item in self.items}
        if len(items) != len(self.items):
            raise ValueError("Duplicate BOM item IDs")
        sources = {source.id for source in self.sources}
        if len(sources) != len(self.sources):
            raise ValueError("Duplicate BOM source IDs")
        for item in self.items:
            seen, parent = {item.id}, item.parent_item_id
            while parent:
                if parent not in items or parent in seen:
                    raise ValueError(
                        f"BOM item {item.id}: parent must reference another item without cycles"
                    )
                seen.add(parent)
                parent = items[parent].parent_item_id
            for ref in item.sources:
                if getattr(ref, "source_id", None) and ref.source_id not in sources:
                    raise ValueError(f"BOM item {item.id}: citation references a missing source")
        return self


RunCreate.model_rebuild()
Edge.model_rebuild()


class FollowupCreate(Model):
    """Deepen or refine an existing graph with a natural-language instruction. Research runs
    with the same evidence rules; the instruction only steers planning and extraction."""

    instruction: str = Field(min_length=3, max_length=1000)
    # Nodes to research; the product root when omitted. New nodes found under them are
    # researched too, within the hop limit.
    target_node_ids: list[str] | None = Field(default=None, max_length=50)
    limits: RunLimits = Field(default_factory=RunLimits)


class ScenarioCreate(Model):
    name: str | None = Field(default=None, max_length=200)


class EditCreate(Model):
    """A hypothetical change to a scenario graph, in natural language. Never applied to a
    base graph; the instruction is the provenance of what it adds."""

    instruction: str = Field(min_length=3, max_length=1000)


class EditResult(Model):
    edit_id: str
    graph_id: str
    revision: int
    applied: list[dict[str, Any]]
    skipped: list[dict[str, Any]]
