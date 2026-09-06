import { describe, expect, it } from "vitest";
import { suppliers as curated } from "@/lib/demo-data";
import { assemblyFor, sitesToSuppliers, summarize } from "@/lib/demo-graph";
import type { Sites } from "@/lib/types";

const sites: Sites = {
  sites: [
    {
      node_id: "n_corning",
      kind: "organization",
      role: "organization",
      label: "Corning",
      country_iso2: "US",
      admin1: "New York",
      city: "Corning",
      lat: 42.14,
      lon: -77.05,
      precision: "city",
      geocoding: { method: "gazetteer_v1", precision: "city" },
      location_claim_ids: ["c1"],
      location_sources: ["https://example.org/corning"],
      operators: [],
      makes: [
        {
          node_id: "n_shield",
          label: "Ceramic Shield 2",
          kind: "component",
          predicate: "MANUFACTURES",
          scope: "generic",
          share: 0.5,
          share_basis: "uniform_prior",
          claim_ids: ["c2"],
          sources: ["https://example.org/shield"],
        },
      ],
    },
    {
      node_id: "n_harrodsburg",
      kind: "facility",
      role: "plant",
      label: "Corning Harrodsburg facility",
      country_iso2: "US",
      admin1: "Kentucky",
      city: "Harrodsburg",
      lat: 37.76,
      lon: -84.84,
      precision: "city",
      geocoding: { method: "gazetteer_v1", precision: "city" },
      location_claim_ids: ["c3"],
      location_sources: ["https://example.org/plant"],
      operators: [{ node_id: "n_corning", label: "Corning" }],
      makes: [
        {
          node_id: "n_shield",
          label: "Ceramic Shield 2",
          kind: "component",
          predicate: "MANUFACTURES",
          scope: "generic",
          share: 0.3,
          share_basis: "stated",
          claim_ids: ["c4"],
          sources: ["https://example.org/plant"],
        },
      ],
    },
    {
      node_id: "n_apple",
      kind: "organization",
      role: "organization",
      label: "Apple",
      country_iso2: "US",
      admin1: "California",
      city: "Cupertino",
      lat: 37.32,
      lon: -122.03,
      precision: "city",
      geocoding: null,
      location_claim_ids: [],
      location_sources: [],
      operators: [],
      makes: [],
    },
  ],
  distributions: [],
};

describe("demo graph adapter", () => {
  it("keeps the product company as the first record and puts plants before offices", () => {
    const records = sitesToSuppliers(sites, curated[0]);
    expect(records[0].id).toBe("apple"); // the curated anchor, not the graph's Apple node
    expect(records.map((r) => r.name)).toEqual([
      "Apple",
      "Corning Harrodsburg facility",
      "Corning",
    ]);
    const plant = records[1];
    expect(plant.role).toBe("plant");
    expect(plant.code).toBe("US");
    expect(plant.city).toBe("Harrodsburg, Kentucky");
    expect(plant.country).toBe("United States");
    expect(plant.kind).toBe("display"); // Ceramic Shield colours as the display assembly
    expect(plant.share).toBe(0.3);
    expect(plant.shareBasis).toBe("stated");
    expect(plant.detail).toContain("30% stated");
    expect(plant.detail).toContain(
      "Plant in Harrodsburg, Kentucky, United States. It manufactures",
    );
    expect(plant.detail).toContain("City centre from the reference gazetteer");
    expect(plant.sources).toEqual(["https://example.org/plant"]);
    expect(records[2].detail).toContain("~50%, prior");
  });

  it("classifies sites into the six assemblies by what they make", () => {
    expect(assemblyFor("TSMC A19 Pro")).toBe("silicon");
    expect(assemblyFor("Sony IMX903 sensor")).toBe("camera");
    expect(assemblyFor("Simplo battery cell")).toBe("battery");
    expect(assemblyFor("Qualcomm modem")).toBe("connectivity");
    expect(assemblyFor("aluminum unibody")).toBe("enclosure");
    expect(assemblyFor("nothing known")).toBe("other");
  });

  it("summarizes the export for the counts panel", () => {
    const records = sitesToSuppliers(sites, curated[0]);
    const summary = summarize(
      {
        graph_id: "g1",
        product: "iPhone 17 Pro",
        stats: { node_count: 160, edge_count: 210 },
        runs: [{ id: "r1", mode: "live" }],
      },
      sites,
      records,
    );
    expect(summary).toMatchObject({
      nodes: 160,
      edges: 210,
      sites: 3,
      plants: 1,
      organizations: 2,
      connections: 2,
      countries: 1,
      runs: 1,
    });
  });
});
