import { describe, expect, it } from "vitest";
import { layoutGraph } from "@/lib/graph-layout";
import { graph } from "./fixtures";

describe("force-directed network", () => {
  it("is deterministic and leaves evidence and directed relationships intact", () => {
    const before = JSON.stringify(graph);
    expect(layoutGraph(graph)).toEqual(layoutGraph(graph));
    expect(JSON.stringify(graph)).toBe(before);
    const edge = layoutGraph(graph).edges[0];
    expect([edge.source, edge.target]).toEqual([
      graph.edges[0].source_node_id,
      graph.edges[0].target_node_id,
    ]);
  });
  it("places disconnected and dense graphs at finite, distinct positions", () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      ...graph.nodes[i ? 1 : 0],
      id: `node_${i}`,
    }));
    const edges = nodes.slice(1, 40).map((node, i) => ({
      ...graph.edges[0],
      id: `edge_${i}`,
      source_node_id: node.id,
      target_node_id: nodes[Math.floor(i / 3)].id,
    }));
    const result = layoutGraph({ ...graph, root_node_id: nodes[0].id, nodes, edges });
    expect(result.nodes).toHaveLength(60);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
    const distinct = new Set(
      result.nodes.map((node) => `${node.position.x.toFixed(1)}:${node.position.y.toFixed(1)}`),
    );
    expect(distinct.size).toBe(60);
    expect(result.edges).toHaveLength(39);
  });
  it("supports an empty graph and ignores dangling visual connections", () => {
    expect(layoutGraph({ ...graph, nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
    expect(
      layoutGraph({ ...graph, edges: [{ ...graph.edges[0], source_node_id: "missing" }] }).edges,
    ).toHaveLength(0);
  });
});
