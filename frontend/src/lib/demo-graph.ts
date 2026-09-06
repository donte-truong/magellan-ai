/** Adapter from a generated research graph (public/assets/data/<slug>/) to the demo's records.
 *
 * The site records keep the curated Supplier shape so the globe, list, and inspector work
 * unchanged; extra fields carry what the research adds: whether a pin is a plant or an office,
 * the place's precision, shares with their basis, and the claims and sources behind each pin.
 */
import type { PartId, Supplier } from "./demo-data";
import { parts as curatedParts } from "./demo-data";
import { api } from "./api";
import type { Graph, Site, SiteMake, Sites } from "./types";

export const DEMO_SLUG = "iphone-17-pro";
export const DEMO_DATA_PATH = `/assets/data/${DEMO_SLUG}`;

export interface DemoSite extends Supplier {
  role: "plant" | "organization";
  precision: Site["precision"];
  kind: PartId | "other";
  shareBasis: SiteMake["share_basis"];
  share: number | null;
  sources: string[];
  makes: {
    label: string;
    predicate: string;
    share: number | null;
    basis: SiteMake["share_basis"];
  }[];
  operators: string[];
}

export interface DemoGraphSummary {
  graphId: string;
  product: string | null;
  nodes: number;
  edges: number;
  sites: number;
  organizations: number;
  plants: number;
  countries: number;
  connections: number;
  runs: number;
  generatedAt: string | null;
}

export interface DemoGraphIndex {
  graph_id: string;
  product: string | null;
  generated_at?: string;
  stats?: { node_count?: number; edge_count?: number; max_tier?: number };
  sites?: number;
  runs?: {
    id: string;
    mode: string;
    instruction?: string | null;
    usage?: Record<string, unknown>;
  }[];
  files?: string[];
}

const ASSEMBLY_KEYWORDS: [PartId, RegExp][] = [
  ["display", /display|oled|ceramic shield|screen|panel|glass front|cover glass/i],
  ["camera", /camera|lens|sensor|imx|lidar|image|flash/i],
  ["battery", /battery|cell|cobalt|lithium|graphite|cathode|anode|charging/i],
  [
    "enclosure",
    /enclosure|unibody|aluminum|aluminium|titanium|frame|housing|back glass|vapor chamber|chassis/i,
  ],
  [
    "connectivity",
    /modem|wireless|wi-?fi|bluetooth|nfc|antenna|rf |front[- ]end|transceiver|ultra wideband|uwb|n1\b|snapdragon|skyworks|qorvo|broadcom/i,
  ],
  [
    "silicon",
    /a19|soc|chip|processor|logic board|memory|nand|dram|lpddr|storage|wafer|die|foundry|semiconductor|silicon|power management|pmic|ic\b/i,
  ],
];

export function assemblyFor(text: string): PartId | "other" {
  for (const [id, pattern] of ASSEMBLY_KEYWORDS) if (pattern.test(text)) return id;
  return "other";
}

