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
    mode: Literal["live", "replay"] = "live"
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
    max_searches: int = Field(default=25, ge=0, le=60)
    max_documents: int = Field(default=40, ge=0, le=100)
    max_input_tokens: int = Field(default=400000, ge=0, le=2000000)
    max_output_tokens: int = Field(default=30000, ge=0, le=200000)
    max_seconds: int = Field(default=480, ge=1, le=900)


class RunCreate(Model):
    product: Name
    company: Name | None = None
    upload_id: str | None = None
    limits: RunLimits = Field(default_factory=RunLimits)
    replay_of_run_id: str | None = None


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
    mode: Literal["live", "replay"]
    product: str
    company: str | None = None
    upload_id: str | None = None
    graph_id: str
    limits: RunLimits
    usage: RunUsage
    progress: dict[str, int]
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
    mode: Literal["live", "replay"]
    provider: str
    items: list[BOMItem]
    open_questions: list[str]
    method: Method
    data_quality: DataQuality


class Page[T](Model):
    items: list[T]
    next_cursor: str | None