const colors: Record<PartId | "other", string> = Object.fromEntries([
  ...curatedParts.map((p) => [p.id, p.color]),
  ["other", "#c9d2e0"],
]) as Record<PartId | "other", string>;

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string) {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const PRECISION_TEXT: Record<Site["precision"], string> = {
  address: "Address stated in the source",
  city: "City centre from the reference gazetteer",
  region: "Region centre from the reference gazetteer",
  country: "Country centre from the reference gazetteer",
};

/** A short place name: the city part of an address, never a street line or a duplicate region. */
export function shortPlace(site: Site): { city: string; region: string | null } {
  const parts = (site.city ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const country = countryName(site.country_iso2).toLowerCase();
  const candidates = parts.filter(
    (p) => !/^\d/.test(p) && !/\d{4,}/.test(p) && p.toLowerCase() !== country && p.length < 40,
  );
  let city = candidates[0] ?? site.admin1 ?? countryName(site.country_iso2);
  if (site.precision === "address" && candidates.length > 1) {
    // "5509 N.W. Parker Street, Camas, WA 98607" -> the segment before the state or postcode.
    city =
      candidates[candidates.length - 1].length <= 3
        ? candidates[candidates.length - 2]
        : candidates[candidates.length - 1];
    const street = candidates.find((p) =>
      /street|road|avenue|drive|blvd|hwy|highway|circle|lane|way/i.test(p),
    );
    if (street && city === street) city = candidates[1] ?? city;
  }
  const region =
    site.admin1 && site.admin1.toLowerCase() !== city.toLowerCase() ? site.admin1 : null;
  return { city, region };
}

function describe(site: Site): string {
  const what = site.makes.slice(0, 3).map((m) => {
    const verb =
      m.predicate === "MANUFACTURES"
        ? "manufactures"
        : m.predicate === "PRODUCES"
          ? "produces"
          : m.predicate === "SUPPLIES"
            ? "supplies"
            : m.predicate.toLowerCase();
    const share =
      m.share === null
        ? ""
        : m.share_basis === "stated"
          ? ` (${Math.round(m.share * 100)}% stated)`
          : ` (~${Math.round(m.share * 100)}%, prior)`;
    return `${verb} ${m.label}${share}`;
  });
  const role = site.role === "plant" ? "Plant" : "Company office";
  const place = shortPlace(site);
  const where = [place.city, place.region, countryName(site.country_iso2)]
    .filter(Boolean)
    .join(", ");
  const does = what.length
    ? `It ${what.join("; ")}.`
    : site.operators.length
      ? `Operated by ${site.operators.map((o) => o.label).join(", ")}; no relation to a part is verified yet.`
      : "Located; no relation to a part is verified yet.";
  return `${role} in ${where}. ${does} ${PRECISION_TEXT[site.precision]}.`;
}

/** Build supplier records: the product's own company first (the globe's arc anchor), then
 * plants before offices, each coloured by the assembly its work belongs to. */
export function sitesToSuppliers(sites: Sites, anchor: Supplier): DemoSite[] {
  const records: DemoSite[] = [];
  const ordered = [...sites.sites].sort((a, b) =>
    a.role === b.role ? a.label.localeCompare(b.label) : a.role === "plant" ? -1 : 1,
  );
  for (const site of ordered) {
    if (site.label.toLowerCase() === anchor.name.toLowerCase()) continue;
    // A pin needs something verified behind it: a relation to a part, or a known operator.
    if (!site.makes.length && !site.operators.length) continue;
    const place = shortPlace(site);
    const primary = site.makes[0];
    const text = `${site.label} ${site.makes.map((m) => m.label).join(" ")}`;
    const kind = assemblyFor(text);
    records.push({
      id: site.node_id,
      name: site.label,
      component: primary
        ? primary.label
        : site.operators[0]?.label
          ? `Operated by ${site.operators[0].label}`
          : "Located site",
      category: site.role === "plant" ? "Plant" : "Company",
      country: countryName(site.country_iso2),
      code: site.country_iso2,
      city: place.region ? `${place.city}, ${place.region}` : place.city,
      lat: site.lat,
      lon: site.lon,
      color: colors[kind],
      source: primary?.sources[0] ?? site.location_sources[0] ?? "",
      locationSource: site.location_sources[0] ?? "",
      detail: describe(site),
      role: site.role,
      precision: site.precision,
      kind,
      share: primary?.share ?? null,
      shareBasis: primary?.share_basis ?? null,
      sources: Array.from(
        new Set([...site.location_sources, ...site.makes.flatMap((m) => m.sources)]),
      ),
      makes: site.makes.map((m) => ({
        label: m.label,
        predicate: m.predicate,
        share: m.share,
        basis: m.share_basis,
      })),
      operators: site.operators.map((o) => o.label),
    });
  }
  return [
    {
      ...anchor,
      role: "organization",
      precision: "city",
      kind: "silicon",
      share: null,
      shareBasis: null,
      sources: [anchor.locationSource],
      makes: [],
      operators: [],
    },
    ...records,
  ];
}

export function summarize(
  index: DemoGraphIndex,
  sites: Sites,
  suppliers: DemoSite[],
): DemoGraphSummary {
  // Counts describe the pins shown (the anchor excluded), not every located node.
  const shown = suppliers.slice(1);
  return {
    graphId: index.graph_id,
    product: index.product,
    nodes: index.stats?.node_count ?? 0,
    edges: index.stats?.edge_count ?? 0,
    sites: shown.length,
    organizations: shown.filter((s) => s.role === "organization").length,
    plants: shown.filter((s) => s.role === "plant").length,
    countries: new Set(suppliers.map((s) => s.code)).size,
    connections: shown.reduce((n, s) => n + s.makes.length, 0),
    runs: index.runs?.length ?? 0,
    generatedAt: index.generated_at ?? null,
  };
}

let cache: Promise<{ index: DemoGraphIndex; sites: Sites } | null> | null = null;

/** Fetch the exported index and sites lazily (once per page load); null when unavailable. */
export function loadDemoGraph() {
  cache ??= (async () => {
    try {
      const [index, sites] = await Promise.all([
        fetch(`${DEMO_DATA_PATH}/index.json`).then((r) =>
          r.ok ? (r.json() as Promise<DemoGraphIndex>) : null,
        ),
        fetch(`${DEMO_DATA_PATH}/sites.json`).then((r) =>
          r.ok ? (r.json() as Promise<Sites>) : null,
        ),
      ]);
      if (!index || !sites) return null;
      return { index, sites };
    } catch {
      cache = null; // a transient failure may be retried on the next mount
      return null;
    }
  })();
  return cache;
}

let fullGraph: Promise<Graph | null> | null = null;

/** The full graph export (nodes, edges, claims), fetched once for the graph view. */
export function loadFullDemoGraph() {
  fullGraph ??= fetch(`${DEMO_DATA_PATH}/graph.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Graph>) : null))
    .catch(() => {
      fullGraph = null;
      return null;
    });
  return fullGraph;
}

export async function downloadDemoGraph() {
  const response = await fetch(`${DEMO_DATA_PATH}/graph.json`);
  if (!response.ok) throw new Error("graph export unavailable");
  return response.blob();
}

/** Re-read a graph and its sites from the local backend (after live research or an edit). */
export async function refreshLive(graphId: string, anchor: Supplier, index: DemoGraphIndex) {
  const [graph, sites] = await Promise.all([api.graph(graphId), api.sites(graphId)]);
  const records = sitesToSuppliers(sites, anchor);
  const summary = summarize({ ...index, graph_id: graphId, stats: graph.stats }, sites, records);
  return { graph, sites, records, summary };
}
